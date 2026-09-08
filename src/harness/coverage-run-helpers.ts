// Small pure result-shaping helpers for the coverage runners. Extracted from
// coverage-runner.ts (which sits at the per-file line cap) so that file can keep
// growing behaviour without tripping the cap. Types are imported type-only, so
// there is no runtime import cycle back into coverage-runner.js.

import type { CoverageRunResult, SpawnOutcome } from "./coverage-runner.js";

/** A not-measured result — the red-bar gate fail-opens on it (never blocks on an
 *  unmeasured suite). */
export function failure(suiteMs: number, error: string): CoverageRunResult {
	return { suiteMs, perFile: new Map(), ok: false, error, testsPassed: null };
}

/** Concatenate a spawn's stdout and stderr into one searchable text blob. */
export function spawnText(result: SpawnOutcome): string {
	return `${result.stdout}\n${result.stderr}`;
}

/**
 * Map a suite exit code to the orthogonal pass/fail signal, given the runner's
 * "tests failed" code (1 for both vitest and pytest). Exit 0 → passed; the
 * `failExit` code → failed; null status or any other non-zero (a runner-level
 * error — vitest >1, pytest >=2) → null (couldn't determine ⇒ fail-open).
 */
export function testsPassedFromStatus(status: number | null, failExit: number): boolean | null {
	if (status === 0) return true;
	if (status === failExit) return false;
	return null;
}
