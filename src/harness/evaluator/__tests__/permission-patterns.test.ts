import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addPermissionToSettings, extractPermissionPattern } from "../permission-patterns.js";

describe("extractPermissionPattern", () => {
	it("returns null for empty or missing commands", () => {
		expect(extractPermissionPattern("Bash", { command: "" })).toBeNull();
		expect(extractPermissionPattern("Bash", {})).toBeNull();
	});

	it("returns null for destructive commands", () => {
		expect(extractPermissionPattern("Bash", { command: "rm -rf /tmp/foo" })).toBeNull();
		expect(extractPermissionPattern("Bash", { command: "sudo reboot" })).toBeNull();
		expect(extractPermissionPattern("Bash", { command: "git push origin main" })).toBeNull();
	});

	it("rejects every command in the deny list", () => {
		for (const command of [
			"rm",
			"rmdir",
			"sudo",
			"chmod",
			"chown",
			"kill",
			"pkill",
			"killall",
			"dd",
			"mkfs",
			"fdisk",
			"shutdown",
			"reboot",
			"halt",
			"git reset",
			"git clean",
			"docker rm",
			"docker system",
			"kubectl delete",
			"kubectl drain",
			"terraform destroy",
			"terraform apply",
			"wrangler delete",
			"vercel rm",
			"vercel remove",
			"curl",
			"wget",
		]) {
			expect(extractPermissionPattern("Bash", { command: `${command} target` })).toBeNull();
		}
	});

	it("includes subcommand for npm / yarn / pnpm", () => {
		expect(extractPermissionPattern("Bash", { command: "npm install" })).toBe(
			"Bash(npm install *)",
		);
		expect(extractPermissionPattern("Bash", { command: "yarn build" })).toBe(
			"Bash(yarn build *)",
		);
	});

	it("includes package for npx / bunx", () => {
		expect(extractPermissionPattern("Bash", { command: "npx vitest run" })).toBe(
			"Bash(npx vitest *)",
		);
		expect(extractPermissionPattern("Bash", { command: "bunx eslint ." })).toBe(
			"Bash(bunx eslint *)",
		);
	});

	it("includes the subcommand for pnpm and handles command whitespace", () => {
		expect(extractPermissionPattern("Bash", { command: "pnpm test" })).toBe(
			"Bash(pnpm test *)",
		);
		expect(extractPermissionPattern("Bash", { command: "  npm   install  " })).toBe(
			"Bash(npm install *)",
		);
		expect(extractPermissionPattern("Bash", { command: "   " })).toBeNull();
	});

	it("extracts compound patterns from &&-chained commands", () => {
		expect(
			extractPermissionPattern("Bash", {
				command: "mkdir -p dist && cp -R src/* dist/ && git init && git commit -m x",
			}),
		).toBe("Bash(mkdir && cp && git init && git commit *)");
	});

	it("accepts compact and irregularly spaced compound commands", () => {
		expect(extractPermissionPattern("Bash", { command: "echo one&&printf two" })).toBe(
			"Bash(echo && printf *)",
		);
		expect(
			extractPermissionPattern("Bash", { command: "echo   one  &&  printf   two" }),
		).toBe("Bash(echo && printf *)");
	});

	it("skips assignment prefixes and rejects assignment-only or empty segments", () => {
		expect(extractPermissionPattern("Bash", { command: "FOO=bar && echo ok && printf yes" })).toBe(
			"Bash(echo && printf *)",
		);
		expect(extractPermissionPattern("Bash", { command: "FOO=bar && BAR=baz" })).toBeNull();
		expect(extractPermissionPattern("Bash", { command: "echo ok &&" })).toBeNull();
		expect(extractPermissionPattern("Bash", { command: "xFOO=bar && echo ok" })).toBe(
			"Bash(xFOO=bar && echo *)",
		);
		expect(extractPermissionPattern("Bash", { command: "foo=bar && echo ok" })).toBe(
			"Bash(foo=bar && echo *)",
		);
	});

	it("rejects destructive subcommands inside compound commands", () => {
		expect(extractPermissionPattern("Bash", { command: "git push && echo done" })).toBeNull();
		expect(extractPermissionPattern("Bash", { command: "git reset && echo done" })).toBeNull();
	});

	it("requires at least two compound command skeleton entries", () => {
		expect(extractPermissionPattern("Bash", { command: "echo one && printf two" })).toBe(
			"Bash(echo && printf *)",
		);
		expect(extractPermissionPattern("Bash", { command: "echo one &&" })).toBeNull();
	});

	it("uses the first meaningful multi-tool subcommand", () => {
		expect(
			extractPermissionPattern("Bash", {
				command: "git -n status && git $GIT_DIR log && git \"status init",
			}),
		).toBe("Bash(git status && git log && git init *)");
	});

	it("includes subcommands for all multi-subcommand tools in compounds", () => {
		for (const [tool, subcommand] of [
			["npm", "test"],
			["npx", "vitest"],
			["node", "script.js"],
			["cargo", "test"],
		]) {
			expect(
				extractPermissionPattern("Bash", { command: `${tool} ${subcommand} && echo done` }),
			).toBe(`Bash(${tool} ${subcommand} && echo *)`);
		}
	});

	it("returns null if any compound segment is destructive", () => {
		expect(extractPermissionPattern("Bash", { command: "cp a b && rm -rf dist" })).toBeNull();
	});

	it("extracts domain-scoped pattern for WebFetch", () => {
		expect(extractPermissionPattern("WebFetch", { url: "https://example.com/foo" })).toBe(
			"WebFetch(domain:example.com)",
		);
		expect(extractPermissionPattern("WebFetch", { url: "not a url" })).toBeNull();
		expect(extractPermissionPattern("web_fetch", { url: "https://example.org/path" })).toBe(
			"WebFetch(domain:example.org)",
		);
		expect(extractPermissionPattern("web_fetch", {})).toBeNull();
	});

	it("returns null for non-Bash, non-WebFetch tools", () => {
		expect(extractPermissionPattern("Read", { file_path: "/x" })).toBeNull();
		expect(extractPermissionPattern("Read", { url: "https://example.com" })).toBeNull();
	});
});

