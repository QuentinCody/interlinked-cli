// Check Evidence Contract — types.
//
// One evidence record per registered check id, derived from live sources
// (CHECK_REGISTRY + the filesystem), never hand-maintained. Replaces the
// unenforced "≥3 positive / ≥3 negative cases" prose convention in CLAUDE.md
// with a measured, phase-scaled obligation.
//
// Spec: docs/design/verification-density-program.md (Phase 0).
//
// The core rule the counts serve: every distinguishable behavior of a detector
// needs a case in both directions. A flat count is a proxy for that; the real
// obligation is derived from the detector's own branch structure (Phase 3).
// Until branch data exists, `min_positive` / `min_negative` are the tier's
// stand-in floor — deliberately 1-per-direction at the advisory tier, because
// one case that covers the only branch is COMPLETE, not deficient.

import type { CheckPhase } from "../check-registry/types.js";
import type { AdversarialGap } from "./adversarial.js";

/** Which direction a labeled test case asserts. */
export type CaseDirection = "positive" | "negative";

/** A labeled test case parsed out of a check's companion test file. */
export interface LabeledCase {
	direction: CaseDirection;
	/** Test title (the `it(...)` string). */
	title: string;
	/** 1-based line of the `it(...)` call. */
	line: number;
}

/**
 * Obligation tier for a check, selected by phase + gate membership.
 *
 * `pre_block` hard-blocks a write, so a false positive bricks an edit; an
 * advisory `post` check firing spuriously inside `--all-checks` costs nothing.
 * They must not share a bar.
 */
export interface ObligationTier {
	/** Stable key, used by the pin test and `--json`. */
	key: "pre_block" | "pre_warn" | "post_default" | "post_advisory";
	/** Human label for reports. */
	label: string;
	/** Minimum labeled MUST-FIRE cases. */
	min_positive: number;
	/** Minimum labeled MUST-NOT-FIRE cases. */
	min_negative: number;
	/** Detector branch coverage required, 0..1. Phase 3 enforces; recorded now. */
	min_branch_coverage: number;
	/** Corpus dogfood run required (Phase 2). */
	requires_corpus: boolean;
	/** Detector-level mutation score required (Phase 3). */
	requires_mutation: boolean;
	/** Independent FP-hunting pass required (Phase 4). */
	requires_adversarial: boolean;
}

/** Why a check could not be fully evaluated (missing files, not deficiency). */
export type EvidenceGap =
	| "detector_source_unresolved"
	| "test_file_missing"
	| "no_labeled_cases";

/** The evidence record for one check id. */
export interface CheckEvidence {
	check_id: string;
	phase: CheckPhase;
	/** Detector function name (from `CheckRegistration.fn.name`). */
	detector_fn: string;
	/** Repo-relative path of the file exporting the detector, if resolved. */
	detector_file: string | null;
	/** Repo-relative path of the companion test file, if resolved. */
	test_file: string | null;
	/** Labeled cases found in the test file. */
	cases: LabeledCase[];
	positive_count: number;
	negative_count: number;
	/**
	 * Whether a corpus dogfood run exists with every hit adjudicated. `false`
	 * covers both "never run" and "run, hits unresolved" — the shortfall message
	 * distinguishes them.
	 */
	corpus_satisfied: boolean;
	/** Hits from the corpus run that nobody has adjudicated yet. */
	unadjudicated_hits: number;
	/**
	 * Cyclomatic complexity of the detector function. `null` = UNKNOWN (no AST
	 * available or function not located), never 0 — a missing measurement must
	 * not read as "no branches, so one case suffices".
	 */
	detector_cyclomatic: number | null;
	/** Total labeled cases owed, derived from branch structure and tier. */
	derived_case_floor: number;
	/** Mutation score of the detector's file, or `null` when never measured. */
	mutation_score: number | null;
	/**
	 * Why the independent adversarial pass does not count, or `null` when it
	 * does. Carries the reason (missing / stale / self-review) rather than a
	 * bare boolean so the shortfall can say what to do about it.
	 */
	adversarial_gap: AdversarialGap | null;
	/** Non-fatal reasons the record is incomplete. */
	gaps: EvidenceGap[];
}

/** Verdict for one check against its tier. */
export interface EvidenceVerdict {
	check_id: string;
	tier: ObligationTier["key"];
	/** True when every enforced obligation for the tier is met. */
	satisfied: boolean;
	/** Human-readable unmet obligations; empty when satisfied. */
	shortfalls: string[];
	/** True when the check is grandfathered by the committed baseline. */
	grandfathered: boolean;
}

/**
 * One dimension of evidence the contract can enforce.
 *
 * Enforcement is STAGED: a dimension is recorded for a phase or two before it
 * starts failing the pin, so landing Phase N does not red the suite for every
 * check at once (which would teach the agent to ignore the pin rather than
 * satisfy it). The active set lives in the committed baseline's `enforced`
 * field, and that field may only GROW — adding a dimension is the ratchet.
 */
export type EvidenceDimension =
	| "cases"
	| "corpus"
	| "derived_cases"
	| "mutation"
	| "adversarial";

/** Every dimension, in the order the program phases turn them on. */
export const EVIDENCE_DIMENSIONS: readonly EvidenceDimension[] = [
	"cases",
	"corpus",
	"derived_cases",
	"mutation",
	"adversarial",
];

/** Committed baseline: the shrink-only grandfather list. */
export interface CheckEvidenceBaseline {
    /** Named, reviewed grow-only qualification cohort. */
    corpus_cohort?: string[];
	/**
	 * Check ids exempt from the contract pending backfill. SHRINK-ONLY under
	 * the baseline-integrity gate — this is an exemption list, so removing
	 * entries tightens and adding entries loosens.
	 */
	exempt: string[];
	/**
	 * Dimensions currently failing the pin. Absent = `["cases"]` (the Phase 1
	 * landing state). GROW-ONLY under the baseline-integrity gate: removing a
	 * dimension silently retires an obligation the repo already met.
	 */
	enforced?: EvidenceDimension[];
	/** Free-text note for humans reading the diff. */
	note?: string;
}
