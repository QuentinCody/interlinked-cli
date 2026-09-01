// ===========================================
// "Did this test actually kill anything?"
// ===========================================
//
// Adding a test is the one edit shape the per-edit gate had nothing to say
// about. The coverage gate can tell you the new test executed some lines. The
// mutation gate refused to look at a test at all (`primaryCodeFile` correctly
// declines to mutate tests), so a test could be added, run green, execute the
// code, and still detect nothing — and every gate would report success.
//
// That is not a hypothetical failure mode; it is the ordinary one. A test that
// calls the code and asserts something weak — a snapshot, a truthiness check, a
// shape assertion — raises coverage without raising the suite's ability to
// notice a defect. `introverted_test` and `assertion_free_test` catch the
// crudest versions statically. This catches the rest empirically: with the new
// test overlaid, did the SUT's survivor count go DOWN?
//
// Deliberately a WARNING, never a block. A test can be worth adding without
// killing a mutant — a regression pin for a bug already covered, a
// documentation case, a boundary the mutators do not model. Blocking would
// force the author to argue with the gate about what tests are for. Saying
// "this killed nothing" is the useful part, and it is a fact.

import { isTestPath } from "../coverage-test-selector.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutantStatus, MutationManifest } from "./types.js";

/**
 * Statuses that count as an UNJUSTIFIED survivor.
 *
 * - `survived` — the suite ran the mutant and did not notice. The core case.
 * - `uncovered` — nothing executed it. A mutant no test reaches is not one any
 *   test caught, so it counts; excluding it would let an untested region read
 *   as clean, which is the reading this gate exists to deny.
 *
 * Everything else is excluded, and each for its own reason: `killed` and
 * `timeout` both mean the suite DID notice; `equivalent` is the reviewed
 * annotation that no test could ever notice, which is precisely what makes a
 * survivor JUSTIFIED; `indeterminate` is a run that could not conclude, and
 * counting an unknown as a survivor would charge the edit for a measurement
 * failure.
 */
const SURVIVING: ReadonlySet<MutantStatus> = new Set<MutantStatus>(["survived", "uncovered"]);

export function isSurvivingStatus(status: MutantStatus): boolean {
	return SURVIVING.has(status);
}

/**
 * Public API — how many survivors the manifest currently records for a file.
 *
 * Returns null when the file has no baseline at all. Null is NOT zero: a file
 * nobody has measured has an unknown survivor count, and reporting "0 -> 12"
 * for its first measurement would charge the edit with every pre-existing
 * survivor in the module — the same first-sighting trap `evaluate.ts` documents
 * and avoids.
 */
export function baselineSurvivorCount(manifest: MutationManifest, file: string): number | null {
	const record = manifest.files[file];
	if (!record) return null;
	let count = 0;
	for (const symbol of Object.values(record)) {
		for (const mutant of Object.values(symbol.mutants)) {
			if (isSurvivingStatus(mutant.status)) count++;
		}
	}
	return count;
}

interface TestEffectInput {
	/** The code file that was measured. */
	file: string;
	/** The test file whose edit triggered this run. */
	testFile: string;
	/** Survivors the manifest recorded before this edit, or null if unmeasured. */
	before: number | null;
	/** Survivors this run measured. */
	after: number;
}

/**
 * Public API — the one line the agent reads after editing a test, or null when
 * there is nothing worth saying.
 *
 * Silent on a first sighting (no baseline): the honest statement there is "we
 * now know this file has N survivors", which the ordinary measured-run warning
 * already carries. Repeating it as a judgment on the test would be a claim
 * about a comparison that was never made.
 */
export function testEditEffectWarning(input: TestEffectInput): string | null {
	if (input.before === null) return null;
	const delta = input.before - input.after;
	if (delta > 0) {
		return `[mutation:test-effect] ${input.testFile} killed ${delta} mutant(s) in ${input.file} (${input.before} → ${input.after} surviving).`;
	}
	if (delta === 0) {
		return (
			`[mutation:test-effect] ${input.testFile} killed NO mutants in ${input.file} — ` +
			`${input.after} survivor(s) before and after. The new test runs, but nothing it asserts ` +
			"would fail if that code were wrong. Assert on the value the code computes, not that it ran."
		);
	}
	// Survivors went UP. The mutant set is keyed to the source, which this edit
	// did not touch, so this is a signal about the RUN, not the test: a flaky or
	// newly-skipped test, or a suite whose scope changed under it.
	return (
		`[mutation:test-effect] ${input.testFile}: survivors in ${input.file} ROSE ${input.before} → ${input.after}. ` +
		"The source did not change, so a test that used to kill those mutants no longer does — " +
		"check for a skipped, renamed, or newly-flaky test."
	);
}

/**
 * Public API — the gate's entry point: the warning for this run, or null.
 *
 * Fires ONLY when the change set is test-only. When the source itself changed,
 * the mutant population changed with it and a before/after survivor count
 * compares two different things — `evaluate.ts`'s new-survivor diff is the
 * right instrument there, and this one would be actively misleading.
 */
export function testEditEffect(
	changedPaths: readonly string[],
	file: string,
	baseManifest: MutationManifest,
	measured: readonly AdaptedMutant[],
): string | null {
	if (changedPaths.length === 0 || !changedPaths.every((p) => isTestPath(p))) return null;
	const testFile = changedPaths.find((p) => isTestPath(p));
	if (testFile === undefined) return null;
	const after = measured.filter((m) => isSurvivingStatus(m.status)).length;
	return testEditEffectWarning({
		file,
		testFile,
		before: baselineSurvivorCount(baseManifest, file),
		after,
	});
}
