// Check Evidence Contract — recall: derived case floors and detector mutation.
//
// Spec: docs/design/verification-density-program.md (Phase 3).
//
// This module answers the question the case COUNTS cannot: does the test suite
// actually distinguish this detector from a subtly broken version of itself?
//
// Two measurements, both about false negatives:
//
//   1. DERIVED CASE FLOOR. The flat "3 positive / 3 negative" was always a
//      proxy for "every distinguishable behavior has a case". The detector's
//      own cyclomatic complexity IS that count: a function with N independent
//      paths needs N cases to exercise them. One case is COMPLETE for a
//      single-branch detector; three is negligent for a twelve-branch one.
//      So the floor is read off the code, not declared in prose.
//
//   2. MUTATION SCORE. Branch coverage says a line ran; it does not say an
//      assertion would have noticed if the line were wrong. A surviving mutant
//      in a detector means the cases cannot tell the detector apart from a
//      broken one — the exact blind spot that lets a detector ship catching 5%
//      of its class while looking fully tested. Scores are sourced from the
//      existing mutation system's baseline rather than recomputed here (running
//      mutants is minutes of work, not meta-test work).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import type { ObligationTier } from "./types.js";

/** Where the existing mutation system keeps per-file scores. */
const MUTATION_BASELINE_PATH = ".interlinked/mutation-baseline.json";

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

/** Per-file mutation scores from the existing mutation baseline. */
export type MutationScores = Readonly<Record<string, number>>;

/** Read per-file mutation scores, failing closed to an empty map. */
export function loadMutationScores(repoRoot: string): MutationScores {
	const path = join(repoRoot, MUTATION_BASELINE_PATH);
	if (!existsSync(path)) return {};
	try {
		return parseMutationScores(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

/** Narrow the mutation baseline to a file→score map. */
export function parseMutationScores(raw: unknown): MutationScores {
	if (!raw || typeof raw !== "object") return {};
	const files = (raw as { files?: unknown }).files;
	if (!files || typeof files !== "object") return {};
	const out: Record<string, number> = {};
	for (const [file, value] of Object.entries(files as Record<string, unknown>)) {
		const score = value && typeof value === "object" ? (value as { score?: unknown }).score : undefined;
		if (typeof score === "number" && Number.isFinite(score)) out[file] = score;
	}
	return out;
}

/** Minimum mutation score a detector must reach, by tier. */
export function mutationFloorFor(tier: ObligationTier): number {
	// Mirrors the branch-coverage ladder: a hard rail must be near-fully
	// distinguished from its mutants; an advisory check need not be.
	return tier.requires_mutation ? 0.8 : 0;
}
