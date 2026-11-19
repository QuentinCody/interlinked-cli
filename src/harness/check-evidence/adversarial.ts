// Check Evidence Contract — the independent adversarial pass.
//
// Spec: docs/design/verification-density-program.md (Phase 4).
//
// The detector's author writes the detector AND its negative cases, so both
// come from one mental model and share one blind spot. This dimension records a
// pass whose only job is the opposite of the author's: find code this detector
// wrongly flags. The repo already runs refute-by-default verifiers elsewhere;
// this points that discipline at check authoring, where the blind spot is most
// structural.
//
// Source (2026-11-05): the executed suites under ADVERSARIAL_TEST_DIR, named
// `<check_id>.adversarial.test.ts` (an FP hunt by an agent other than the
// detector's author) or `<check_id>.foreign.test.ts` (confirmed false positives
// from foreign repositories). Until that date this module read a JSON store,
// `.interlinked/check-adversarial.json`, that nothing ever wrote, so 297 / 297
// checks read `missing` while 51 real suites existed.
//
// A check's obligation is met when at least one suite named for its id also
// names its detector function (so the suite exercises THIS detector) and holds
// at least one labeled MUST-NOT-FIRE case (an FP hunt's product is negatives).
// Freshness comes from execution, not from a source hash: every vitest run
// executes the suite, so a detector edit that re-admits a false positive turns
// it red. Limit: the file name claims independence. Nothing here can verify
// that the reviewer is not the detector's author (git authorship is one account).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countCases, parseLabeledCases } from "./case-parser.js";
import { identifiersIn } from "./resolve.js";

/** Repo-relative directory of the independent adversarial / foreign suites. */
export const ADVERSARIAL_TEST_DIR = "src/harness/__tests__/adversarial";

const SUITE_RE = /^(.+)\.(?:adversarial|foreign)\.test\.ts$/;

/** One adversarial suite file and its text. */
export interface AdversarialSuite {
	/** Repo-relative path. */
	file: string;
	source: string;
}

/** Why the adversarial obligation is not met. */
export type AdversarialGap = "missing" | "detector_not_named" | "no_negative_cases";

/** The check id a suite file name declares, or null when the name has no suite shape. */
export function adversarialSuiteCheckId(fileName: string): string | null {
	return SUITE_RE.exec(fileName)?.[1] ?? null;
}

/** Read every suite under `<repoRoot>/ADVERSARIAL_TEST_DIR`, keyed by check id; a missing directory reads as none. */
export function loadAdversarialSuites(repoRoot: string): Record<string, AdversarialSuite[]> {
	const out: Record<string, AdversarialSuite[]> = {};
	let names: string[];
	try {
		names = readdirSync(join(repoRoot, ADVERSARIAL_TEST_DIR)).sort();
	} catch {
		return out;
	}
	for (const name of names) {
		const id = adversarialSuiteCheckId(name);
		if (!id) continue;
		const file = `${ADVERSARIAL_TEST_DIR}/${name}`;
		try {
			(out[id] ??= []).push({ file, source: readFileSync(join(repoRoot, file), "utf8") });
		} catch {
			// An unreadable suite is not evidence; the check reads `missing` unless another suite counts.
		}
	}
	return out;
}

/**
 * Judge a check's adversarial suites. Returns null when the obligation is met,
 * otherwise the reason it is not.
 */
export function adversarialGap(suites: readonly AdversarialSuite[] | undefined, detectorFn: string): AdversarialGap | null {
	if (!suites || suites.length === 0) return "missing";
	const naming = suites.filter((suite) => identifiersIn(suite.source).has(detectorFn));
	if (naming.length === 0) return "detector_not_named";
	const negatives = naming.reduce((sum, suite) => sum + countCases(parseLabeledCases(suite.source)).negative, 0);
	return negatives > 0 ? null : "no_negative_cases";
}

/** Human-readable explanation of a gap, for the pin's failure message. */
export function describeAdversarialGap(gap: AdversarialGap): string {
	switch (gap) {
		case "missing":
			return `no independent adversarial suite in ${ADVERSARIAL_TEST_DIR}/<check_id>.{adversarial,foreign}.test.ts — the detector's author is currently its only adversary`;
		case "detector_not_named":
			return "the adversarial suite named for this check never names its detector function — it does not exercise this detector";
		case "no_negative_cases":
			return "the adversarial suite has no labeled MUST-NOT-FIRE case — an FP hunt must pin the false positives it found";
	}
}
