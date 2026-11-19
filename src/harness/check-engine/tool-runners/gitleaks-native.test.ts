import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckEngine } from "../index.js";
import { streamExternalTools } from "../../../commands/verify/verify-tools.js";
import { runGitleaksForeground } from "./gitleaks-foreground.js";

vi.mock("../../../commands/verify/check-timing.js", () => ({ measureVerifyCheckAsync: async (_id: string, work: () => Promise<unknown>) => work(), recordVerifyInputDeferral: vi.fn(), recordVerifyInputExclusion: vi.fn() }));
const installed = spawnSync("gitleaks", ["version"], { encoding: "utf8" }).status === 0;
let root: string;
const marker = "AUDIT_SCOPE_MARKER_HARMLESS\n";
const rule = '[[rules]]\nid="audit-marker"\nregex=\'AUDIT_SCOPE_MARKER_[A-Z]+\'\n';
function put(file: string, contents = marker): void {
	mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), contents);
}
beforeEach(() => {
	root = mkdtempSync(join(process.cwd(), "scratch/gitleaks-native-"));
	vi.stubEnv("GITLEAKS_CONFIG", ""); vi.stubEnv("GITLEAKS_CONFIG_TOML", "");
	put(".gitleaks.toml", rule);
	vi.spyOn(process.stderr, "write").mockReturnValue(true); process.exitCode = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!installed)("native foreground Gitleaks working inputs", () => {
	it("checks ignored .env and tracked exceptions while excluding generated and historical data", async () => {
		execFileSync("git", ["init", "--quiet", root]);
		put(".gitignore", ".env\ndist\n"); put(".env"); put("src/ leading\nname.txt"); put("untracked.txt"); put("-dash.txt");
		put("dist/config.json"); put("dist/history.txt"); put(".interlinked/agent-output/old.heapsnapshot"); put(".archive/history.bundle");
		execFileSync("git", ["-C", root, "add", "--force", "dist/config.json"]);
		const results = await runGitleaksForeground(root, 0);
		expect(results.map(row => row.file).sort()).toEqual(["-dash.txt", ".env", "dist/config.json", "src/ leading\nname.txt", "untracked.txt"]);
	});
	it("preserves root policy and two relative inheritance levels for nested targets", async () => {
		put(".gitleaks.toml", '[extend]\npath="middle.toml"\n');
		put("middle.toml", '[extend]\npath="leaf.toml"\n'); put("leaf.toml", rule);
		put("src/source.txt"); put("src/.gitleaks.toml", 'title="nested zero-rule policy"\n');
		expect((await runGitleaksForeground(root, 0)).map(row => row.file)).toEqual(["src/source.txt"]);
	});
	it.each(["file", "inline"])("preserves operator %s configuration precedence", async mode => {
		put("operator.toml", rule + '[[allowlists]]\npaths=[\'allowed.txt$\']\n');
		put("allowed.txt"); put("visible.txt");
		if (mode === "file") vi.stubEnv("GITLEAKS_CONFIG", "operator.toml");
		else vi.stubEnv("GITLEAKS_CONFIG_TOML", readFileSync(join(root, "operator.toml"), "utf8"));
		expect((await runGitleaksForeground(root, 0)).map(row => row.file)).toEqual(["visible.txt"]);
	});
	it("preserves root-relative fingerprint ignores across directory frontier targets", async () => {
		put("src/source.txt"); put(".gitleaksignore", "src/source.txt:audit-marker:1\n");
		expect(await runGitleaksForeground(root, 0)).toEqual([]);
	});
	it("makes Git-visible omission of ignored .env an explicit scope choice", async () => {
		execFileSync("git", ["init", "--quiet", root]); put(".gitignore", ".env\n*.ignored\n");
		put(".env"); put("src/public.txt"); put("src/private.ignored");
		const scopes: import("../types.js").ToolInputScope[] = [];
		expect((await runGitleaksForeground(root, 0)).map(row => row.file).sort()).toEqual([".env", "src/private.ignored", "src/public.txt"]);
		expect((await runGitleaksForeground(root, 0, scope => scopes.push(scope), "git-visible")).map(row => row.file)).toEqual(["src/public.txt"]);
		expect(scopes).toMatchObject([{ excludedInputs: expect.arrayContaining([{ file: "<git-ignored>", reason: expect.stringContaining(".env") }]) }]);
	});
	it("retains native path-only embedded findings with line zero", async () => {
		rmSync(join(root, ".gitleaks.toml")); put("audit.p12", "Harmless path-only detection control.\n");
		expect(await runGitleaksForeground(root, 0)).toMatchObject([{ file: "audit.p12", ruleId: "pkcs12-file", line: 0 }]);
	});
	it("uses the repository's tightened default policy", async () => {
		rmSync(join(root, ".gitleaks.toml")); put("audit.p12", "Harmless path-only detection control.\n");
		vi.stubEnv("GITLEAKS_CONFIG", join(process.cwd(), ".gitleaks.toml"));
		expect(await runGitleaksForeground(root, 0)).toMatchObject([{ ruleId: "pkcs12-file" }]);
	});
	it("shares the scoped runner through the engine and human command paths", async () => {
		put(".env"); put(".archive/history.bundle");
		const engine = new CheckEngine(root);
		vi.spyOn(engine, "discoverTools").mockReturnValue([{ id: "gitleaks", available: true }]);
		const scopes: import("../types.js").ToolInputScope[] = [];
		const report = await engine.runChecksAsync({ projectRoot: root, mode: "project" }, { tools: ["gitleaks"], admissionAlreadyHeld: true, resourcePolicy: "foreground-verify", onInputScope: scope => scopes.push(scope) });
		expect(report.results.map(row => row.file)).toEqual([".env"]); expect(report.skipped).toEqual([]);
		expect(scopes).toMatchObject([{ tool: "gitleaks", selectedFiles: 2, excludedInputs: [{ file: ".archive" }] }]);
		const flagged = new Set<string>();
		await streamExternalTools({ engine, cwd: root, opts: { only: "gitleaks" }, skipChecks: new Set(), summary: [], allFlaggedFiles: flagged, details: false });
		expect(flagged).toEqual(new Set([".env"])); expect(process.exitCode).toBe(0);
		expect(vi.mocked(process.stderr.write).mock.calls.map(([text]) => text).join("")).toContain(".archive");
	});
});
