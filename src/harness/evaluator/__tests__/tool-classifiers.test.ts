import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyToolExternality,
	estimateEditLine,
	globMatch,
	isBash,
	isBrowserNavigate,
	isFileOperation,
	isFileWrite,
	isReadOperation,
	normalizeToolToOp,
} from "../tool-classifiers.js";

describe("tool classifiers", () => {
	it("isBash matches Bash-family tool names and rejects unrelated ones", () => {
		expect(isBash("Bash")).toBe(true);
		expect(isBash("bash")).toBe(true);
		expect(isBash("run_command")).toBe(true);
		expect(isBash(undefined)).toBe(false);
		expect(isBash("Write")).toBe(false);
	});

	it("isBrowserNavigate only matches Playwright/Chrome DevTools navigation tools", () => {
		expect(isBrowserNavigate("mcp__playwright__browser_navigate")).toBe(true);
		expect(isBrowserNavigate("mcp__chrome-devtools__navigate_page")).toBe(true);
		expect(isBrowserNavigate("mcp__chrome-devtools__new_page")).toBe(true);
		expect(isBrowserNavigate("mcp__playwright__browser_click")).toBe(false);
		expect(isBrowserNavigate(undefined)).toBe(false);
	});

	it("isBash recognizes the Shell/shell aliases explicitly, not just Bash/bash", () => {
		// test-contract: public-api — Copilot CLI and some runners name their
		// shell tool "Shell"/"shell" rather than "Bash"/"bash"; each alias must
		// independently gate Bash-family policy (destructive-command scanning).
		expect(isBash("Shell")).toBe(true);
		expect(isBash("shell")).toBe(true);
	});

	it("isBrowserNavigate requires a full anchored match, not a substring", () => {
		// test-contract: security — the regex is anchored (^...$); a tool name
		// that merely contains the mcp__ navigation verb as a prefix or has
		// trailing characters after it must not be classified as navigation.
		expect(isBrowserNavigate("xxxmcp__playwright__browser_navigate")).toBe(false);
		expect(isBrowserNavigate("mcp__playwright__browser_navigate_extra")).toBe(false);
	});

	it("isFileOperation covers Read/Write/Edit + Copilot CLI aliases", () => {
		expect(isFileOperation("Read")).toBe(true);
		expect(isFileOperation("Write")).toBe(true);
		expect(isFileOperation("Edit")).toBe(true);
		expect(isFileOperation("str_replace")).toBe(true);
		expect(isFileOperation("apply_patch")).toBe(true);
		expect(isFileOperation("Bash")).toBe(false);
		expect(isFileOperation(undefined)).toBe(false);
	});

	it("isFileOperation recognizes every declared alias, not just the common ones", () => {
		// test-contract: public-api — each alias in the classifier's own list
		// (ReadFile/WriteFile/EditFile/*_file/File*/view/create) independently
		// gates file-operation-only policy branches; a dropped alias silently
		// stops that runner's tool name from being treated as a file operation.
		for (const name of [
			"ReadFile",
			"WriteFile",
			"EditFile",
			"read_file",
			"write_file",
			"edit_file",
			"FileRead",
			"FileWrite",
			"FileEdit",
			"FileDelete",
			"view",
			"create",
		]) {
			expect(isFileOperation(name)).toBe(true);
		}
	});

	it("isReadOperation narrows to file-read tool variants", () => {
		expect(isReadOperation("Read")).toBe(true);
		expect(isReadOperation("view")).toBe(true);
		expect(isReadOperation("Write")).toBe(false);
		expect(isReadOperation(undefined)).toBe(false);
	});

	it("isReadOperation recognizes every declared read alias", () => {
		// test-contract: public-api — ReadFile/read_file/FileRead each
		// independently gate read-only policy branches (e.g. PII-on-read checks);
		// a dropped alias silently stops being treated as a read.
		for (const name of ["ReadFile", "read_file", "FileRead"]) {
			expect(isReadOperation(name)).toBe(true);
		}
	});

	it.each([
		["Write", true],
		["Edit", true],
		["MultiEdit", true],
		["multi_edit", true],
		["NotebookEdit", true],
		["apply_patch", true],
		["Read", false],
	] as const)("isFileWrite(%s) === %s", (name, expected) => {
		expect(isFileWrite(name)).toBe(expected);
	});

	it("isFileWrite(undefined) is false", () => {
		expect(isFileWrite(undefined)).toBe(false);
	});

	it("isFileWrite recognizes every declared write alias", () => {
		// test-contract: public-api — each alias independently gates write-guard
		// policy branches (reservations, protected-file checks); a dropped alias
		// silently stops that runner's tool name from being treated as a write.
		for (const name of [
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
			"FileWrite",
			"FileEdit",
			"str_replace",
			"create",
		]) {
			expect(isFileWrite(name)).toBe(true);
		}
	});

	it("normalizeToolToOp maps tool names to canonical protected-file ops", () => {
		expect(normalizeToolToOp("Read")).toBe("Read");
		expect(normalizeToolToOp("Write")).toBe("Write");
		expect(normalizeToolToOp("Edit")).toBe("Edit");
		expect(normalizeToolToOp("FileDelete")).toBe("Delete");
		expect(normalizeToolToOp("NotebookEdit")).toBe("Write");
		expect(normalizeToolToOp("Mystery")).toBe("Mystery");
	});

	it("normalizeToolToOp matches read/edit substrings inside compound tool names", () => {
		// test-contract: public-api — exercised on "FileRead"/"FileEdit" (not
		// bare "Read"/"Edit") so the fixed return value can't coincidentally
		// equal the unmatched fallback (`return toolName`) and mask a mutated
		// substring check.
		expect(normalizeToolToOp("FileRead")).toBe("Read");
		expect(normalizeToolToOp("FileEdit")).toBe("Edit");
	});
});

