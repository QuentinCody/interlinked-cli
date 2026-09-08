import { makeSession as makeSessionFixture, makeEvent as makeEventFixture } from "../__tests__/fixtures/evaluator.js";
import { makeServerRuntime } from "./__tests__/fixtures.js";
// Companion smoke tests for lifecycle-stop-warnings-tdd-cycle-checks.ts.
//
// This module is a pure re-home (line-cap split of lifecycle-stop-warnings.ts,
// 2026-09) — full behavioral coverage of these three checks already lives in
// lifecycle-stop-warnings.test.ts, which imports them indirectly through
// `buildVerificationStopWarnings`. This file exercises each export directly
// so the module has its own standalone evidence, one true and one null path.
// It also owns the whole-suite arm of `collectRedChecks` (the ALL_TESTS_SENTINEL
// run), which the indirect tests never reach in either direction.

import { describe, expect, it, vi } from "vitest";
import { isSuiteSourcedRed } from "../behavioral-checks-tdd-red-evidence.js";
import { collectWipCommitSubjects, formatWipCommitsNudge } from "../commit-cadence.js";
import { ALL_TESTS_SENTINEL } from "../server-tdd-cycle.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { formatTddRegressionWarning, formatUnresolvedRedWarning } from "../verification-stop-checks.js";
import { checkTddRegression, checkUnresolvedRed, checkWipCommits } from "./lifecycle-stop-warnings-tdd-cycle-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

vi.mock("../behavioral-checks-tdd-red-evidence.js", () => ({
	isSuiteSourcedRed: vi.fn(() => false),
}));
vi.mock("../commit-cadence.js", () => ({
	collectWipCommitSubjects: vi.fn(() => []),
	formatWipCommitsNudge: vi.fn(() => null),
}));
vi.mock("../verification-stop-checks.js", () => ({
	formatTddRegressionWarning: vi.fn(() => null),
	formatUnresolvedRedWarning: vi.fn(() => null),
}));

function makeCtx(): ServerRuntime {
	return makeServerRuntime();
}

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return ({ ...makeSessionFixture(),
		tdd_cycles: new Map(),
		observed_checks: new Map(),
		commands_run: [],
		...overrides,
	} satisfies SessionTrajectory);
}

describe("checkTddRegression", () => {
	it("N: returns null and skips the log when no cycle regressed", () => {
		const ctx = makeCtx();
		const session = makeSession();
		expect(checkTddRegression(ctx, session)).toBeNull();
		expect(ctx.log).not.toHaveBeenCalled();
	});

	it("P: surfaces the formatter's warning and logs the regression count", () => {
		const ctx = makeCtx();
		const session = makeSession({
			tdd_cycles: new Map([
				["a", { state: "regression", source_file: "src/a.ts", test_file: null, impl_edits_before_test: 0 }],
			]),
		});
		vi.mocked(formatTddRegressionWarning).mockReturnValueOnce("[interlinked:tdd] regressed");
		expect(checkTddRegression(ctx, session)).toBe("[interlinked:tdd] regressed");
		expect(formatTddRegressionWarning).toHaveBeenCalledWith({
			regressions: [{ sourceFile: "src/a.ts" }],
		});
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("tdd-regression (1)"));
	});

	it("N: excludes a regression whose red is suite-sourced", () => {
		const ctx = makeCtx();
		const session = makeSession({
			tdd_cycles: new Map([
				["a", { state: "regression", source_file: "src/a.ts", test_file: null, impl_edits_before_test: 0 }],
			]),
		});
		vi.mocked(isSuiteSourcedRed).mockReturnValueOnce(true);
		const result = checkTddRegression(ctx, session);
		expect(result).toBeNull();
		expect(formatTddRegressionWarning).toHaveBeenCalledWith({ regressions: [] });
	});
});

