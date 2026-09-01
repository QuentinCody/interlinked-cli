// Check Evidence Contract — phase-scaled obligation tiers and verdicts.
//
// Spec: docs/design/verification-density-program.md (Phase 0).
//
// Why tiers instead of one flat "≥3 positive / ≥3 negative": a `pre_block`
// check hard-blocks a write, so a false positive bricks an edit; an advisory
// `post` check firing spuriously inside `--all-checks` costs nothing. A single
// floor either over-burdens the advisory family or under-protects the blocking
// one. The floors below are the pre-branch-data stand-in — Phase 3 replaces the
// `min_positive` / `min_negative` numbers with counts derived from the
// detector's own branch structure, at which point ONE case per direction is
// complete iff it covers the branch.

import type { CheckPhase } from "../check-registry/types.js";
import { describeAdversarialGap } from "./adversarial.js";
import { mutationFloorFor } from "./recall.js";
import type {
	CheckEvidence,
	EvidenceDimension,
	EvidenceVerdict,
	ObligationTier,
} from "./types.js";

/** The four obligation tiers, keyed by `ObligationTier["key"]`. */
export const OBLIGATION_TIERS: Record<ObligationTier["key"], ObligationTier> = {
	pre_block: {
		key: "pre_block",
		label: "PreToolUse block (hard rail)",
		min_positive: 3,
		min_negative: 3,
		min_branch_coverage: 1.0,
		requires_corpus: true,
		requires_mutation: true,
		requires_adversarial: true,
	},
	pre_warn: {
		key: "pre_warn",
		label: "PreToolUse warn (edit-time priming)",
		min_positive: 2,
		min_negative: 2,
		min_branch_coverage: 1.0,
		requires_corpus: true,
		requires_mutation: true,
		requires_adversarial: false,
	},
	post_default: {
		key: "post_default",
		label: "PostToolUse, default gate",
		min_positive: 2,
		min_negative: 2,
		min_branch_coverage: 0.9,
		requires_corpus: true,
		requires_mutation: false,
		requires_adversarial: false,
	},
	post_advisory: {
		key: "post_advisory",
		label: "PostToolUse, advisory (--all-checks only)",
		min_positive: 1,
		min_negative: 1,
		min_branch_coverage: 0.8,
		requires_corpus: false,
		requires_mutation: false,
		requires_adversarial: false,
	},
};

/**
 * Select the obligation tier for a check.
 *
 * `advisoryIds` is the live `DEFAULT_ADVISORY_SKIPS` set — passed in rather
 * than imported so this module stays free of the `commands/` layer (the
 * harness must not depend on CLI command internals) and so tests can drive
 * the advisory split directly.
 */
export function tierFor(phase: CheckPhase, checkId: string, advisoryIds: ReadonlySet<string>): ObligationTier {
	if (phase === "pre_block") return OBLIGATION_TIERS.pre_block;
	if (phase === "pre_warn") return OBLIGATION_TIERS.pre_warn;
	return advisoryIds.has(checkId) ? OBLIGATION_TIERS.post_advisory : OBLIGATION_TIERS.post_default;
}

/** The dimension set in force before any later phase is switched on. */
const DEFAULT_ENFORCED: readonly EvidenceDimension[] = ["cases"];

/** Case-count and test-file shortfalls (the `cases` dimension). */
function caseShortfalls(evidence: CheckEvidence, tier: ObligationTier): string[] {
	if (!evidence.test_file) {
		return [`no companion test file resolved for detector \`${evidence.detector_fn}\``];
	}
	const out: string[] = [];
	if (evidence.positive_count < tier.min_positive) {
		out.push(
			`needs ≥${tier.min_positive} labeled MUST-FIRE case(s), found ${evidence.positive_count}`,
		);
	}
	if (evidence.negative_count < tier.min_negative) {
		out.push(
			`needs ≥${tier.min_negative} labeled MUST-NOT-FIRE case(s), found ${evidence.negative_count}`,
		);
	}
	return out;
}