describe("estimateEditLine", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "evaluator-tc-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns line number of match (1-indexed)", () => {
		const file = join(tmpDir, "sample.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\n");
		expect(estimateEditLine(file, "gamma")).toBe(3);
	});

	it("returns undefined when file missing or old_string absent", () => {
		const file = join(tmpDir, "sample.txt");
		writeFileSync(file, "alpha\nbeta\n");
		expect(estimateEditLine(file, "missing")).toBeUndefined();
		expect(estimateEditLine(join(tmpDir, "no-such-file.txt"), "alpha")).toBeUndefined();
	});

	it("returns undefined when readFileSync throws (e.g. path is a directory)", () => {
		const dirPath = join(tmpDir, "a-directory");
		mkdirSync(dirPath);
		// existsSync(dirPath) is true, but readFileSync on a directory throws EISDIR —
		// exercises the catch-block fallback distinct from the "file missing" case.
		expect(estimateEditLine(dirPath, "anything")).toBeUndefined();
	});
});

describe("globMatch", () => {
	it("matches an exact path against an exact pattern", () => {
		expect(globMatch("src/foo/bar.ts", "src/foo/bar.ts")).toBe(true);
		expect(globMatch("src/foo/bar.ts", "src/foo/baz.ts")).toBe(false);
	});

	it("matches **/*.ext anywhere in the tree", () => {
		expect(globMatch("src/foo/bar.ts", "**/*.ts")).toBe(true);
		expect(globMatch("src/foo/bar.ts", "**/*.js")).toBe(false);
	});

	it("matches **/<literal-name> as a suffix or exact basename (no wildcard rest)", () => {
		expect(globMatch("src/foo/package.json", "**/package.json")).toBe(true);
		expect(globMatch("package.json", "**/package.json")).toBe(true); // filePath === rest
		expect(globMatch("src/foo/other.json", "**/package.json")).toBe(false);
	});

	it("matches bare *.ext patterns (no **/ prefix) in any directory", () => {
		expect(globMatch("src/foo/bar.ts", "*.ts")).toBe(true);
		expect(globMatch("bar.ts", "*.ts")).toBe(true);
		expect(globMatch("src/foo/bar.js", "*.ts")).toBe(false);
	});

	it("matches bare *.env* trailing-wildcard patterns (no **/ prefix)", () => {
		expect(globMatch("src/.env.local", "*.env*")).toBe(true);
		expect(globMatch("src/.env.local", "*.other*")).toBe(false);
	});

	it("matches pipe-separated patterns as a union", () => {
		expect(globMatch("secret.pem", "**/*.pem|**/*.key")).toBe(true);
		expect(globMatch("secret.key", "**/*.pem|**/*.key")).toBe(true);
		expect(globMatch("README.md", "**/*.pem|**/*.key")).toBe(false);
	});

	it("matches **/*.env* trailing-wildcard patterns", () => {
		expect(globMatch(".env.local", "**/*.env*")).toBe(true);
		expect(globMatch("config/.env.production", "**/*.env*")).toBe(true);
	});

	it("matches dir/** prefixes and dir/* direct children only", () => {
		expect(globMatch("src/a/b.ts", "src/**")).toBe(true);
		expect(globMatch("src/a.ts", "src/*")).toBe(true);
		expect(globMatch("src/a/b.ts", "src/*")).toBe(false);
	});

	it("matches **/dir/** anywhere in the tree, not the trailing ** literally (kill-proof review M1)", () => {
		// test-contract: bug — the `**/` branch compared `endsWith("/dir/**")`, so every `**/dir/**` rule was inert
		expect(globMatch("/repo/.interlinked/test-runs/kill-proofs/0123456789abcdef.json", "**/.interlinked/test-runs/kill-proofs/**")).toBe(true);
		expect(globMatch(".interlinked/test-runs/kill-proofs/0123456789abcdef.json", "**/.interlinked/test-runs/kill-proofs/**")).toBe(true);
		expect(globMatch("a/b/migrations/001.sql", "**/migrations/**")).toBe(true);
		expect(globMatch("migrations/001.sql", "**/migrations/**")).toBe(true);
		expect(globMatch("src/migrations", "**/migrations/**")).toBe(true);
		expect(globMatch("src/not-migrations/001.sql", "**/migrations/**")).toBe(false);
		expect(globMatch("src/migrationsx/001.sql", "**/migrations/**")).toBe(false);
		expect(globMatch(".interlinked/test-runs/other/x.json", "**/.interlinked/test-runs/kill-proofs/**")).toBe(false);
	});

	it("matches dir/** against the dir path itself (filePath === prefix)", () => {
		expect(globMatch("src", "src/**")).toBe(true);
		expect(globMatch("other", "src/**")).toBe(false);
	});

	it("returns false for non-matching bare patterns", () => {
		expect(globMatch("foo.ts", "bar.ts")).toBe(false);
	});

	it("only enters the **/*.ext branch when the rest actually starts with *.", () => {
		// test-contract: invariant — "**/literalName" (no *. after **/,) must be
		// handled by the literal-suffix branch, not misread as a wildcard
		// extension pattern that strips a leading character off "literalName".
		expect(globMatch("xyzoo.tsx", "**/foo.tsx")).toBe(false);
	});

	it("**/*.ext (no trailing wildcard) requires the FULL suffix, not a truncated one", () => {
		// test-contract: boundary — a file ending in "tsx" must not match
		// "**/*.ts" merely because it contains the truncated ".t" substring.
		expect(globMatch("src/file.tsx", "**/*.ts")).toBe(false);
	});

	it("**/*.env* keeps the full core after dropping only the trailing *", () => {
		// test-contract: boundary — core must be ".env" (4 chars via slice(0,-1)),
		// not "." (1 char); a file with an unrelated dot must not match.
		expect(globMatch("config.txt", "**/*.env*")).toBe(false);
	});

	it("bare *.ext (no trailing wildcard) requires the FULL suffix", () => {
		// test-contract: boundary — mirrors the **/*.ext case for the branch
		// with no **/ prefix.
		expect(globMatch("file.tsx", "*.ts")).toBe(false);
	});

	it("dir/** derives its prefix by stripping the trailing /** (last 3 chars)", () => {
		// test-contract: invariant — "source/**" must resolve prefix to
		// "source" (slice(0,-3)), not "sou" (a wrong slice(0,3) would take the
		// first 3 characters from the START instead).
		expect(globMatch("source/foo.ts", "source/**")).toBe(true);
	});

	it("a bare literal pattern never matches through the dir/* fallback", () => {
		// test-contract: boundary — "foo.ts" (no wildcard, no /** or /* suffix)
		// must fall through to `return false`, not be treated as if it ended
		// with "/*" and matched an unrelated path via a derived prefix.
		expect(globMatch("foo./bar", "foo.ts")).toBe(false);
	});

	it("dir/* requires the path to actually start with '<dir>/'", () => {
		// test-contract: security — dir/* is a direct-children-only pattern; a
		// path that does not start with the directory prefix at all must not
		// match just because its remainder happens to contain no further "/".
		expect(globMatch("notsrcfile", "src/*")).toBe(false);
	});

	it("pipe-separated patterns are trimmed before recursing", () => {
		// test-contract: public-api — guard-rules.json authors may add spacing
		// around the "|" for readability; each split segment must still be
		// trimmed and match, not compared with stray leading/trailing whitespace.
		expect(globMatch("secret.pem", "**/*.pem | **/*.key")).toBe(true);
	});
});

