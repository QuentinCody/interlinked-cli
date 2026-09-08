import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	checkAssertionStrengthWeakening,
	checkClockMockAdded,
	checkConventionalCommitCoherence,
	checkDisabledTestDelta,
	checkDoneWithoutVerify,
	checkReintroducesRemovedCode,
	checkTestBlockCountRegression,
	checkTestTimeoutInflation,
	parseCommitMessageFromBash,
} from "./behavioral-diff-checks.js";
import type { SessionTrajectory } from "./types.js";

// ==========================================================================
// parseCommitMessageFromBash — pure-function unit tests
// ==========================================================================

describe("parseCommitMessageFromBash", () => {
	it("parses double-quoted -m \"fix: foo\"", () => {
		expect(parseCommitMessageFromBash(`git commit -m "fix: foo bar"`)).toEqual({
			type: "fix",
			subject: "foo bar",
		});
	});

	it("parses single-quoted -m 'feat: x'", () => {
		expect(parseCommitMessageFromBash(`git commit -m 'feat: x'`)).toEqual({
			type: "feat",
			subject: "x",
		});
	});

	it("parses scope and breaking-change marker", () => {
		expect(parseCommitMessageFromBash(`git commit -m "fix(auth)!: blah"`)).toEqual({
			type: "fix",
			subject: "blah",
		});
	});

	it("returns null when no -m flag", () => {
		expect(parseCommitMessageFromBash(`git commit`)).toBeNull();
	});

	it("returns null when message has no conventional prefix", () => {
		expect(parseCommitMessageFromBash(`git commit -m "plain message"`)).toBeNull();
	});

	it("lowercases the type", () => {
		expect(parseCommitMessageFromBash(`git commit -m "Fix: caps"`)?.type).toBe("fix");
	});

	it("trims leading/trailing whitespace inside the -m argument before parsing the prefix", () => {
		expect(parseCommitMessageFromBash(`git commit -m "  fix: foo bar  "`)).toEqual({
			type: "fix",
			subject: "foo bar",
		});
	});

	it("does not treat a conventional-commit-shaped substring appearing mid-string as the message's actual prefix", () => {
		expect(parseCommitMessageFromBash(`git commit -m "xyz fix: real message"`)).toBeNull();
	});

	it("rejects a raw message that has trailer content after the subject line (the $ anchor must reach the true end of the string)", () => {
		expect(
			parseCommitMessageFromBash(`git commit -m "fix: title\nextra trailer text"`),
		).toBeNull();
	});

	it("does not collapse a double-space-after-colon subject down to a mandatory single space", () => {
		expect(parseCommitMessageFromBash(`git commit -m "fix:  double space subject"`)).toEqual({
			type: "fix",
			subject: "double space subject",
		});
	});

	it("recognizes -m with double space before a quoted argument", () => {
		expect(parseCommitMessageFromBash(`git commit -m  "fix: double space before arg"`)).toEqual({
			type: "fix",
			subject: "double space before arg",
		});
	});

	it("captures a bare (unquoted) -m argument in full, not just its first character", () => {
		expect(parseCommitMessageFromBash(`git commit -m fix:bareword`)).toEqual({
			type: "fix",
			subject: "bareword",
		});
	});
});

// ==========================================================================
// Diff-aware checks — exercised against a real temp git repo
// ==========================================================================

let repoDir: string;

function git(args: string[]): string {
	return execSync(`git ${args.join(" ")}`, { cwd: repoDir, encoding: "utf-8" });
}

function setupRepo(): void {
	repoDir = mkdtempSync(join(tmpdir(), "diff-checks-"));
	git(["init", "-q"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "user.name", "Test"]);
	git(["config", "commit.gpgsign", "false"]);
}

beforeEach(() => {
	setupRepo();
});

afterEach(() => {
	try {
		execSync(`rm -rf ${repoDir}`);
	} catch {
		// Best-effort cleanup; on Windows mkdtempSync uses %TMP% but this
		// suite runs in CI on linux/mac.
	}
});

function commitInitial(file: string, content: string): void {
	mkdirSync(join(repoDir, dirname(file)), { recursive: true });
	writeFileSync(join(repoDir, file), content);
	git(["add", "."]);
	git(["commit", "-q", "-m", "initial"]);
}

function stageEdit(file: string, content: string): void {
	mkdirSync(join(repoDir, dirname(file)), { recursive: true });
	writeFileSync(join(repoDir, file), content);
	git(["add", "."]);
}

function makeSession(files: string[]): SessionTrajectory {
	return ({ ...completeSessionFixture(), ...{
		files_written: new Set(files.map((f) => join(repoDir, f))),
		files_read: new Set(),
		file_edit_counts: new Map(),
		test_runs: new Map(),
		failed_files: new Map(),
		warnings_emitted: new Map(),
		tdd_cycles: new Map(),
		assertion_counts: new Map(),
		active_skills: new Map(),
		tool_call_count: 0,
	} });
}

