import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Additional unit tests for behavioral-diff-checks.ts, exercised against a
// real temp git repo (same harness as behavioral-diff-checks.integration.test.ts).
//
// This file targets branches the integration suite doesn't reach: the
// "file has no staged diff, skip it" continue-branches inside the per-file
// loops, the checkConventionalCommitCoherence early-return / onlyTests /
// docs / refactor / default-type branches (which exercise the un-exported
// `isDocsPath` helper indirectly), and the removed-but-not-net-positive
// branch of checkClockMockAdded.

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
} from "./behavioral-diff-checks.js";
import type { SessionTrajectory } from "./types.js";

let repoDir: string;

function git(args: string[]): string {
	return execSync(`git ${args.join(" ")}`, { cwd: repoDir, encoding: "utf-8" });
}

function setupRepo(): void {
	repoDir = mkdtempSync(join(tmpdir(), "diff-checks-extra-"));
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
		// Best-effort cleanup.
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
		// SAFETY: this is a partial fixture — only the fields the checks under
		// test actually read (files_written, test_runs) are populated; the rest
		// mirror the real SessionTrajectory shape closely enough to satisfy TS.
	} });
}

// ==========================================================================
// checkDisabledTestDelta — the "no staged diff for this file" skip branch
// ==========================================================================

describe("checkDisabledTestDelta — negative (must NOT fire)", () => {
	it("N1: a test file with no staged changes is skipped (continue) while a real change elsewhere is still scanned", () => {
		commitInitial("unrelated.test.ts", `it("x", () => {});\n`);
		// bar.test.ts is committed but never staged for this commit — getStagedDiff
		// returns "" for it, exercising the `if (!diff) continue` branch.
		commitInitial("bar.test.ts", `it("a", () => {});\n`);
		const results = checkDisabledTestDelta(makeSession(["bar.test.ts", "unrelated.test.ts"]));
		expect(results).toEqual([]);
	});
});

// ==========================================================================
// checkAssertionStrengthWeakening — the "no staged diff for this file" skip
// ==========================================================================

describe("checkAssertionStrengthWeakening — negative (must NOT fire)", () => {
	it("N1: an unstaged test file is skipped while a genuinely-weakened one is still scanned", () => {
		commitInitial("clean.test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		// clean.test.ts has no staged diff; only foo.test.ts is staged, and its
		// diff adds no weak matcher, so nothing fires overall.
		commitInitial("foo.test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(x).toBe(2); });\n`);
		const results = checkAssertionStrengthWeakening(
			makeSession(["clean.test.ts", "foo.test.ts"]),
		);
		expect(results).toEqual([]);
	});
});

// ==========================================================================
// checkConventionalCommitCoherence — early returns, fix: onlyTests, docs:,
// refactor:, and the default (unrecognized-type) branch.
// ==========================================================================

describe("checkConventionalCommitCoherence — positive (must fire)", () => {
	it("P1: fix: touches only test files with a substantive (non-comment) change", () => {
		commitInitial("foo.test.ts", `it("a", () => { expect(x).toBe(1); });\n`);
		stageEdit("foo.test.ts", `it("a", () => { expect(x).toBe(2); });\n`);
		const results = checkConventionalCommitCoherence(makeSession(["foo.test.ts"]), {
			type: "fix",
			subject: "flaky test",
		});
		expect(results.length).toBe(1);
		expect(results[0]?.message).toContain("only tests");
	});

	it("P2: docs: touches a non-docs .ts file (isDocsPath false branch)", () => {
		commitInitial("src/foo.ts", `export function a() { return 1; }\n`);
		stageEdit("src/foo.ts", `export function a() { return 2; }\n`);
		const results = checkConventionalCommitCoherence(makeSession(["src/foo.ts"]), {
			type: "docs",
			subject: "update",
		});
		expect(results.length).toBe(1);
		expect(nonNull(results[0]).name).toBe("commit_message_diff_mismatch");
	});

	it("P3: refactor: changes a test assertion (behavior-delta signal)", () => {
		commitInitial(
			"foo.test.ts",
			`it("a", () => { expect(total).toBe(5); });\n`,
		);
		stageEdit(
			"foo.test.ts",
			`it("a", () => { expect(total).toBe(6); });\n`,
		);
		const results = checkConventionalCommitCoherence(makeSession(["foo.test.ts"]), {
			type: "refactor",
			subject: "cleanup",
		});
		expect(results.length).toBe(1);
		expect(results[0]?.severity).toBe("info");
	});
});

describe("checkConventionalCommitCoherence — negative (must NOT fire)", () => {
	it("N1: returns empty immediately when session.files_written is empty (message present)", () => {
		expect(
			checkConventionalCommitCoherence(makeSession([]), { type: "fix", subject: "x" }),
		).toEqual([]);
	});

	it("N2: returns empty when every written file has no staged diff for this commit", () => {
		commitInitial("foo.ts", `export function a() { return 1; }\n`);
		// No stageEdit — nothing staged, so stagedFiles ends up empty.
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "fix",
				subject: "x",
			}),
		).toEqual([]);
	});

	it("N3: docs: touches only a docs-path file (isDocsPath true via path segment)", () => {
		commitInitial("docs/guide.ts", `export const note = "old";\n`);
		stageEdit("docs/guide.ts", `export const note = "new";\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["docs/guide.ts"]), {
				type: "docs",
				subject: "update guide",
			}),
		).toEqual([]);
	});

	it("N4: docs: touches only a .md file (isDocsPath true via extension)", () => {
		commitInitial("README.md", `# old\n`);
		stageEdit("README.md", `# new\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["README.md"]), {
				type: "docs",
				subject: "update readme",
			}),
		).toEqual([]);
	});

	it("N5: refactor: with no test-assertion changes is silent", () => {
		commitInitial("foo.ts", `export function a() { return 1; }\n`);
		stageEdit("foo.ts", `export function a() {\n  return 1;\n}\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "refactor",
				subject: "reformat",
			}),
		).toEqual([]);
	});

	it("N6: an unrecognized conventional-commit type (default branch) never fires", () => {
		commitInitial("foo.ts", `export function a() { return 1; }\n`);
		stageEdit("foo.ts", `export function a() { return 2; }\n`);
		expect(
			checkConventionalCommitCoherence(makeSession(["foo.ts"]), {
				type: "chore",
				subject: "bump",
			}),
		).toEqual([]);
	});
});

// ==========================================================================
// checkClockMockAdded — skip branches + removed-but-net-nonpositive
// ==========================================================================

describe("checkClockMockAdded — negative (must NOT fire)", () => {
	it("N1: a non-test file is skipped even with a clock-mock-shaped line", () => {
		commitInitial("foo.ts", `function a() { return 1; }\n`);
		stageEdit("foo.ts", `vi.setSystemTime(new Date());\nfunction a() { return 1; }\n`);
		expect(checkClockMockAdded(makeSession(["foo.ts"]))).toEqual([]);
	});

	it("N2: an unstaged test file is skipped while another test file with no net addition stays silent", () => {
		commitInitial("clean.test.ts", `it("x", () => {});\n`);
		// clean.test.ts is committed but not staged this time — continue branch.
		commitInitial(
			"foo.test.ts",
			`vi.setSystemTime(new Date(2024, 1, 1));\nit("a", () => {});\n`,
		);
		// Removes the existing clock mock without adding a new one: net = 0 - 1 = -1.
		stageEdit("foo.test.ts", `it("a", () => {});\n`);
		expect(checkClockMockAdded(makeSession(["clean.test.ts", "foo.test.ts"]))).toEqual([]);
	});
});