/** Corpus dogfood shortfalls (the `corpus` dimension). */
function corpusShortfalls(evidence: CheckEvidence, tier: ObligationTier): string[] {
	if (!tier.requires_corpus || evidence.corpus_satisfied) return [];
	if (evidence.unadjudicated_hits > 0) {
		return [
			`${evidence.unadjudicated_hits} corpus hit(s) unadjudicated — mark each true_positive (fix the bug) or false_positive (add a negative case)`,
		];
	}
	return ["no corpus dogfood run recorded — run the detector across the working tree"];
}

/** Inputs for one evidence verdict. */
export interface EvaluateEvidenceInput {
	evidence: CheckEvidence;
	tier: ObligationTier;
	/** Exempt pending backfill — reported but not failing. */
	grandfathered: boolean;
	/** Dimensions allowed to fail the pin. Defaults to `DEFAULT_ENFORCED`. */
	enforced?: readonly EvidenceDimension[];
}

/**
 * Derived-case shortfalls (the `derived_cases` dimension).
 *
 * This is the obligation the flat "3 / 3" was standing in for: total labeled
 * cases must reach the count implied by the detector's OWN branch structure.
 * One case is complete for a single-branch detector; a twelve-branch detector
 * owes twelve.
 */
function derivedCaseShortfalls(evidence: CheckEvidence): string[] {
	const total = evidence.positive_count + evidence.negative_count;
	if (total >= evidence.derived_case_floor) return [];
	const because =
		evidence.detector_cyclomatic === null
			? "its tier floor"
			: `its ${evidence.detector_cyclomatic} branches`;
	return [
		`needs ≥${evidence.derived_case_floor} labeled case(s) total for ${because}, found ${total}`,
	];
}

/** Detector mutation-score shortfalls (the `mutation` dimension). */
function mutationShortfalls(evidence: CheckEvidence, tier: ObligationTier): string[] {
	if (!tier.requires_mutation) return [];
	if (evidence.mutation_score === null) {
		return [
			"no mutation score recorded for the detector — its cases may not distinguish it from a broken version",
		];
	}
	const floor = mutationFloorFor(tier);
	if (evidence.mutation_score >= floor) return [];
	return [
		`detector mutation score ${evidence.mutation_score.toFixed(2)} is below the ${floor.toFixed(2)} floor — surviving mutants mean undetected false negatives`,
	];
}

/** Independent-adversary shortfalls (the `adversarial` dimension). */
function adversarialShortfalls(evidence: CheckEvidence, tier: ObligationTier): string[] {
	if (!tier.requires_adversarial || evidence.adversarial_gap === null) return [];
	return [describeAdversarialGap(evidence.adversarial_gap)];
}

/**
 * Evaluate one evidence record against its tier.
 *
 * `enforced` stages which dimensions can FAIL the pin. Dimensions outside it
 * are still measured and reported by the sweep, they just do not red the
 * suite — landing a phase that fails every check at once teaches the agent to
 * ignore the pin rather than satisfy it.
 */
export function evaluateEvidence({
	evidence,
	tier,
	grandfathered,
	enforced = DEFAULT_ENFORCED,
}: EvaluateEvidenceInput): EvidenceVerdict {
	const active = new Set(enforced);
	const shortfalls: string[] = [];

	if (active.has("cases")) shortfalls.push(...caseShortfalls(evidence, tier));
	if (active.has("corpus")) shortfalls.push(...corpusShortfalls(evidence, tier));
	if (active.has("derived_cases")) shortfalls.push(...derivedCaseShortfalls(evidence));
	if (active.has("mutation")) shortfalls.push(...mutationShortfalls(evidence, tier));
	if (active.has("adversarial")) shortfalls.push(...adversarialShortfalls(evidence, tier));

	return {
		check_id: evidence.check_id,
		tier: tier.key,
		satisfied: shortfalls.length === 0,
		shortfalls,
		grandfathered,
	};
}
