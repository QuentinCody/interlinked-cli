// Check Evidence Contract — build evidence records for every registered check.
//
// Spec: docs/design/verification-density-program.md (Phase 0).
//
// Pure composition over the other modules in this directory: resolve each
// registered check to its detector source + exercising tests, parse labeled
// cases out of those tests, then judge the result against the check's
// phase-scaled tier.

import type { CheckRegistration } from "../check-registry/types.js";
import { type AdversarialRecord, adversarialGap } from "./adversarial.js";
import { countCases, parseLabeledCases } from "./case-parser.js";
import { type CorpusRecord, corpusSatisfied, unadjudicatedHits } from "./corpus.js";
import { evaluateEvidence, tierFor } from "./obligations.js";
import { derivedCaseFloor, detectorCyclomatic, type MutationScores } from "./recall.js";
import { buildDetectorIndex, type DetectorIndex, type IndexRoots, resolveDetector } from "./resolve.js";
import type {
	CheckEvidence,
	EvidenceDimension,
	EvidenceGap,
	EvidenceVerdict,
	LabeledCase,
	ObligationTier,
} from "./types.js";

/** Inputs for one evidence sweep. */
interface EvidenceSweepInput {
	/** The live check registry (or a subset, in tests). */
	registry: readonly CheckRegistration[];
	/** Live `DEFAULT_ADVISORY_SKIPS` — splits the `post` phase into two tiers. */
	advisoryIds: ReadonlySet<string>;
	/** Prebuilt index, or the roots to build one from. */
	index: DetectorIndex | IndexRoots;
	/**
	 * Dimensions allowed to fail. Omit for the staged default (`cases` only);
	 * later phases widen this via the committed baseline's `enforced` field.
	 */
	enforced?: readonly EvidenceDimension[];
	/** Corpus dogfood runs, keyed by check id. Absent = no run recorded. */
	corpus?: Readonly<Record<string, CorpusRecord>>;
	/**
	 * Detector source text keyed by repo-relative file, for branch measurement.
	 * Absent leaves `detector_cyclomatic` UNKNOWN rather than 0.
	 */
	detectorSource?: Readonly<Record<string, string>>;
	/** Per-file mutation scores from the existing mutation baseline. */
	mutationScores?: MutationScores;
	/** Independent adversarial-pass records, keyed by check id. */
	adversarial?: Readonly<Record<string, AdversarialRecord>>;
}

/** Result of one evidence sweep. */
interface EvidenceSweep {
	evidence: CheckEvidence[];
	verdicts: EvidenceVerdict[];
	index: DetectorIndex;
}

function isIndex(value: DetectorIndex | IndexRoots): value is DetectorIndex {
	return "sourceByFn" in value;
}

/** Gather labeled cases across every test file that exercises a detector. */
function casesAcross(index: DetectorIndex, testFiles: readonly string[]): LabeledCase[] {
	const all: LabeledCase[] = [];
	for (const file of testFiles) {
		const source = index.testSource.get(file);
		if (source) all.push(...parseLabeledCases(source));
	}
	return all;
}

/** Non-fatal reasons a record is incomplete — distinct from failing the contract. */
function gapsFor(detectorFile: string | null, testFiles: readonly string[], caseCount: number): EvidenceGap[] {
	const gaps: EvidenceGap[] = [];
	if (!detectorFile) gaps.push("detector_source_unresolved");
	if (testFiles.length === 0) gaps.push("test_file_missing");
	else if (caseCount === 0) gaps.push("no_labeled_cases");
	return gaps;
}

/** Optional recall inputs — absent ones leave their fields UNKNOWN, not zero. */
interface RecallInputs {
	/** This check's corpus dogfood run, if one is recorded. */
	corpus?: CorpusRecord;
	/** The check's tier, needed to floor the derived case count. */
	tier?: ObligationTier;
	/** Source text of the detector's file, for branch measurement. */
	detectorSource?: string;
	/** Per-file mutation scores from the existing mutation baseline. */
	mutationScores?: MutationScores;
	/** Independent adversarial-pass record for this check, if one exists. */
	adversarial?: AdversarialRecord;
}

/** Branch complexity of the detector, or null when it cannot be measured. */
function measureCyclomatic(
	detectorFile: string | null,
	detectorSource: string | undefined,
	detectorFn: string,
): number | null {
	if (!detectorFile || !detectorSource) return null;
	return detectorCyclomatic(detectorSource, detectorFile, detectorFn);
}

