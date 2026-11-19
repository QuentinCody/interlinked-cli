// Check Evidence Contract — build evidence records for every registered check.
//
// Spec: docs/design/verification-density-program.md (Phase 0).
//
// Pure composition over the other modules in this directory: resolve each
// registered check to its detector source + exercising tests, parse labeled
// cases out of those tests, then judge the result against the check's
// phase-scaled tier.

import type { CheckRegistration } from "../check-registry/types.js";
import { type AdversarialSuite, adversarialGap } from "./adversarial.js";
import { type AttributionContext, attributedCasesIn, attributionContext, labeledCasesIn } from "./attribution.js";
import { countCases } from "./case-parser.js";
import { type CorpusRecord, corpusSatisfied, unadjudicatedHits } from "./corpus.js";
import type { CorpusBinding } from "./corpus-provenance.js";
import { evaluateEvidence, tierFor } from "./obligations.js";
import { derivedCaseFloor, detectorCyclomatic } from "./recall.js";
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
    corpusCohort?: ReadonlySet<string>;
    corpusBindings?: Readonly<Record<string, CorpusBinding>>;
	/** Corpus dogfood runs, keyed by check id. Absent = no run recorded. */
	corpus?: Readonly<Record<string, CorpusRecord>>;
	/**
	 * Detector source text keyed by repo-relative file, for branch measurement.
	 * Absent leaves `detector_cyclomatic` UNKNOWN rather than 0.
	 */
	detectorSource?: Readonly<Record<string, string>>;
	/** Independent adversarial / foreign suites, keyed by check id (adversarial.ts). */
	adversarial?: Readonly<Record<string, readonly AdversarialSuite[]>>;
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

/** Gather labeled cases across every test file that exercises a detector (the generous `cases` view). */
function casesAcross(index: DetectorIndex, testFiles: readonly string[], context: AttributionContext): LabeledCase[] {
	const all: LabeledCase[] = [];
	for (const file of testFiles) {
		const source = index.testSource.get(file);
		if (source) all.push(...labeledCasesIn(context, file, source));
	}
	return all;
}

/** The subset of those cases that name this detector (`attribution.ts`). */
function attributedAcross(
	index: DetectorIndex,
	testFiles: readonly string[],
	check: CheckRegistration,
	context: AttributionContext,
): LabeledCase[] {
	const detector = { id: check.id, fn: check.fn.name };
	const all: LabeledCase[] = [];
	for (const file of testFiles) {
		const source = index.testSource.get(file);
		if (source) all.push(...attributedCasesIn(context, file, source, detector));
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
    corpusBinding?: CorpusBinding;
	/** This check's corpus dogfood run, if one is recorded. */
	corpus?: CorpusRecord;
	/** The check's tier, needed to floor the derived case count. */
	tier?: ObligationTier;
	/** Source text of the detector's file, for branch measurement. */
	detectorSource?: string;
	/** Independent adversarial / foreign suites for this check, if any exist. */
	adversarial?: readonly AdversarialSuite[];
	/**
	 * Registry names and the per-file parse memo for case attribution. Absent
	 * (a direct `evidenceFor` call), the registry is taken to be this check alone.
	 */
	attribution?: AttributionContext;
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
	attribution: AttributionContext,
): RecallInputs {
	const detectorFile = index.sourceByFn.get(check.fn.name);
	const source = detectorFile ? input.detectorSource?.[detectorFile] : undefined;
	const corpus = input.corpus?.[check.id];
	return {
		tier,
		attribution,
        ...(input.corpusBindings?.[check.id] ? { corpusBinding: input.corpusBindings[check.id] } : {}),
		...(corpus ? { corpus } : {}),
		...(source ? { detectorSource: source } : {}),
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
	const context = recall.attribution ?? attributionContext([check]);
	const cases = casesAcross(index, testFiles, context);
	const { positive, negative } = countCases(cases);
	const attributed = countCases(attributedAcross(index, testFiles, check, context));
	const { corpus, tier } = recall;
	const cyclomatic = measureCyclomatic(detectorFile, recall.detectorSource, check.fn.name);

	return {
		corpus_satisfied: corpusSatisfied(corpus, recall.corpusBinding),
		unadjudicated_hits: corpus ? unadjudicatedHits(corpus).length : 0,
		detector_cyclomatic: cyclomatic,
		derived_case_floor: tier ? derivedCaseFloor(cyclomatic, tier) : positive + negative,
		adversarial_gap: adversarialGap(recall.adversarial, check.fn.name),
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
		attributed_positive_count: attributed.positive,
		attributed_negative_count: attributed.negative,
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
	const attribution = attributionContext(input.registry);
	const evidence: CheckEvidence[] = [];
	const verdicts: EvidenceVerdict[] = [];

	for (const check of input.registry) {
		const tier = tierFor(check.phase, check.id, input.advisoryIds);
		const record = evidenceFor(index, check, recallInputsFor(index, check, tier, input, attribution));
		evidence.push(record);
		verdicts.push(
			evaluateEvidence({
				evidence: record,
				tier,
				grandfathered: grandfathered.has(check.id),
                enforced: input.corpusCohort?.has(check.id)
                    ? [...new Set([...(input.enforced ?? ["cases"]), "corpus"] as const)]
                    : input.enforced ?? ["cases"],
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
