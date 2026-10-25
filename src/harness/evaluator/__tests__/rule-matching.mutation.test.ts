import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuardRule, RulePattern } from "../../types.js";
import { getCachedRegex, matchesRule } from "../rule-matching.js";

function makeRule(patterns: RulePattern[]): GuardRule {
	return {
		id: "mutation-rule",
		category: "test",
		severity: "medium",
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		patterns,
		action: "block",
		reason: "mutation test rule",
		enabled: true,
	};
}

describe("getCachedRegex — stateful flags (module comment, rule-matching.ts:77-78)", () => {
	it("returns a regex whose lastIndex is reset to 0 on every lookup", () => {
		const first = getCachedRegex("mut-lastindex-marker", "g");
		expect(first.test("mut-lastindex-marker")).toBe(true);
		expect(first.lastIndex).toBeGreaterThan(0);
		const second = getCachedRegex("mut-lastindex-marker", "g");
		expect(second.lastIndex).toBe(0);
	});

	it("matches the same input on repeated evaluations of a g-flag rule", () => {
		const rule = makeRule([{ field: "command", regex: "mut-repeat-marker", flags: "g" }]);
		const ctx = { command: "run mut-repeat-marker now", toolInput: {}, rule };
		expect(matchesRule(ctx)).toBe(true);
		expect(matchesRule(ctx)).toBe(true);
	});
});

describe("matchesRule — nonempty_file_group (header of rule-matching-file-predicate.ts:1-8; MatchRuleContext.cwd doc, rule-matching.ts:98-101)", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "rule-matching-mut-"));
		writeFileSync(join(dir, "real.txt"), "contents\n");
		writeFileSync(join(dir, "empty.txt"), "");
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const truncate = (extra: Partial<RulePattern> = {}): GuardRule =>
		makeRule([{ field: "command", regex: String.raw`:\s*>\s*(?<target>\S+)`, nonempty_file_group: "target", ...extra }]);

	it("matches when the captured operand is an existing non-empty file", () => {
		const rule = truncate();
		expect(matchesRule({ command: ": > real.txt", toolInput: {}, rule, cwd: dir })).toBe(true);
	});

	it("does not match when the captured operand is an empty file", () => {
		const rule = truncate();
		expect(matchesRule({ command: ": > empty.txt", toolInput: {}, rule, cwd: dir })).toBe(false);
	});

	it("keeps the plain regex match when no cwd is supplied", () => {
		const rule = truncate();
		expect(matchesRule({ command: ": > missing-file.txt", toolInput: {}, rule })).toBe(true);
	});

	it("applies the regex alone when the pattern declares no nonempty_file_group, even with a cwd", () => {
		const rule = makeRule([{ field: "command", regex: "mut-plain-marker" }]);
		expect(matchesRule({ command: "mut-plain-marker", toolInput: {}, rule, cwd: dir })).toBe(true);
	});

	it("does not match when the regex itself does not match, even if a group is declared and cwd is set", () => {
		const rule = truncate();
		expect(matchesRule({ command: "echo hello", toolInput: {}, rule, cwd: dir })).toBe(false);
	});

	it("does not match when the regex matches but exposes no capture group of the declared name", () => {
		const rule = makeRule([{ field: "command", regex: "truncate-nogroup", nonempty_file_group: "target" }]);
		expect(matchesRule({ command: "truncate-nogroup real.txt", toolInput: {}, rule, cwd: dir })).toBe(false);
	});

	it("resolves the operand against the ORIGINAL command (variable assignments) even when executed_only rewrites quoted text", () => {
		const rule = truncate({ regex: String.raw`:\s*>\s*(?<target>\$F)`, executed_only: true });
		const command = 'F="empty.txt"; : > $F';
		expect(matchesRule({ command, toolInput: {}, rule, cwd: dir })).toBe(false);
	});
});

describe("matchesRule — command fallback for pattern fields (rule-matching.ts:143-149)", () => {
	it("a positive pattern on a field absent from toolInput is evaluated against the command", () => {
		const rule = makeRule([{ field: "command", regex: "rm\\s+-rf" }]);
		expect(matchesRule({ command: "rm -rf /tmp/x", toolInput: {}, rule })).toBe(true);
	});

	it("a negated pattern on a field absent from toolInput is evaluated against the command (exception fires)", () => {
		const rule = makeRule([
			{ field: "file_path", regex: String.raw`\.ts$` },
			{ field: "command", regex: "safe-run", negate: true },
		]);
		expect(matchesRule({ command: "safe-run now", toolInput: { file_path: "a.ts" }, rule })).toBe(false);
	});

	it("an empty-valued positive pattern is skipped so a later positive pattern can still match", () => {
		const rule = makeRule([
			{ field: "file_path", regex: "x" },
			{ field: "note", regex: "hello" },
		]);
		expect(matchesRule({ command: "", toolInput: { file_path: "", note: "hello world" }, rule })).toBe(true);
	});
});