/** Mutation score for the detector's file, or null when never measured. */
function lookupMutationScore(
	detectorFile: string | null,
	scores: MutationScores | undefined,
): number | null {
	if (!detectorFile || !scores) return null;
	return scores[detectorFile] ?? null;
}

/**
 * Assemble the optional recall inputs for one check.
 *
 * Every field is omitted rather than defaulted when its source is absent, so a
 * missing measurement stays UNKNOWN downstream instead of reading as a zero.
 */
function recallInputsFor(
	index: DetectorIndex,
	check: CheckRegistration,
	tier: ObligationTier,
	input: EvidenceSweepInput,
): RecallInputs {
	const detectorFile = index.sourceByFn.get(check.fn.name);
	const source = detectorFile ? input.detectorSource?.[detectorFile] : undefined;
	const corpus = input.corpus?.[check.id];
	return {
		tier,
		...(corpus ? { corpus } : {}),
		...(source ? { detectorSource: source } : {}),
		...(input.mutationScores ? { mutationScores: input.mutationScores } : {}),
		...(input.adversarial?.[check.id] ? { adversarial: input.adversarial[check.id] } : {}),
	};
}

/** Build the evidence record for a single registered check. */
export function evidenceFor(
	index: DetectorIndex,
	check: CheckRegistration,
	recall: RecallInputs = {},
): CheckEvidence {
	const { detectorFile, testFiles } = resolveDetector(index, check.fn.name);
	const cases = casesAcross(index, testFiles);
	const { positive, negative } = countCases(cases);
	const { corpus, tier } = recall;
	const cyclomatic = measureCyclomatic(detectorFile, recall.detectorSource, check.fn.name);

	return {
		corpus_satisfied: corpusSatisfied(corpus),
		unadjudicated_hits: corpus ? unadjudicatedHits(corpus).length : 0,
		detector_cyclomatic: cyclomatic,
		derived_case_floor: tier ? derivedCaseFloor(cyclomatic, tier) : positive + negative,
		mutation_score: lookupMutationScore(detectorFile, recall.mutationScores),
		adversarial_gap: adversarialGap(recall.adversarial, recall.detectorSource),
		check_id: check.id,
		phase: check.phase,
		detector_fn: check.fn.name,
		detector_file: detectorFile,
		// The first exercising test file is the record's canonical location;
		// cases are counted across ALL of them so a shared suite still counts.
		test_file: testFiles[0] ?? null,
		cases,
		positive_count: positive,
		negative_count: negative,
		gaps: gapsFor(detectorFile, testFiles, cases.length),
	};
}

/**
 * Sweep the whole registry.
 *
 * `grandfathered` marks a check as exempt pending backfill; the verdict still
 * reports its shortfalls so the gap stays visible, it just does not fail the pin.
 */
export function sweepEvidence(
	input: EvidenceSweepInput,
	grandfathered: ReadonlySet<string> = new Set(),
): EvidenceSweep {
	const index = isIndex(input.index) ? input.index : buildDetectorIndex(input.index);
	const evidence: CheckEvidence[] = [];
	const verdicts: EvidenceVerdict[] = [];

	for (const check of input.registry) {
		const tier = tierFor(check.phase, check.id, input.advisoryIds);
		const record = evidenceFor(index, check, recallInputsFor(index, check, tier, input));
		evidence.push(record);
		verdicts.push(
			evaluateEvidence({
				evidence: record,
				tier,
				grandfathered: grandfathered.has(check.id),
				...(input.enforced ? { enforced: input.enforced } : {}),
			}),
		);
	}

	return { evidence, verdicts, index };
}

/** Verdicts that fail the pin: unsatisfied AND not grandfathered. */
export function failingVerdicts(verdicts: readonly EvidenceVerdict[]): EvidenceVerdict[] {
	return verdicts.filter((v) => !v.satisfied && !v.grandfathered);
}

/** Grandfather entries that now pass — the list may shrink by exactly these. */
export function staleExemptions(verdicts: readonly EvidenceVerdict[]): string[] {
	return verdicts.filter((v) => v.satisfied && v.grandfathered).map((v) => v.check_id);
}