describe("checkUnresolvedRed", () => {
	it("N: returns null when nothing is red", () => {
		const ctx = makeCtx();
		expect(checkUnresolvedRed(ctx, makeSession())).toBeNull();
	});

	it("P: collects a red observed check and a stayed-red TDD cycle, logs counts", () => {
		const ctx = makeCtx();
		const session = makeSession({
			observed_checks: new Map([["typecheck", { kind: "typecheck", status: "red" }]]),
			tdd_cycles: new Map([
				["b", { state: "red", source_file: "src/b.ts", red_at: 5, test_file: null, impl_edits_before_test: 0 }],
			]),
		});
		vi.mocked(formatUnresolvedRedWarning).mockReturnValueOnce("[interlinked:red] unresolved");
		expect(checkUnresolvedRed(ctx, session)).toBe("[interlinked:red] unresolved");
		expect(formatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [{ kind: "typecheck", detail: undefined }],
			redTests: [{ sourceFile: "src/b.ts" }],
		});
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining("unresolved-red (1 checks, 1 tests)"),
		);
	});

	// test-contract: public-api — a whole-suite run recorded under
	// ALL_TESTS_SENTINEL has no per-file TDD cycle and no observed_checks
	// entry, so the only way a red full suite reaches the Stop nudge is this
	// synthesized `test-suite` check. Without it the session ends red and
	// silent.
	it("P: synthesizes a test-suite red check when the whole-suite run failed", () => {
		const ctx = makeCtx();
		const session = makeSession({
			test_runs: new Map([[ALL_TESTS_SENTINEL, { status: "fail", at_step: 7 }]]),
		});
		vi.mocked(formatUnresolvedRedWarning).mockReturnValueOnce("[interlinked:red] suite");
		expect(checkUnresolvedRed(ctx, session)).toBe("[interlinked:red] suite");
		expect(formatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [{ kind: "test-suite" }],
			redTests: [],
		});
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining("unresolved-red (1 checks, 0 tests)"),
		);
	});

	// test-contract: invariant — the synthesized entry is a fallback, not an
	// addition: when the observed-check stream already reported the suite red
	// the nudge must keep that richer row (it carries the detail) and must not
	// list the same failure twice.
	it("N: keeps the observed test-suite row instead of adding a second one", () => {
		const ctx = makeCtx();
		const session = makeSession({
			observed_checks: new Map([
				["test-suite", { kind: "test-suite", status: "red", detail: "3 failed" }],
			]),
			test_runs: new Map([[ALL_TESTS_SENTINEL, { status: "fail", at_step: 7 }]]),
		});
		vi.mocked(formatUnresolvedRedWarning).mockReturnValueOnce("[interlinked:red] suite");
		expect(checkUnresolvedRed(ctx, session)).toBe("[interlinked:red] suite");
		expect(formatUnresolvedRedWarning).toHaveBeenCalledWith({
			redChecks: [{ kind: "test-suite", detail: "3 failed" }],
			redTests: [],
		});
		expect(ctx.log).toHaveBeenCalledWith(
			expect.stringContaining("unresolved-red (1 checks, 0 tests)"),
		);
	});

	// test-contract: boundary — a whole-suite run that PASSED must leave the
	// nudge empty; the synthesized row keys on the failure status alone, so
	// this pins that the sentinel's presence is not itself the trigger.
	it("N: adds nothing when the whole-suite run passed", () => {
		const ctx = makeCtx();
		const session = makeSession({
			test_runs: new Map([[ALL_TESTS_SENTINEL, { status: "pass", at_step: 7 }]]),
		});
		expect(checkUnresolvedRed(ctx, session)).toBeNull();
		expect(formatUnresolvedRedWarning).toHaveBeenCalledWith({ redChecks: [], redTests: [] });
	});
});

describe("checkWipCommits", () => {
	function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
		return makeEventFixture({ cwd: "/repo", ...overrides });
	}

	it("N: returns null when the session never recorded a git baseline", () => {
		const ctx = makeCtx();
		expect(checkWipCommits(ctx, makeEvent(), makeSession())).toBeNull();
		expect(collectWipCommitSubjects).not.toHaveBeenCalled();
	});

	it("N: returns null when no command looked like a commit", () => {
		const ctx = makeCtx();
		const session = makeSession({
			git_session_baseline: { head_sha: "abc123", modified: new Set(), staged: new Set(), untracked: new Set() },
			commands_run: ["npm test"],
		});
		expect(checkWipCommits(ctx, makeEvent(), session)).toBeNull();
		expect(collectWipCommitSubjects).not.toHaveBeenCalled();
	});

	it("P: surfaces wip subjects and logs the count", () => {
		const ctx = makeCtx();
		const session = makeSession({
			git_session_baseline: { head_sha: "abc123", modified: new Set(), staged: new Set(), untracked: new Set() },
			commands_run: ["git commit -m wip"],
		});
		vi.mocked(collectWipCommitSubjects).mockReturnValueOnce(["wip: fix"]);
		vi.mocked(formatWipCommitsNudge).mockReturnValueOnce("[interlinked:wip] cleanup");
		expect(checkWipCommits(ctx, makeEvent(), session)).toBe("[interlinked:wip] cleanup");
		expect(collectWipCommitSubjects).toHaveBeenCalledWith("/repo", "abc123");
		expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("wip-commits (1)"));
	});
});
