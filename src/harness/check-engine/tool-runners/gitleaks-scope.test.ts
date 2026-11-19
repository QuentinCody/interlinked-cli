import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { collectGitleaksScope, gitleaksConfiguration } from "./gitleaks-scope.js";

let root: string;
function put(file: string, text = "harmless input\n"): void {
	mkdirSync(join(root, file, ".."), { recursive: true });
	writeFileSync(join(root, file), text);
}
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch/gitleaks-scope-test-"));
	vi.stubEnv("GITLEAKS_CONFIG", ""); vi.stubEnv("GITLEAKS_CONFIG_TOML", "");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("retains ignored working inputs, tracked exceptions and safe directory groups", async () => {
	execFileSync("git", ["init", "--quiet", root]);
	put(".gitignore", ".env\nnode_modules\ndist\n");
	put(".env"); put("untracked.txt"); put("src/a.ts"); put("src/ leading\nname.ts");
	put("dist/config.json"); put("dist/old.js"); put("node_modules/package/source.js");
	put(".interlinked/agent-output/old.heapsnapshot"); put(".archive/history.bundle");
	put(".claude/settings.local.json"); put(".claude/worktrees/old/source.txt"); put(".codex/worktrees/old/source.txt");
	execFileSync("git", ["-C", root, "add", "--force", "dist/config.json"]);
	const scope = await collectGitleaksScope(root, () => 0);
	expect(scope.files).toEqual(expect.arrayContaining([".env", "untracked.txt", "src/a.ts", "src/ leading\nname.ts", "dist/config.json"]));
	expect(scope.files).not.toContain("dist/old.js");
	expect(scope.files).toContain(".claude/settings.local.json");
	expect(scope.files).not.toContain(".claude/worktrees/old/source.txt");
	expect(scope.excluded).toContain(".claude/worktrees");
	expect(scope.excluded).toContain(".codex/worktrees");
	expect(scope.targets).toContain("src");
	expect(scope.targets).toContain("dist/config.json");
	expect(scope.targets).not.toContain("dist");
	expect(scope.excluded).toEqual(expect.arrayContaining([".git", "node_modules", ".archive", ".interlinked", "dist"]));
	expect(scope.excluded).not.toContain("dist/old.js");
	expect(scope.unavailable).toEqual([]);
});

it("excludes untracked dependency links and retains evidence gaps for tracked inputs", async () => {
	execFileSync("git", ["init", "--quiet", root]);
	put("node_modules/pkg/index.js");
	put("replaced/node_modules/tracked.js");
	put("sandbox/.env");
	mkdirSync(join(root, "tracked"));
	symlinkSync("../node_modules", join(root, "sandbox/node_modules"));
	symlinkSync("../node_modules", join(root, "tracked/node_modules"));
	execFileSync("git", ["-C", root, "add", "--force", "tracked/node_modules", "replaced/node_modules/tracked.js"]);
	rmSync(join(root, "replaced/node_modules"), { recursive: true });
	symlinkSync("../node_modules", join(root, "replaced/node_modules"));

	const scope = await collectGitleaksScope(root, () => 0);
	expect(scope.excluded).toContain("sandbox/node_modules");
	expect(scope.files).toEqual(["sandbox/.env"]);
	expect(scope.targets).toEqual(["sandbox/.env"]);
	expect(scope.unavailable.map(input => input.file)).toEqual(["replaced/node_modules", "tracked/node_modules"]);
});

it("records symlinks as unsupported and never follows them", async () => {
	put("source.txt"); symlinkSync("source.txt", join(root, "alias.txt"));
	const scope = await collectGitleaksScope(root, () => 0);
	expect(scope.files).toEqual(["source.txt"]);
	expect(scope.unavailable).toEqual([{ file: "alias.txt", reason: expect.stringContaining("symbolic") }]);
	expect(scope.targets).not.toContain(".");
});

it("explicit Git-visible scope omits ignored inputs and prevents ignored descendants entering directory targets", async () => {
	execFileSync("git", ["init", "--quiet", root]);
	put(".gitignore", ".env\n*.ignored\n"); put(".env"); put("src/public.txt"); put("src/private.ignored");
	const scope = await collectGitleaksScope(root, () => 0, "git-visible");
	expect(scope.files).toEqual([".gitignore", "src/public.txt"]);
	expect(scope.targets).toContain("src/public.txt");
	expect(scope.targets).not.toContain("src");
	expect(scope.excluded).toContain("<git-ignored>");
});

it("explicit Git-visible scope retains tracked files even when ignore patterns match", async () => {
	execFileSync("git", ["init", "--quiet", root]); put(".gitignore", ".env\n"); put(".env");
	execFileSync("git", ["-C", root, "add", "--force", ".env"]);
	expect((await collectGitleaksScope(root, () => 0, "git-visible")).files).toContain(".env");
});

it("reports Git inventory failure before scanning an untrustworthy tracked scope", async () => {
	put(".git", "gitdir: missing\n"); put("source.txt");
	await expect(collectGitleaksScope(root, () => 0)).rejects.toThrow("Git");
});

it("pins root configuration while preserving native environment precedence", () => {
	put(".gitleaks.toml", 'title="root"\n');
	expect(gitleaksConfiguration(root).args).toEqual(["--config", join(root, ".gitleaks.toml")]);
	vi.stubEnv("GITLEAKS_CONFIG_TOML", 'title="inline"\n');
	expect(gitleaksConfiguration(root).args).toEqual([]);
	expect(gitleaksConfiguration(root).env.GITLEAKS_CONFIG_TOML).toBe('title="inline"\n');
	vi.stubEnv("GITLEAKS_CONFIG", "operator.toml");
	expect(gitleaksConfiguration(root).args).toEqual(["--config", join(root, "operator.toml")]);
});

it("pins embedded defaults without creating a configuration file", () => {
	const configuration = gitleaksConfiguration(root);
	expect(configuration.args).toEqual([]);
	expect(configuration.env.GITLEAKS_CONFIG_TOML).toBe("[extend]\nuseDefault=true\n");
});

it("binds Git inventory to the selected root without inherited repository selectors or fsmonitor hooks", async () => {
	execFileSync("git", ["init", "--quiet", root]); put("source.txt");
	vi.stubEnv("GIT_DIR", join(root, "missing")); vi.stubEnv("GIT_WORK_TREE", "/missing");
	vi.stubEnv("GIT_INDEX_FILE", join(root, "missing-index")); vi.stubEnv("GIT_COMMON_DIR", join(root, "missing-common"));
	expect((await collectGitleaksScope(root, () => 0, "git-visible")).files).toEqual(["source.txt"]);
});

it("preserves operator Go concurrency and leaves omitted concurrency at Go's default", () => {
	vi.stubEnv("GOMAXPROCS", "7");
	expect(gitleaksConfiguration(root).env.GOMAXPROCS).toBe("7");
	vi.stubEnv("GOMAXPROCS", undefined);
	expect(gitleaksConfiguration(root).env.GOMAXPROCS).toBeUndefined();
});