describe("addPermissionToSettings", () => {
	let tmpDir: string;
	// SPY, not process.chdir(): chdir THROWS in a worker thread
	// ("process.chdir() is not supported in workers"), and Stryker's vitest
	// runner pins its own pool, so a real chdir here fails the mutation dry run
	// for any file whose graph-selected test scope includes this one.
	// addPermissionToSettings resolves the settings dir via
	// `join(process.cwd(), ".claude")`, so the spy exercises the same path.
	let cwdSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "perm-"));
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
	});

	afterEach(() => {
		cwdSpy.mockRestore();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .claude/settings.json and persists a new pattern", () => {
		expect(addPermissionToSettings("Bash(ls *)")).toBe(true);
		const raw = readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		expect(parsed).toEqual({ permissions: { allow: ["Bash(ls *)"] } });
	});

	it("merges an existing settings file", () => {
		mkdirSync(join(tmpDir, ".claude"));
		writeFileSync(
			join(tmpDir, ".claude", "settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(pwd *)"] }, theme: "dark" }),
		);

		expect(addPermissionToSettings("Bash(ls *)")).toBe(true);
		expect(JSON.parse(readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8"))).toEqual({
			permissions: { allow: ["Bash(pwd *)", "Bash(ls *)"] },
			theme: "dark",
		});
	});

	it("creates missing nested settings directories", () => {
		const nestedCwd = join(tmpDir, "nested", "project");
		mkdirSync(nestedCwd, { recursive: true });
		cwdSpy.mockReturnValue(nestedCwd);

		expect(addPermissionToSettings("Bash(ls *)")).toBe(true);
		expect(readFileSync(join(nestedCwd, ".claude", "settings.json"), "utf-8")).toContain(
			"Bash(ls *)",
		);
	});

	it("returns false on duplicate and does not grow the allow list", () => {
		expect(addPermissionToSettings("Bash(ls *)")).toBe(true);
		expect(addPermissionToSettings("Bash(ls *)")).toBe(false);
		const raw = readFileSync(join(tmpDir, ".claude", "settings.json"), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		expect(parsed).toEqual({ permissions: { allow: ["Bash(ls *)"] } });
	});

	it("returns false when settings cannot be written", () => {
		mkdirSync(join(tmpDir, ".claude"));
		mkdirSync(join(tmpDir, ".claude", "settings.json"));

		expect(addPermissionToSettings("Bash(ls *)")).toBe(false);
	});
});
