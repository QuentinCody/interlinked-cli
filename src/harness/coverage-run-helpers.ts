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

/** Read one string field off a value whose static type promises it but whose
 *  actual origin (test double, partial construction) may not deliver it. */
function stringFieldOr(value: unknown, key: "stdout" | "stderr", fallback: string): string {
	if (typeof value !== "object" || value === null) return fallback;
	// SAFETY: object-ness checked above; the field is read as unknown and
	// type-checked below, so a missing/wrong-typed field can never be trusted.
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : fallback;
}

/** Concatenate a spawn's stdout + stderr into one searchable text blob.
 *  Tolerates a partially-constructed `SpawnOutcome` (missing streams) rather
 *  than trusting the declared type, which every real spawn path fulfills but
 *  a test double is free to omit. */
export function spawnText(result: SpawnOutcome): string {
	return `${stringFieldOr(result, "stdout", "")}\n${stringFieldOr(result, "stderr", "")}`;
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
