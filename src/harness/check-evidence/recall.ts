// Check Evidence Contract — recall: derived case floors.
//
// Spec: docs/design/verification-density-program.md (Phase 3).
//
// This module answers part of the question the case COUNTS cannot: does the
// test suite exercise every distinguishable behavior of the detector?
//
// DERIVED CASE FLOOR. The flat "3 positive / 3 negative" was always a proxy for
// "every distinguishable behavior has a case". The detector's own cyclomatic
// complexity IS that count: a function with N independent paths needs N cases
// to exercise them. One case is COMPLETE for a single-branch detector; three is
// negligent for a twelve-branch one. So the floor is read off the code, not
// declared in prose.
//
// MUTATION FLOOR — REMOVED 2026-11-05. It read per-file scores from
// `.interlinked/mutation-baseline.json`, the report-score ratchet's water-line
// (`interlinked mutation check --update-baseline` writes it from a Stryker
// report). In this repo that file is absent and was never in git, so 0 scores
// loaded and 86 checks carried a shortfall nothing could clear. It is also
// per FILE, and one detector file holds many detectors. The raw
// `.interlinked/mutation-manifest.json` survivor counts are no substitute:
// about 87 % of them were measurement artifact. What would turn the floor back
// on: a committed per-DETECTOR score file, `.interlinked/check-mutation-scores.json`,
// shaped `{ "version": 1, "checks": { "<check_id>": { "score": 0..1, "receipts": ["<kill-proof receipt id>", ...] } } }`,
// where every score is backed by `interlinked tests prove-kill --all-survivors`
// receipts (executed kill / survive verdicts, `src/harness/kill-proof/`) and
// re-checked by `interlinked tests kill-proofs --verify`. With that file in
// place, re-add a reader here, `requires_mutation` on the pre_block / pre_warn
// tiers (types.ts, obligations.ts) and the `mutation` evidence dimension.

import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import type { ObligationTier } from "./types.js";

/**
 * Upper bound on a derived floor.
 *
 * A 40-branch detector does not usefully demand 40 labeled cases; past a point
 * the honest answer is "decompose the detector", which the cyclomatic gate
 * already enforces on its own. The cap keeps the obligation actionable.
 */
export const DERIVED_FLOOR_CAP = 12;

/**
 * Cyclomatic complexity of one named detector function.
 *
 * Returns null when the AST is unavailable (`typescript` is an optional
 * dependency — a `--omit=optional` install has no parser) or the function is
 * not found. Null means UNKNOWN, never zero: a missing measurement must not
 * read as "no branches, so one case suffices".
 */
export function detectorCyclomatic(
	source: string,
	filePath: string,
	detectorFn: string,
): number | null {
	const entries = computeCyclomaticAst(source, filePath);
	if (!entries) return null;
	const match = entries.find((e) => e.name === detectorFn);
	return match ? match.cyclomatic : null;
}

/**
 * Total labeled cases a detector owes, derived from its branch structure.
 *
 * Never falls below the tier's declared minimum: the tier floor encodes risk
 * (a `pre_block` hard rail earns scrutiny a one-branch advisory check does
 * not), while the derived floor encodes structure. The obligation is the
 * stricter of the two.
 */
export function derivedCaseFloor(cyclomatic: number | null, tier: ObligationTier): number {
	const tierFloor = tier.min_positive + tier.min_negative;
	if (cyclomatic === null) return tierFloor;
	return Math.max(tierFloor, Math.min(cyclomatic, DERIVED_FLOOR_CAP));
}
