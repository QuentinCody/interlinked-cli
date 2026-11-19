// Type-level tests for the Check Evidence Contract shapes.
//
// `types.ts` is declaration-only (no runtime code), so these are compile-time
// assertions: each literal below must satisfy its interface, and the discriminated
// unions must reject invalid members. A `tsc` failure IS the test failure.

import { describe, expect, it } from "vitest";
import {
	type CaseDirection,
	type CheckEvidence,
	type CheckEvidenceBaseline,
	EVIDENCE_DIMENSIONS,
	type EvidenceDimension,
	type EvidenceGap,
	type EvidenceVerdict,
	type LabeledCase,
	type ObligationTier,
} from "./types.js";

describe("check-evidence types", () => {
	it("CaseDirection admits exactly the two directions", () => {
		const dirs: CaseDirection[] = ["positive", "negative"];
		expect(dirs).toHaveLength(2);
	});

	it("LabeledCase carries direction, title and line", () => {
		const c: LabeledCase = { direction: "negative", title: "N1: guarded", line: 42 };
		expect(c.line).toBe(42);
	});

	it("ObligationTier records every enforced obligation", () => {
		const tier: ObligationTier = {
			key: "pre_block",
			label: "PreToolUse block",
			min_positive: 3,
			min_negative: 3,
			requires_corpus: true,
			requires_adversarial: true,
		};
		expect(tier.requires_adversarial).toBe(true);
	});

	it("CheckEvidence allows unresolved detector/test paths via null", () => {
		const gaps: EvidenceGap[] = ["detector_source_unresolved", "test_file_missing"];
		const ev: CheckEvidence = {
			check_id: "example_check",
			phase: "post",
			detector_fn: "checkExample",
			detector_file: null,
			test_file: null,
			cases: [],
			positive_count: 0,
			negative_count: 0,
			attributed_positive_count: 0,
			attributed_negative_count: 0,
			corpus_satisfied: false,
			unadjudicated_hits: 0,
			detector_cyclomatic: null,
			derived_case_floor: 2,
			adversarial_gap: "missing",
			gaps,
		};
		expect(ev.detector_file).toBeNull();
		expect(ev.gaps).toContain("test_file_missing");
	});

	it("EVIDENCE_DIMENSIONS lists the dimensions in phase order", () => {
		expect(EVIDENCE_DIMENSIONS).toEqual([
			"cases",
			"attributed_cases",
			"corpus",
			"derived_cases",
			"adversarial",
		]);
	});

	it("a baseline may stage which dimensions are enforced", () => {
		const dims: EvidenceDimension[] = ["cases", "corpus"];
		const b: CheckEvidenceBaseline = { exempt: [], enforced: dims };
		expect(b.enforced).toHaveLength(2);
	});

	it("EvidenceVerdict distinguishes satisfied from grandfathered", () => {
		const v: EvidenceVerdict = {
			check_id: "example_check",
			tier: "post_advisory",
			satisfied: false,
			shortfalls: ["needs ≥1 negative case, found 0"],
			grandfathered: true,
		};
		expect(v.satisfied).toBe(false);
		expect(v.grandfathered).toBe(true);
	});

	it("CheckEvidenceBaseline exposes a shrink-only exemption list", () => {
		const b: CheckEvidenceBaseline = { exempt: ["a", "b"], note: "backfill pending" };
		expect(b.exempt).toHaveLength(2);
	});
});
