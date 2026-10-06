// THE PIN — Check Evidence Contract enforcement over the live registry.
//
// Spec: docs/design/verification-density-program.md (Phase 1).
//
// This is the test that converts CLAUDE.md's "≥3 positive / ≥3 negative"
// prose into an enforced gate. Before it existed the convention was followed
// by 13 of 100 check test files, because nothing measured it.
//
// Contract:
//   - Every registered check must meet its PHASE-SCALED obligation (a
//     `pre_block` hard rail is held to a stricter bar than an advisory taste
//     check — see obligations.ts for why).
//   - Checks predating the contract are grandfathered by
//     `.interlinked/check-evidence-baseline.json`. That list may only SHRINK.
//   - A NEW check gets no grandfathering: adding a check id to the exempt list
//     fails `no newly-exempted checks` below.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ADVISORY_SKIPS } from "../../commands/verify/advisory.js";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import { loadAdversarialStore } from "./adversarial.js";
import { enforcedDimensions, exemptSet, loadCheckEvidenceBaseline } from "./baseline.js";
import { loadCorpusStore } from "./corpus-scan.js";
import { qualifyCurrentCorpus } from "./corpus-current.js";
import { qualifyCorpusControls } from "./corpus-controls.js";
import { failingVerdicts, staleExemptions, sweepEvidence } from "./extract.js";
import { loadMutationScores } from "./recall.js";
import { buildDetectorIndex } from "./resolve.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const baseline = loadCheckEvidenceBaseline(REPO_ROOT);
const exempt = exemptSet(baseline);

const index = buildDetectorIndex({ searchRoot: resolve(REPO_ROOT, "src"), repoRoot: REPO_ROOT });

/** Detector files that could not be read — asserted empty below, never ignored. */
const unreadableDetectorFiles: string[] = [];