describe("checkDisabledTestDelta", () => {
	it("flags newly-added it.skip blocks (exact result shape)", () => {
		commitInitial(
			"foo.test.ts",
			`it("a", () => {});\nit("b", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("a", () => {});\nit.skip("b", () => {});\n`,
		);
		const file = join(repoDir, "foo.test.ts");
		const results = checkDisabledTestDelta(makeSession(["foo.test.ts"]));
		expect(results).toEqual([
			{
				source: "structural",
				name: "disabled_test_delta",
				severity: "error",
				message:
					"foo.test.ts adds 1 new disabled-test directive(s) (.skip / xit / .todo). Fix the failing test instead of skipping it. If skipping is genuinely necessary, document why with a TICKET-XXX reference.",
				file,
				determinism: "fully_deterministic",
			},
		]);
	});

	it("does not fire when an existing skip is removed", () => {
		commitInitial(
			"foo.test.ts",
			`it.skip("a", () => {});\nit("b", () => {});\n`,
		);
		stageEdit("foo.test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("does not fire when added and removed disable directives net to zero (delta === 0 boundary)", () => {
		commitInitial(
			"foo.test.ts",
			`it.skip("a", () => {});\nit("b", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("a", () => {});\nit.skip("b", () => {});\n`,
		);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("does not fire on production source (TEST_FILE_RE gate stays enforced even for real disable-directive content)", () => {
		commitInitial("foo.ts", `function a() {}\n`);
		stageEdit("foo.ts", `function a() {}\nit.skip("real disable shape", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.ts"]))).toEqual([]);
	});

	it("does not misread the diff's own +++/--- header lines as content, even when the filename itself contains a skip-directive-shaped substring", () => {
		commitInitial("it.skip(x).test.ts", `it("a", () => {});\n`);
		stageEdit("it.skip(x).test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		expect(
			checkDisabledTestDelta(makeSession(["it.skip(x).test.ts"])),
		).toEqual([]);
	});

	it("counts a directive whose trailing text ends in '+++' or '---' as content, not as a header line", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`it("a", () => {});\nit.skip("b", () => {}); // +++\nit.skip("c", () => {}); // ---\n`,
		);
		const results = checkDisabledTestDelta(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toContain("adds 2 new disabled-test directive(s)");
	});

	// DISABLE_DIRECTIVES_RE spacing-boundary cases (whitespace is optional
	// around `.` / before `(` per the regex's `\s*` — a `\S*` mutation would
	// require a space-free match and miss these).
	it("recognizes a disable directive with whitespace between the block name and the dot", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `it("a", () => {});\nit .skip("b", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes a disable directive with whitespace between the dot and skip/todo", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `it("a", () => {});\nit. skip("b", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes a disable directive with whitespace between skip/todo and the paren", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `it("a", () => {});\nit.skip ("b", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes a bare xit( call with no space before the paren", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `it("a", () => {});\nxit("b", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes an xit call with whitespace before the paren", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `it("a", () => {});\nxit ("b", () => {});\n`);
		expect(checkDisabledTestDelta(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("does not misread an unchanged (context) line that already contains a disable directive as a newly-removed one", () => {
		commitInitial(
			"foo.test.ts",
			`it.skip("unchanged", () => {});\nit("a", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it.skip("unchanged", () => {});\nit("a", () => {});\nit.skip("b", () => {});\n`,
		);
		const results = checkDisabledTestDelta(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toContain("adds 1 new disabled-test directive(s)");
	});
});

describe("checkTestBlockCountRegression", () => {
	it("flags removed test blocks (net negative)", () => {
		commitInitial(
			"foo.test.ts",
			`it("a", () => {});\nit("b", () => {});\nit("c", () => {});\n`,
		);
		stageEdit("foo.test.ts", `it("a", () => {});\n`);
		const results = checkTestBlockCountRegression(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).name).toBe("test_block_count_regression");
	});

	it("does not fire when blocks are added", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		expect(checkTestBlockCountRegression(makeSession(["foo.test.ts"]))).toEqual([]);
	});
});

describe("checkAssertionStrengthWeakening", () => {
	it("flags toBe(literal) → toBeTruthy() replacement (exact result shape)", () => {
		commitInitial(
			"foo.test.ts",
			`it("a", () => { expect(x).toBe(42); });\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("a", () => { expect(x).toBeTruthy(); });\n`,
		);
		const file = join(repoDir, "foo.test.ts");
		const results = checkAssertionStrengthWeakening(makeSession(["foo.test.ts"]));
		expect(results).toEqual([
			{
				source: "structural",
				name: "assertion_strength_weakening",
				severity: "warning",
				message:
					"foo.test.ts replaces strong assertions (toBe/toEqual/toMatch x1) with weak ones (toBeTruthy/toBeDefined/not.toThrow x1). Either restore the strong assertion (and fix what made it fail), or document why the looser matcher is correct.",
				file,
				determinism: "heuristic",
			},
		]);
	});

	it("does not fire when only adding assertions", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`it("a", () => { expect(x).toBeTruthy(); });\n`,
		);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("does not fire on production source files (TEST_FILE_RE gate)", () => {
		commitInitial("foo.ts", `expect(x).toBe(1);\n`);
		stageEdit("foo.ts", `expect(x).toBeTruthy();\n`);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.ts"]))).toEqual([]);
	});

	it("does not misread the diff's own +++ header line as a weak-matcher addition, even when the filename contains a weak-matcher-shaped substring", () => {
		commitInitial("weak.toBeTruthy(x).test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		// Real edit: removes a strong matcher, adds nothing weak or strong.
		stageEdit("weak.toBeTruthy(x).test.ts", `it("a", () => {});\n`);
		expect(
			checkAssertionStrengthWeakening(makeSession(["weak.toBeTruthy(x).test.ts"])),
		).toEqual([]);
	});

	// STRONG_MATCHER_RE / WEAK_MATCHER_RE spacing-boundary cases.
	it("recognizes a strong matcher removed with whitespace between the dot and the matcher name", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(x). toBe(1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(x).toBeTruthy(); });\n`);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes a strong matcher removed with whitespace before the paren", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(x).toBe (1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(x).toBeTruthy(); });\n`);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes a weak matcher added with whitespace between the dot and the matcher name", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(x). toBeTruthy(); });\n`);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes not.toThrow() with no whitespace around the dot (both \\s* are optional)", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(() => f()).not.toThrow(); });\n`);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes not .toThrow() with whitespace before the dot", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(() => f()).not .toThrow(); });\n`);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes not.toThrow () with whitespace before the final paren", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(() => f()).not.toThrow (); });\n`);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("does not misread an unchanged (context) line containing a strong matcher as a newly-removed one", () => {
		commitInitial(
			"foo.test.ts",
			`it("keep", () => { expect(y).toBe(1); });\nit("a", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("keep", () => { expect(y).toBe(1); });\nit("a", () => { expect(x).toBeTruthy(); });\n`,
		);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("does not misread an unchanged (context) line containing a weak matcher as a newly-added one", () => {
		commitInitial(
			"foo.test.ts",
			`it("keep", () => { expect(y).toBeTruthy(); });\nit("a", () => { expect(x).toBe(1); });\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("keep", () => { expect(y).toBeTruthy(); });\nit("a", () => {});\n`,
		);
		expect(checkAssertionStrengthWeakening(makeSession(["foo.test.ts"]))).toEqual([]);
	});
});

describe("checkClockMockAdded", () => {
	it("flags newly-added vi.setSystemTime calls (exact result shape)", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`vi.setSystemTime(new Date(2024, 1, 1));\nit("a", () => {});\n`,
		);
		const file = join(repoDir, "foo.test.ts");
		const results = checkClockMockAdded(makeSession(["foo.test.ts"]));
		expect(results).toEqual([
			{
				source: "structural",
				name: "clock_mock_added",
				severity: "info",
				message:
					"foo.test.ts adds 1 clock-mock call(s) (vi.setSystemTime / vi.useFakeTimers). If this is to silence a real timing bug, fix the SUT instead. If the test genuinely depends on time, consider injecting a Clock interface so production code is the same shape.",
				file,
				determinism: "fully_deterministic",
			},
		]);
	});

	it("does not fire when vi.useFakeTimers was already there", () => {
		commitInitial(
			"foo.test.ts",
			`vi.useFakeTimers();\nit("a", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`vi.useFakeTimers();\nit("a", () => {});\nit("b", () => {});\n`,
		);
		expect(checkClockMockAdded(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("does not misread the diff's own +++ header line as a clock-mock addition, even when the filename contains a clock-mock-shaped substring", () => {
		commitInitial("vi.setSystemTime(x).test.ts", `it("a", () => {});\n`);
		stageEdit("vi.setSystemTime(x).test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		expect(
			checkClockMockAdded(makeSession(["vi.setSystemTime(x).test.ts"])),
		).toEqual([]);
	});

	// VI_SET_SYSTEM_TIME_RE spacing-boundary cases.
	it("recognizes vi .setSystemTime( with whitespace between vi and the dot", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `vi .setSystemTime(new Date());\nit("a", () => {});\n`);
		expect(checkClockMockAdded(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("recognizes vi.setSystemTime ( with whitespace before the paren", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit("foo.test.ts", `vi.setSystemTime (new Date());\nit("a", () => {});\n`);
		expect(checkClockMockAdded(makeSession(["foo.test.ts"])).length).toBe(1);
	});

	it("does not fire when a removed clock-mock call is replaced by a different clock-mock call (net zero)", () => {
		commitInitial(
			"foo.test.ts",
			`vi.setSystemTime(new Date(2024, 1, 1));\nit("a", () => {});\n`,
		);
		stageEdit("foo.test.ts", `it("a", () => {});\nvi.useFakeTimers();\n`);
		expect(checkClockMockAdded(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("does not let an unrelated line removal mask a real clock-mock addition", () => {
		commitInitial("foo.test.ts", `it("old", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`it("new", () => {});\nvi.setSystemTime(new Date());\n`,
		);
		const results = checkClockMockAdded(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
	});

	it("does not misread an unchanged (context) line containing a clock-mock call as a newly-removed one", () => {
		commitInitial("foo.test.ts", `vi.useFakeTimers();\nit("a", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`vi.useFakeTimers();\nit("a", () => {});\nvi.setSystemTime(new Date());\n`,
		);
		const results = checkClockMockAdded(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toContain("adds 1 clock-mock call(s)");
	});
});

describe("checkConventionalCommitCoherence", () => {
	it("flags fix: with comment-only diff (exact result shape)", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n// added a comment\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "the bug" },
		);
		expect(results).toEqual([
			{
				source: "structural",
				name: "commit_message_diff_mismatch",
				severity: "warning",
				message:
					'Commit message says "fix:" but every staged change is comment-only / whitespace-only. Either rewrite the message (e.g. `docs:`, `chore:`) or include the actual fix.',
				file: "<session>",
				determinism: "heuristic",
			},
		]);
	});

	it("does not flag a pure-deletion fix: commit with no added lines (extractRemovedLines must actually read the removed content, not always treat it as empty)", () => {
		commitInitial(
			"foo.ts",
			`function a() { return 1; }\nconsole.log("buggy debug line");\n`,
		);
		stageEdit("foo.ts", `function a() { return 1; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "remove debug" },
		);
		expect(results).toEqual([]);
	});

	it("fix: with a comment-plus-blank-line-only addition still counts as comment-only (blank lines must not be treated as substantive)", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n// trailing comment\n\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "oops" },
		);
		expect(results.length).toBe(1);
	});

	it("fix: with an indented comment-only addition still counts as comment-only (lines must be trimmed before the comment-prefix check)", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n   // indented comment\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "oops" },
		);
		expect(results.length).toBe(1);
	});

	it("fix: with a block-comment-only addition (/* ... */) still counts as comment-only", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n/* block comment */\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "oops" },
		);
		expect(results.length).toBe(1);
	});

	it("fix: with a block-comment-continuation-only addition (leading *) still counts as comment-only", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n * continuation comment\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "oops" },
		);
		expect(results.length).toBe(1);
	});

	it("flags feat: without new exports (exact result shape)", () => {
		commitInitial("foo.ts", `export function a() { return 1; }\n`);
		stageEdit("foo.ts", `export function a() { return 2; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "feat", subject: "x" },
		);
		expect(results).toEqual([
			{
				source: "structural",
				name: "commit_message_diff_mismatch",
				severity: "warning",
				message:
					'Commit message says "feat:" but the staged diff introduces no new exported symbol. New features typically expose a callable surface — verify the message matches the change (try `fix:` or `refactor:` if you didn\'t add a public API).',
				file: "<session>",
				determinism: "heuristic",
			},
		]);
	});

	it("does not fire when feat: introduces a new export", () => {
		commitInitial("foo.ts", `export function a() {}\n`);
		stageEdit("foo.ts", `export function a() {}\nexport function b() {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("does not fire when feat: adds a named re-export from a barrel", () => {
		commitInitial("foo.ts", `export { Existing } from "./existing.js";\n`);
		stageEdit(
			"foo.ts",
			`export { Existing } from "./existing.js";\nexport { Brand } from "./brand.js";\n`,
		);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("does not fire when feat: adds a star re-export", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nexport * from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("does not fire when feat: adds a default export", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nexport default function MyFeat() {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "feat",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("flags test: with production-source modifications (exact result shape)", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 2; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "test", subject: "x" },
		);
		expect(results).toEqual([
			{
				source: "structural",
				name: "commit_message_diff_mismatch",
				severity: "warning",
				message:
					'Commit message says "test:" but production source files are also modified. Split the production change into its own commit (with `fix:` / `feat:` / `refactor:`) so the history accurately reflects what changed.',
				file: "<session>",
				determinism: "heuristic",
			},
		]);
	});

	it("does NOT flag test: for a prod file written earlier but not staged in this commit", () => {
		// prod.ts was written this session but committed earlier; only the test
		// file is staged now. The check must reason over the STAGED diff, not the
		// whole session.files_written, or it false-fires "test: touches prod".
		commitInitial("prod.ts", `export function a() { return 1; }\n`);
		commitInitial("bar.test.ts", `it("a", () => {});\n`);
		stageEdit("bar.test.ts", `it("a", () => {});\nit("b", () => {});\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["prod.ts", "bar.test.ts"]),
			{ type: "test", subject: "add b" },
		);
		expect(results).toEqual([]);
	});

	it("returns empty when no message", () => {
		expect(checkConventionalCommitCoherence(makeSession([]), null)).toEqual([]);
	});

	it("does NOT flag deletion-only fix: commits", () => {
		// A `fix:` commit that removes broken code is a real fix even though
		// the added side of the diff is empty. Inspect removed lines too;
		// only flag when both halves are comment/whitespace-only.
		commitInitial("foo.ts", `function a() { console.log("buggy debug line"); return 1; }\n`);
		stageEdit("foo.ts", `function a() { return 1; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "remove debug" },
		);
		expect(results).toEqual([]);
	});

	it("still flags fix: when both added and removed are comment-only", () => {
		commitInitial("foo.ts", `// old comment\nfunction a() { return 1; }\n`);
		stageEdit("foo.ts", `// new comment\nfunction a() { return 1; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.ts"]),
			{ type: "fix", subject: "the bug" },
		);
		expect(results.length).toBe(1);
	});

	it("flags docs: touching a non-docs .ts file (exact result shape)", () => {
		commitInitial("src/foo.ts", `export function a() { return 1; }\n`);
		stageEdit("src/foo.ts", `export function a() { return 2; }\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["src/foo.ts"]),
			{ type: "docs", subject: "update" },
		);
		expect(results).toEqual([
			{
				source: "structural",
				name: "commit_message_diff_mismatch",
				severity: "warning",
				message:
					'Commit message says "docs:" but non-docs files (.ts / .tsx outside docs paths) are modified. Either narrow the diff to docs only or re-classify the commit type.',
				file: "<session>",
				determinism: "heuristic",
			},
		]);
	});

	// isDocsPath's docs-directory regex requires a `/docs/`-shaped segment
	// (leading slash or start-of-string), not a bare `docs` substring —
	// e.g. `nodocs/foo.ts` must NOT be treated as a docs path.
	it("does NOT treat a path merely containing 'docs' as a substring (no path-segment boundary) as a docs path", () => {
		commitInitial("nodocs/foo.ts", `export const note = "old";\n`);
		stageEdit("nodocs/foo.ts", `export const note = "new";\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["nodocs/foo.ts"]),
			{ type: "docs", subject: "update" },
		);
		expect(results.length).toBe(1);
	});

	it("flags refactor: with a changed test assertion (exact result shape)", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(total).toBe(5); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(total).toBe(6); });\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.test.ts"]),
			{ type: "refactor", subject: "cleanup" },
		);
		expect(results).toEqual([
			{
				source: "structural",
				name: "commit_message_diff_mismatch",
				severity: "info",
				message:
					"Commit message says \"refactor:\" but test assertions changed in 1 file(s). Refactors preserve behavior — assertion changes suggest a behavior delta. Consider `fix:` or `feat:` if the SUT contract moved.",
				file: "<session>",
				determinism: "heuristic",
			},
		]);
	});

	// The refactor: assertion-mutation regex requires `expect(...)`/`assert(...)`
	// followed by a `.to<Matcher>` call — spacing around the dot and the parens
	// is optional (`\s*`), not mandatory or forbidden (`\S*`).
	it("recognizes a changed assertion with whitespace between the call and the dot", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(total) .toBe(5); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(total) .toBe(6); });\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.test.ts"]),
			{ type: "refactor", subject: "cleanup" },
		);
		expect(results.length).toBe(1);
	});

	it("recognizes a changed assertion with whitespace between the dot and the matcher name", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(total). toBe(5); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(total). toBe(6); });\n`);
		const results = checkConventionalCommitCoherence(
			makeSession(["foo.test.ts"]),
			{ type: "refactor", subject: "cleanup" },
		);
		expect(results.length).toBe(1);
	});
});

// ==========================================================================
// EXPORT_NAME_RE boundary cases (feat: export-detection regex) — every
// keyword branch needs `\s+` (one-or-more, not exactly-one and not
// `\S+`/`\S*`), and the `^\s*` anchor must require true line-start, not
// match mid-line or fail on indentation.
// ==========================================================================

describe("checkConventionalCommitCoherence — feat: EXPORT_NAME_RE boundary cases", () => {
	it.each([
		["export function b() {}", "bare function"],
		["export  function b() {}", "double space after export"],
		["export async function b() {}", "async function"],
		["export async  function b() {}", "double space after async"],
		["export function  b() {}", "double space after function"],
		["export default function myFn() {}", "named default function"],
		["export default  function myFn() {}", "double space after default"],
		["export class Foo {}", "class"],
		["export class  Foo {}", "double space after class"],
		["export const x = 1;", "const"],
		["export const  x = 1;", "double space after const"],
		["export let x = 1;", "let"],
		["export let  x = 1;", "double space after let"],
		["export var x = 1;", "var"],
		["export var  x = 1;", "double space after var"],
		["export interface Foo {}", "interface"],
		["export interface  Foo {}", "double space after interface"],
		["export type Foo = {};", "type"],
		["export type  Foo = {};", "double space after type"],
		["export enum Foo {}", "enum"],
		["export enum  Foo {}", "double space after enum"],
	])("recognizes a genuinely new export: %s (%s)", (line) => {
		commitInitial("foo.ts", `export function existing() {}\n`);
		stageEdit("foo.ts", `export function existing() {}\n${line}\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "x",
		});
		expect(results).toEqual([]);
	});

	it("recognizes an indented new export (leading whitespace before export)", () => {
		commitInitial("foo.ts", `export function a() {}\n`);
		stageEdit("foo.ts", `export function a() {}\n  export function b() {}\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "x",
		});
		expect(results).toEqual([]);
	});

	it("does NOT treat 'export' appearing mid-line (not at line start) as a new export declaration", () => {
		commitInitial("foo.ts", `export function a() {}\n`);
		stageEdit(
			"foo.ts",
			`export function a() {}\nconst debug = 1; export const trulyNested = 2;\n`,
		);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "x",
		});
		expect(results.length).toBe(1);
	});

	it("distinguishes a genuine rename from a no-op edit by the export's FULL name, not just its first character", () => {
		// alpha -> alphaBeta is a real rename introducing a new export symbol.
		// A regex that only captures the identifier's first character would
		// see "a" on both sides and wrongly conclude nothing new was exported.
		commitInitial("foo.ts", `export const alpha = 1;\n`);
		stageEdit("foo.ts", `export const alphaBeta = 1;\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "rename export",
		});
		expect(results).toEqual([]);
	});
});

// ==========================================================================
// EXPORT_NAMED_LIST_RE boundary cases — `export { Foo }` barrel re-exports.
// ==========================================================================

describe("checkConventionalCommitCoherence — feat: EXPORT_NAMED_LIST_RE boundary cases", () => {
	it("recognizes export{ Foo } with zero space between export and the brace", () => {
		commitInitial("foo.ts", `export { Existing } from "./existing.js";\n`);
		stageEdit(
			"foo.ts",
			`export { Existing } from "./existing.js";\nexport{ Brand } from "./brand.js";\n`,
		);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export {Foo } with zero space after the opening brace", () => {
		commitInitial("foo.ts", `export { Existing } from "./existing.js";\n`);
		stageEdit(
			"foo.ts",
			`export { Existing } from "./existing.js";\nexport {Brand } from "./brand.js";\n`,
		);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export { Foo} with zero space before the closing brace", () => {
		commitInitial("foo.ts", `export { Existing } from "./existing.js";\n`);
		stageEdit(
			"foo.ts",
			`export { Existing } from "./existing.js";\nexport { Brand} from "./brand.js";\n`,
		);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes an indented export { Foo } (leading whitespace)", () => {
		commitInitial("foo.ts", `export { Existing } from "./existing.js";\n`);
		stageEdit(
			"foo.ts",
			`export { Existing } from "./existing.js";\n  export { Brand } from "./brand.js";\n`,
		);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("does NOT treat 'export {' appearing mid-line as a named re-export declaration", () => {
		commitInitial("foo.ts", `export { Existing } from "./existing.js";\n`);
		stageEdit(
			"foo.ts",
			`export { Existing } from "./existing.js";\nconst x = 1; export { NotAtLineStart };\n`,
		);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" })
				.length,
		).toBe(1);
	});

	it("trims each list entry's whitespace so a whitespace-only edit to an export list is not misread as introducing a new export", () => {
		// Only whitespace changes between the two lines — the name SET is
		// identical ({"Alpha","Beta"}) either way. Without per-entry
		// `.trim()`, the untrimmed leading space on "Beta" would make the
		// before/after name sets fail to line up, wrongly reading as new.
		commitInitial("foo.ts", `export { Alpha, Beta } from "./x.js";\n`);
		stageEdit("foo.ts", `export { Alpha,  Beta } from "./x.js";\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "x",
		});
		expect(results.length).toBe(1);
	});
});

// ==========================================================================
// exportedNamesIn's per-entry alias extraction — `Foo as Bar` credits the
// alias `Bar`, and `type Foo` strips the TS type-only prefix.
// ==========================================================================

describe("checkConventionalCommitCoherence — feat: named-export alias/type-prefix extraction", () => {
	it("extracts just the alias (not the whole 'X as Y' text) so re-exporting an existing public name under a new source still counts as unchanged", () => {
		commitInitial("foo.ts", `export { Foo } from "./a.js";\n`);
		stageEdit("foo.ts", `export { Something as Foo } from "./b.js";\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "x",
		});
		// "Foo" is the public name both before and after — nothing new was
		// exported, even though the source binding changed.
		expect(results.length).toBe(1);
	});

	it("strips a TS type-only export's 'type ' prefix so it credits the same public name as a value export", () => {
		commitInitial("foo.ts", `export { Foo } from "./a.js";\n`);
		stageEdit("foo.ts", `export { type Foo } from "./a.js";\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "x",
		});
		expect(results.length).toBe(1);
	});

	it("strips the 'type ' prefix even with extra internal whitespace before the name", () => {
		commitInitial("foo.ts", `export { Foo } from "./a.js";\n`);
		stageEdit("foo.ts", `export { type  Foo } from "./a.js";\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
			type: "feat",
			subject: "x",
		});
		expect(results.length).toBe(1);
	});
});

// ==========================================================================
// EXPORT_STAR_RE boundary cases — `export * from "./mod"` / `export * as ns
// from "./mod"`.
// ==========================================================================

describe("checkConventionalCommitCoherence — feat: EXPORT_STAR_RE boundary cases", () => {
	it("recognizes export  * from with double space after export", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nexport  * from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export *  as ns from with double space before 'as'", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nexport *  as ns from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export * as  ns from with double space after 'as'", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nexport * as  ns from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export *  from with double space before 'from'", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nexport *  from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export * from  with double space after 'from'", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nexport * from  "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes an indented export * from (leading whitespace)", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\n  export * from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("does NOT treat 'export *' appearing mid-line as a star re-export declaration", () => {
		commitInitial("foo.ts", `// barrel\n`);
		stageEdit("foo.ts", `// barrel\nconst x = 1; export * from "./newmodule.js";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" })
				.length,
		).toBe(1);
	});
});

// ==========================================================================
// EXPORT_DEFAULT_ANY_RE boundary cases — anonymous default exports
// (`export default function () {}`, `export default class {}`, `export
// default (x) => x`, etc).
// ==========================================================================

describe("checkConventionalCommitCoherence — feat: EXPORT_DEFAULT_ANY_RE boundary cases", () => {
	it("recognizes a bare anonymous default function export (no leading indentation)", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nexport default function () {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes an anonymous default function export with no async keyword (async stays optional)", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nexport default class {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes an indented anonymous default export (leading whitespace)", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\n  export default function () {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export  default with double space between export and default", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nexport  default function () {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("recognizes export default  with double space between default and the value", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nexport default  function () {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});

	it("does NOT treat 'export default' appearing mid-line as a default-export declaration", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nconst x = 1; export default function () {}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" })
				.length,
		).toBe(1);
	});

	// The fallback alternative in EXPORT_DEFAULT_ANY_RE is a bare
	// identifier-start char class `[A-Za-z_$]` — negating it to
	// `[^A-Za-z_$]` breaks the one case that only that fallback covers:
	// a default export of a bare identifier with nothing else after it.
	it("recognizes a default export of a bare identifier (only the fallback alternative covers this)", () => {
		commitInitial("foo.ts", `// nothing\n`);
		stageEdit("foo.ts", `// nothing\nexport default myVar\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), { type: "feat", subject: "x" }),
		).toEqual([]);
	});
});

describe("checkReintroducesRemovedCode", () => {
	it("flags re-introduction of a previously-removed console.log", () => {
		commitInitial("foo.ts", `function a() { console.log("debug-marker-xyz-123"); }\n`);
		// Remove the console.log in a second commit
		writeFileSync(join(repoDir, "foo.ts"), `function a() { return 1; }\n`);
		git(["add", "."]);
		git(["commit", "-q", "-m", "remove-debug"]);
		// Stage a re-introduction
		stageEdit("foo.ts", `function a() { console.log("debug-marker-xyz-123"); return 1; }\n`);
		const results = checkReintroducesRemovedCode(makeSession(["foo.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).name).toBe("reintroduces_removed_code");
	});

	it("does not fire when the line was never previously removed", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit(
			"foo.ts",
			`function a() { console.log("a-fresh-debug-line-here-001"); return 1; }\n`,
		);
		expect(checkReintroducesRemovedCode(makeSession(["foo.ts"]))).toEqual([]);
	});

	it("only inspects loud-marker patterns (skips plain code re-additions)", () => {
		commitInitial("foo.ts", `function helper() { return computeValue(); }\n`);
		writeFileSync(join(repoDir, "foo.ts"), `function helper() { return 1; }\n`);
		git(["add", "."]);
		git(["commit", "-q", "-m", "cleanup"]);
		stageEdit("foo.ts", `function helper() { return computeValue(); }\n`);
		// This is a re-introduction, but no loud marker — check skips it.
		expect(checkReintroducesRemovedCode(makeSession(["foo.ts"]))).toEqual([]);
	});
});

describe("checkDoneWithoutVerify", () => {
	it("flags source edits with no test runs (exact result shape)", () => {
		const session = makeSession(["foo.ts"]);
		const results = checkDoneWithoutVerify(session);
		expect(results).toEqual([
			{
				source: "structural",
				name: "done_without_verify",
				severity: "warning",
				message:
					"Committing 1 source file edit(s) without running any tests in this session. Run the test suite (or the relevant subset) before committing — typecheck and lint don't substitute for running the code.",
				file: "<session>",
				determinism: "fully_deterministic",
			},
		]);
	});

	// PROD_EXTS membership — each extension is a distinct Set entry; a
	// StringLiteral mutation on any single one only breaks that extension.
	it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"])(
		"treats a bare %s file as a source edit needing verification",
		(ext) => {
			const session = makeSession([`foo${ext}`]);
			expect(checkDoneWithoutVerify(session).length).toBe(1);
		},
	);

	it("does not fire when test_runs is non-empty", () => {
		const session = makeSession(["foo.ts"]);
		session.test_runs.set("foo.test.ts", { status: "pass", at_step: 1 });
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire when only test files were edited", () => {
		const session = makeSession(["foo.test.ts"]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire when files_written is empty", () => {
		const session = makeSession([]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire on docs-only / markdown-only commits", () => {
		const session = makeSession(["README.md", "docs/intro.mdx"]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("does not fire on config-only / lockfile-only commits", () => {
		const session = makeSession([
			"package.json",
			"package-lock.json",
			"tsconfig.json",
			".github/workflows/ci.yml",
		]);
		expect(checkDoneWithoutVerify(session)).toEqual([]);
	});

	it("still fires when one source file is mixed with docs", () => {
		const session = makeSession(["README.md", "src/lib/foo.ts"]);
		expect(checkDoneWithoutVerify(session).length).toBe(1);
	});
});

describe("checkTestTimeoutInflation", () => {
	// ── Positive (must fire) ──────────────────────────────────────────────

	it("P1: flags a raised { timeout: N } options-object literal", () => {
		commitInitial(
			"foo.test.ts",
			`it("slow", { timeout: 5000 }, async () => { await work(); });\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("slow", { timeout: 30000 }, async () => { await work(); });\n`,
		);
		const results = checkTestTimeoutInflation(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).name).toBe("test_timeout_inflation");
		expect(nonNull(results[0]).message).toContain("5000ms → 30000ms");
	});

	it("P2: flags a raised it() third-arg timeout (closing `}, N)` shape)", () => {
		commitInitial(
			"foo.test.ts",
			`it("slow", async () => {\n  await work();\n}, 5000);\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("slow", async () => {\n  await work();\n}, 20000);\n`,
		);
		const results = checkTestTimeoutInflation(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toContain("5000ms → 20000ms");
	});

	it("P3: flags a raised vi.setConfig testTimeout", () => {
		commitInitial(
			"foo.test.ts",
			`vi.setConfig({ testTimeout: 5000 });\nit("a", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`vi.setConfig({ testTimeout: 60000 });\nit("a", () => {});\n`,
		);
		const results = checkTestTimeoutInflation(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toContain("5000ms → 60000ms");
		expect(nonNull(results[0]).message).toContain("testTimeout config");
	});

	// ── Negative (must NOT fire) ──────────────────────────────────────────

	it("N1: does not fire when a brand-new test with a timeout is added", () => {
		commitInitial("foo.test.ts", `it("a", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`it("a", () => {});\nit("b", { timeout: 30000 }, async () => { await work(); });\n`,
		);
		expect(checkTestTimeoutInflation(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("N2: does not fire when a timeout is decreased", () => {
		commitInitial(
			"foo.test.ts",
			`it("slow", { timeout: 30000 }, async () => { await work(); });\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("slow", { timeout: 5000 }, async () => { await work(); });\n`,
		);
		expect(checkTestTimeoutInflation(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("N3: does not fire when the timeout is unchanged and other lines move", () => {
		commitInitial(
			"foo.test.ts",
			`it("slow", { timeout: 5000 }, async () => { await work(); });\nit("b", () => {});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("slow", { timeout: 5000 }, async () => { await work(); });\nit("b", () => { expect(1).toBe(1); });\n`,
		);
		expect(checkTestTimeoutInflation(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("N4: does not fire on a timeout in a newly-created test file", () => {
		// Repo needs a HEAD for the diff; create it from an unrelated file.
		commitInitial("other.test.ts", `it("x", () => {});\n`);
		stageEdit(
			"foo.test.ts",
			`it("slow", { timeout: 30000 }, async () => { await work(); });\n`,
		);
		expect(checkTestTimeoutInflation(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	it("N5: does not fire on production source files", () => {
		commitInitial("client.ts", `export const opts = { timeout: 5000 };\n`);
		stageEdit("client.ts", `export const opts = { timeout: 30000 };\n`);
		expect(checkTestTimeoutInflation(makeSession(["client.ts"]))).toEqual([]);
	});

	// Finding (a): removed→added literals must pair by TEST IDENTITY, not by
	// position within a hunk. Deleting one test's timeout and adding a
	// different, larger one in the SAME hunk is not an inflation of an
	// existing test. (Old positional pairing falsely reported 5000→30000.)
	it("N6: does not fire when one test's timeout is deleted and a different, larger one is added in the same hunk", () => {
		commitInitial(
			"foo.test.ts",
			`it("alpha", { timeout: 5000 }, async () => { await work(); });\nit("keep", () => { expect(1).toBe(1); });\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("keep", () => { expect(1).toBe(1); });\nit("beta", { timeout: 30000 }, async () => { await work(); });\n`,
		);
		expect(checkTestTimeoutInflation(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	// Finding (b): only TEST-FRAMEWORK timeouts count. A raised `timeout: N`
	// on an arbitrary options object inside a test body (no it/test/describe
	// call on that line) is not a framework timeout. (Old code matched any
	// `timeout: N` and falsely reported 5000→30000.)
	it("N7: does not fire when a non-framework `timeout: N` object literal is raised inside a test body", () => {
		commitInitial(
			"foo.test.ts",
			`it("fetch", async () => {\n  const client = makeClient({ timeout: 5000 });\n  await client.get();\n});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("fetch", async () => {\n  const client = makeClient({ timeout: 30000 });\n  await client.get();\n});\n`,
		);
		expect(checkTestTimeoutInflation(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	// Finding (b): the `}, N)` third-arg shape must close the TEST callback,
	// not a nested setTimeout/setInterval. (Old code matched any `}, N)` and
	// falsely reported a raised nested-setTimeout delay.)
	it("N8: does not fire when a nested setTimeout delay is raised inside a test", () => {
		commitInitial(
			"foo.test.ts",
			`it("waits", () => {\n  setTimeout(() => {\n    finish();\n  }, 5000);\n});\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("waits", () => {\n  setTimeout(() => {\n    finish();\n  }, 30000);\n});\n`,
		);
		expect(checkTestTimeoutInflation(makeSession(["foo.test.ts"]))).toEqual([]);
	});

	// Finding (b) positive completion: jest.setTimeout(N) is a framework
	// context and a raise must still fire.
	it("P4: flags a raised jest.setTimeout(N) global timeout", () => {
		commitInitial("foo.test.ts", `jest.setTimeout(5000);\nit("a", () => {});\n`);
		stageEdit("foo.test.ts", `jest.setTimeout(60000);\nit("a", () => {});\n`);
		const results = checkTestTimeoutInflation(makeSession(["foo.test.ts"]));
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).message).toContain("5000ms → 60000ms");
		expect(nonNull(results[0]).message).toContain("jest.setTimeout");
	});
});