describe("classifyToolExternality", () => {
	it("classifies every PURE_READ_TOOL_NAMES entry as pure_read", () => {
		// test-contract: public-api — each read-only tool name independently
		// selects the pure_read externality tier; a dropped entry silently
		// falls through to the local_write default, weakening any
		// pure_read-scoped policy (e.g. "safe to run in parallel") that should
		// have applied to that tool.
		for (const name of [
			"Read",
			"ReadFile",
			"read_file",
			"FileRead",
			"view",
			"Glob",
			"Grep",
			"grep",
			"NotebookRead",
			"ListFiles",
			"TodoRead",
		]) {
			expect(classifyToolExternality(name)).toBe("pure_read");
		}
	});

	it("classifies every EXTERNAL_ACTION_TOOL_NAMES entry as external_action", () => {
		// test-contract: security — WebFetch/WebSearch aliases must
		// independently select the strictest (external_action) tier so
		// egress-gating policies apply to them; a dropped entry would
		// silently downgrade that tool to the local_write default.
		for (const name of ["WebFetch", "web_fetch", "WebSearch", "web_search"]) {
			expect(classifyToolExternality(name)).toBe("external_action");
		}
	});

	it("the Bash external-action regex requires 1+ whitespace between keywords, not a fixed count or a non-space run", () => {
		// test-contract: security — each keyword pair (gh pr, docker push,
		// kubectl apply, terraform apply, npm/yarn/pnpm publish) must
		// independently match across real-world variable spacing (double space
		// here proves both "\\s+ not \\S+" and "\\s+ not exactly-one-\\s") so a
		// strict-tier egress policy can't be dodged by reformatting the command.
		for (const command of [
			"gh  pr",
			"docker  push",
			"kubectl  apply",
			"terraform  apply",
			"npm  publish",
			"yarn  publish",
			"pnpm  publish",
		]) {
			expect(classifyToolExternality("Bash", { command })).toBe("external_action");
		}
	});
});