/** Source text of every file that exports a registered detector. */
function loadDetectorSources(): Record<string, string> {
	const wanted = new Set<string>();
	for (const check of CHECK_REGISTRY) {
		const file = index.sourceByFn.get(check.fn.name);
		if (file) wanted.add(file);
	}
	const out: Record<string, string> = {};
	for (const file of wanted) {
		try {
			out[file] = readFileSync(join(REPO_ROOT, file), "utf8");
		} catch (err) {
			unreadableDetectorFiles.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return out;
}

const corpusCohort = new Set(baseline.corpus_cohort ?? []);
const currentCorpus = qualifyCurrentCorpus(REPO_ROOT, [...corpusCohort], CHECK_REGISTRY);
const corpus = { ...loadCorpusStore(REPO_ROOT).checks, ...currentCorpus.records };
const corpusBindings = currentCorpus.bindings;
const sweep = sweepEvidence(
	{
		registry: CHECK_REGISTRY,
		advisoryIds: DEFAULT_ADVISORY_SKIPS,
		index,
		enforced: enforcedDimensions(baseline),
		corpus, corpusCohort, corpusBindings,
		detectorSource: loadDetectorSources(),
		mutationScores: loadMutationScores(REPO_ROOT),
		adversarial: loadAdversarialStore(REPO_ROOT).checks,
	},
	exempt,
);

describe("Check Evidence Contract", () => {
    it("each corpus cohort member has discriminating controls and cannot be grandfathered", () => {
        for (const id of corpusCohort) {
            const check = CHECK_REGISTRY.find(check => check.id === id);
            expect(check, id).toBeDefined();
            if (!check) continue;
            expect(exempt.has(id), id).toBe(false);
            expect(qualifyCorpusControls(check).qualified, id).toBe(true);
        }
    });
	it("every registered check is either compliant or grandfathered", () => {
		const failures = failingVerdicts(sweep.verdicts);
		const detail = failures
			.slice(0, 20)
			.map((v) => `  ${v.check_id} [${v.tier}] — ${v.shortfalls.join("; ")}`)
			.join("\n");
		expect(
			failures,
			failures.length === 0
				? ""
				: `${failures.length} check(s) fail the evidence contract and are not grandfathered.\n` +
					`Add labeled MUST-FIRE / MUST-NOT-FIRE cases to their test files.\n${detail}`,
		).toEqual([]);
	});

	it("the grandfather list only names checks that still need backfill", () => {
		// A stale exemption means the check was fixed but the list was not
		// shrunk — the ratchet only ratchets if fixed checks leave the list.
		const stale = staleExemptions(sweep.verdicts);
		expect(
			stale,
			stale.length === 0
				? ""
				: `${stale.length} exempted check(s) now satisfy the contract. ` +
					`Remove them from .interlinked/check-evidence-baseline.json:\n  ${stale.join("\n  ")}`,
		).toEqual([]);
	});

	it("the grandfather list contains no unknown check ids", () => {
		const known = new Set(CHECK_REGISTRY.map((c) => c.id));
		const unknown = baseline.exempt.filter((id) => !known.has(id));
		expect(
			unknown,
			`exempt list names ${unknown.length} check id(s) that no longer exist: ${unknown.join(", ")}`,
		).toEqual([]);
	});

	it("the grandfather list never grows", () => {
		// Hard ceiling seeded at the Phase 1 landing count. Lower it as checks
		// are backfilled; raising it is the gaming move this pin exists to stop.
		const CEILING = 113;
		expect(
			baseline.exempt.length,
			`grandfather list grew to ${baseline.exempt.length} (ceiling ${CEILING}). ` +
				"New checks must ship with their evidence, not an exemption.",
		).toBeLessThanOrEqual(CEILING);
	});

	it("every check resolves to a detector source file", () => {
		// An unresolvable detector means the evidence record cannot be trusted:
		// the contract would silently pass a check it never located.
		const unresolved = sweep.evidence
			.filter((e) => e.gaps.includes("detector_source_unresolved"))
			.map((e) => `${e.check_id} (${e.detector_fn})`);
		expect(unresolved.length, `unresolved detectors: ${unresolved.join(", ")}`).toBeLessThanOrEqual(4);
	});
});

describe("Check Evidence Contract — recall", () => {
	it("every detector file is readable", () => {
		expect(unreadableDetectorFiles, unreadableDetectorFiles.join("\n")).toEqual([]);
	});

	it("branch complexity is measured for the overwhelming majority of detectors", () => {
		// UNKNOWN complexity silently relaxes the derived floor back to the tier
		// floor, so a rising unknown count quietly weakens the contract.
		const unknown = sweep.evidence.filter((e) => e.detector_cyclomatic === null);
		expect(
			unknown.length,
			`${unknown.length} detector(s) have UNKNOWN branch complexity: ${unknown
				.slice(0, 10)
				.map((e) => e.check_id)
				.join(", ")}`,
		).toBeLessThanOrEqual(30);
	});

	it("the derived floor is never weaker than the tier floor", () => {
		const weaker = sweep.evidence.filter((e) => e.derived_case_floor < 2);
		expect(weaker.map((e) => e.check_id)).toEqual([]);
	});

	it("reports how far the derived-case dimension is from enforceable", () => {
		// Not a gate yet — this records the size of the Phase 3 backlog so
		// turning `derived_cases` on later is a measured decision, not a guess.
		const short = sweep.evidence.filter(
			(e) => e.positive_count + e.negative_count < e.derived_case_floor,
		);
		expect(short.length).toBeLessThanOrEqual(CHECK_REGISTRY.length);
	});
});

describe("Check Evidence Contract — reporting", () => {
	it("reports compliance per tier so the gap stays visible", () => {
		const byTier = new Map<string, { total: number; pass: number }>();
		for (const v of sweep.verdicts) {
			const b = byTier.get(v.tier) ?? { total: 0, pass: 0 };
			b.total++;
			if (v.satisfied) b.pass++;
			byTier.set(v.tier, b);
		}
		// Every tier must be represented — a tier vanishing from the registry
		// would silently shrink the contract's reach.
		expect([...byTier.keys()].sort()).toEqual([
			"post_advisory",
			"post_default",
			"pre_block",
			"pre_warn",
		]);
		for (const [, stats] of byTier) expect(stats.total).toBeGreaterThan(0);
	});
});
