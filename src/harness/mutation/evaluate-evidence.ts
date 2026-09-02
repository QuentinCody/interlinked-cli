// ===========================================
// Per-edit mutation — the protocol-v2 evidence floor (extracted from
// evaluate.ts, 2026-09-01, for the 500-line cap)
// ===========================================
// Enumerate the evidence a run failed to carry back. Empty = sufficient.
//
// Goal 28 §8: a result may certify clean only when the evidence is present AND
// valid. The gap this closes was the cheapest false clean in the system:
// `testRun` was optional, and an ABSENT one read as "not red", so pointing
// `runner_url` at any mutants-only runner returned every mutant `Killed` —
// because no test ever ran — and the gate allowed the edit and refreshed the
// manifest. One config line, no adversary.
//
// Client-side only: every item here is checkable without a runner protocol
// change, which is why it landed first. Both the live gate (evaluate.ts) and
// the explicit measure/record command consume the same runner response shape;
// keeping these mechanical gaps in one place prevents the out-of-band command
// from silently inventing a weaker definition of "complete" than the gate it
// is supposed to populate.

import type { TestRunResult } from "./types.js";

/** The engine-exit half of the evidence floor (goal 28 §8, "engine exit 0").
 *
 *  A mutation engine that dies partway still leaves a report behind, and that
 *  report's survivors are exactly the ones a forged clean pass would hide — so a
 *  crash reads as CLEANER than a healthy run. Only an explicit 0 certifies;
 *  every other state is the absence of evidence, not evidence of absence.
 *  Returns null when the engine is proven to have finished. */
function engineExitEvidenceGap(exit: number | null | undefined): string | null {
	if (exit === 0) return null;
	// STRICT (operator decision 2026-08-28): absence refuses. `runner_url` is
	// configurable, so an old runner, a proxy, a replay, or a misdeployed Worker
	// can omit the field — "the deployed Worker always sends it" is not a
	// property of the protocol, only of one deployment. For a red-suite
	// response the missing-engine gap IS still computed (missingEvidence runs
	// before decideMeasured's verdict), but the adverse-evidence branch takes
	// precedence over it — correct, because the engine legitimately never ran.
	if (exit === undefined) {
		return "no engine-exit evidence — the runner never reported whether the mutation engine finished, so a crashed engine's partial report is indistinguishable from a complete one";
	}
	if (exit === null) {
		return "engine exit unrecoverable — the runner ran the engine but could not read back its status, so the report cannot be shown to be complete";
	}
	return `engine exited ${exit} — the mutation engine failed, so any report it produced is partial and its survivors cannot be trusted to be the whole set`;
}

/** Public API: the runner-response shape both `runEvidenceGaps` callers pass. */
export interface V2RunEvidenceInput {
	testRun?: TestRunResult | undefined;
	executedTestCount?: number | null | undefined;
	droppedMutants?: number | undefined;
	engineExitCode?: number | null | undefined;
	evidenceGaps?: readonly string[] | undefined;
}

/** A green suite flag without a positive executed-test count can be produced
 *  by a zero-test dry run and must never certify clean. */
export function executedTestEvidenceGap(count: number | null | undefined): string | null {
	if (count === undefined || count === null) {
		return "no executed-test count — a green suite flag does not prove that any test oracle actually ran";
	}
	if (!Number.isSafeInteger(count) || count <= 0) {
		return `executed-test count was ${count} — zero tests executed, so the mutation run cannot certify clean`;
	}
	return null;
}

/**
 * The shared protocol-v2 evidence floor. `executedTestGap` is passed in
 * because the evaluator may waive it under an authenticated no-test policy;
 * every other gap is mechanical.
 */
export function runEvidenceGaps(input: V2RunEvidenceInput, executedTestGap: string | null): string[] {
	const missing: string[] = [...(input.evidenceGaps ?? [])];
	const dropped = input.droppedMutants ?? 0;
	if (dropped > 0) {
		// The second-cheapest false clean, and it needs no adversary: one
		// truncated `location.end` on the SURVIVING mutants makes them vanish
		// while the killed ones remain, so a short census reads as clean.
		missing.push(
			`incomplete census — ${dropped} report row(s) for this file could not be parsed into a mutant, so the run cannot account for what it measured`,
		);
	}
	if (input.testRun === undefined) {
		missing.push(
			"no test-run evidence — the runner returned mutants but never reported whether the suite ran or passed, so every 'killed' verdict is unverified",
		);
	}
	if (executedTestGap !== null) missing.push(executedTestGap);
	const engineGap = engineExitEvidenceGap(input.engineExitCode);
	if (engineGap !== null) missing.push(engineGap);
	return missing;
}

export function v2RunEvidenceGaps(input: V2RunEvidenceInput): string[] {
	return runEvidenceGaps(input, executedTestEvidenceGap(input.executedTestCount));
}
