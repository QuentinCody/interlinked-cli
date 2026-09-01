// ===========================================
// Flake double-run guard (DW test-adoption P0.2)
// ===========================================
// When `per_edit_coverage.flake_check` is on and an edit adds/changes a TEST
// file, the affected scoped suite is run TWICE back-to-back at PostToolUse and
// the two verdicts compared. A pass↔fail flip — or, with both red, a different
// failing-test set — is a NONDETERMINISM (flaky) signal: "a retry-pass is still
// a flake signal" (DW). Warn-only, never blocks (nondeterminism is exactly the
// thing being flagged, so a block would be an unstable gate). Default-off: the
// second run doubles the scoped suite latency on test edits.
//
// Runs at PostToolUse (the edit is already on disk), so no apply-before-disk
// overlay is needed — the two runs execute against the real working tree. The
// comparison is a PURE function of two run results; the orchestration takes an
// injected `runSuite` so both halves are unit-testable without a real suite.

import type { CoverageRunResult } from "../coverage-runner.js";

/** Stable, sorted string-set equality. */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(a);
	return b.every((x) => set.has(x));
}

/** Up to three failing files, `…`-elided beyond that. */
function filesPhrase(files: readonly string[]): string {
	const shown = files.slice(0, 3).join(", ");
	return files.length > 3 ? `${shown}, …` : shown;
}

/**
 * Compare two back-to-back scoped runs and return a `[interlinked:flake]`
 * warning when they DIVERGE, or null when they agree (or divergence can't be
 * judged). Divergence = a pass↔fail flip, or — both red — a different set of
 * failing test files. If either run couldn't establish pass/fail
 * (`testsPassed === null`: runner unavailable / errored) we can't judge flake,
 * so return null (fail-quiet, matching the coverage gate's null-fail-open).
 */
export function flakeDivergence(
	run1: CoverageRunResult,
	run2: CoverageRunResult,
): string | null {
	if (run1.testsPassed === null || run2.testsPassed === null) return null;

	if (run1.testsPassed !== run2.testsPassed) {
		const order = run1.testsPassed ? "passed then FAILED" : "FAILED then passed";
		return (
			`[interlinked:flake] the affected test suite ${order} on two back-to-back runs — ` +
			`a retry-pass is still a flake signal. Fix the nondeterminism (timing, test ordering, ` +
			`shared state, unseeded RNG, real clock) rather than relying on a re-run.`
		);
	}

	if (run1.testsPassed === false) {
		const f1 = run1.failingTestFiles ?? [];
		const f2 = run2.failingTestFiles ?? [];
		if (!sameStringSet(f1, f2)) {
			return (
				`[interlinked:flake] the affected test suite failed BOTH runs but with different ` +
				`failing tests (run 1: ${filesPhrase(f1)}; run 2: ${filesPhrase(f2)}) — a flaky, ` +
				`order- or state-dependent suite. Make the failures deterministic before relying on them.`
			);
		}
	}
	return null;
}

/** Injected dependency: run the scoped affected suite once and return its
 *  result. The wiring supplies a CoverageRunner-backed impl; tests supply a
 *  scripted sequence. */
type RunScopedSuite = () => Promise<CoverageRunResult>;

/**
 * Run the scoped suite twice and return a flake warning (or null). The first
 * run's `testsPassed === null` short-circuits BEFORE the second run — if we
 * can't establish a verdict once, a second run buys nothing and we skip the
 * cost. Never throws: a rejected run resolves to no-warning (warn-only guard
 * must not break the PostToolUse response).
 */
export async function runFlakeDoubleCheck(runSuite: RunScopedSuite): Promise<string | null> {
	try {
		const run1 = await runSuite();
		if (run1.testsPassed === null || !run1.ok) return null;
		const run2 = await runSuite();
		return flakeDivergence(run1, run2);
	} catch {
		return null;
	}
}
