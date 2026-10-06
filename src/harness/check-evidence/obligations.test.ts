// Tests for phase-scaled obligation tiers and evidence verdicts.

import { describe, expect, it } from "vitest";
import type { CheckPhase } from "../check-registry/types.js";
import { evaluateEvidence, OBLIGATION_TIERS, tierFor } from "./obligations.js";
import type { CheckEvidence, EvidenceDimension, ObligationTier } from "./types.js";

const ADVISORY = new Set(["taste_check", "magic_literal_in_conditional"]);

function evidence(over: Partial<CheckEvidence> = {}): CheckEvidence {
	return {
		check_id: "example_check",
		phase: "post",
		detector_fn: "checkExample",
		detector_file: "src/harness/checks/example.ts",
		test_file: "src/harness/checks/example.test.ts",
		cases: [],
		positive_count: 3,
		negative_count: 3,
		corpus_satisfied: true,
		unadjudicated_hits: 0,
		detector_cyclomatic: 4,
		derived_case_floor: 4,
		mutation_score: 0.9,
		adversarial_gap: null,
		gaps: [],
		...over,
	};
}

/** Positional-free wrapper so the tests read as (evidence, tier, grandfathered). */
function judge(
	ev: CheckEvidence,
	tier: ObligationTier,
	grandfathered = false,
	enforced?: readonly EvidenceDimension[],
) {
	return evaluateEvidence({
		evidence: ev,
		tier,
		grandfathered,
		...(enforced ? { enforced } : {}),
	});
}

describe("tierFor", () => {
	it("routes pre_block to the strictest tier", () => {
		expect(tierFor("pre_block", "anything", ADVISORY).key).toBe("pre_block");
	});

	it("routes pre_warn to its own tier regardless of advisory membership", () => {
		expect(tierFor("pre_warn", "taste_check", ADVISORY).key).toBe("pre_warn");
	});

	it("splits post by advisory membership", () => {
		expect(tierFor("post", "taste_check", ADVISORY).key).toBe("post_advisory");
		expect(tierFor("post", "nan_coercion_guard", ADVISORY).key).toBe("post_default");
	});

	it("treats an empty advisory set as all-default", () => {
		expect(tierFor("post", "taste_check", new Set()).key).toBe("post_default");
	});

	it("covers every declared phase", () => {
		const phases: CheckPhase[] = ["pre_block", "pre_warn", "post"];
		for (const p of phases) {
			expect(tierFor(p, "x", ADVISORY)).toBeDefined();
		}
	});
});

describe("OBLIGATION_TIERS ordering", () => {
	it("is monotonically stricter from advisory up to pre_block", () => {
		const order: ObligationTier["key"][] = [
			"post_advisory",
			"post_default",
			"pre_warn",
			"pre_block",
		];
		for (let i = 1; i < order.length; i++) {
			const prev = OBLIGATION_TIERS[order[i - 1]!]!;
			const cur = OBLIGATION_TIERS[order[i]!]!;
			expect(cur.min_positive).toBeGreaterThanOrEqual(prev.min_positive);
			expect(cur.min_negative).toBeGreaterThanOrEqual(prev.min_negative);
			expect(cur.min_branch_coverage).toBeGreaterThanOrEqual(prev.min_branch_coverage);
		}
	});

	it("requires an independent adversarial pass only for pre_block", () => {
		expect(OBLIGATION_TIERS.pre_block.requires_adversarial).toBe(true);
		expect(OBLIGATION_TIERS.pre_warn.requires_adversarial).toBe(false);
		expect(OBLIGATION_TIERS.post_default.requires_adversarial).toBe(false);
		expect(OBLIGATION_TIERS.post_advisory.requires_adversarial).toBe(false);
	});

	it("lets a single case per direction satisfy the advisory tier", () => {
		// The point of replacing the flat "3": one case that covers the only
		// branch is complete, not deficient.
		expect(OBLIGATION_TIERS.post_advisory.min_positive).toBe(1);
		expect(OBLIGATION_TIERS.post_advisory.min_negative).toBe(1);
	});
});

describe("evaluateEvidence", () => {
	it("passes a fully-evidenced check", () => {
		const v = judge(evidence(), OBLIGATION_TIERS.pre_block, false);
		expect(v.satisfied).toBe(true);
		expect(v.shortfalls).toEqual([]);
	});

	it("reports a missing test file as the only shortfall", () => {
		const v = judge(evidence({ test_file: null, positive_count: 0, negative_count: 0 }),
			OBLIGATION_TIERS.post_default,
			false,
		);
		expect(v.satisfied).toBe(false);
		expect(v.shortfalls).toHaveLength(1);
		expect(v.shortfalls[0]).toMatch(/no companion test file/);
	});

	it("reports missing negatives independently of positives", () => {
		const v = judge(evidence({ positive_count: 5, negative_count: 0 }),
			OBLIGATION_TIERS.post_default,
			false,
		);
		expect(v.satisfied).toBe(false);
		expect(v.shortfalls).toHaveLength(1);
		expect(v.shortfalls[0]).toMatch(/MUST-NOT-FIRE/);
	});

	it("reports both directions when both are short", () => {
		const v = judge(evidence({ positive_count: 0, negative_count: 0 }),
			OBLIGATION_TIERS.pre_block,
			false,
		);
		expect(v.shortfalls).toHaveLength(2);
	});

	it("does not enforce later-phase obligations yet", () => {
		// corpus / mutation / adversarial are recorded on the tier but must not
		// appear as shortfalls until their phases land.
		const v = judge(evidence(), OBLIGATION_TIERS.pre_block, false);
		expect(v.shortfalls.join(" ")).not.toMatch(/corpus|mutation|adversarial/i);
	});

	it("carries the grandfathered flag through without changing satisfaction", () => {
		const v = judge(evidence({ positive_count: 0, negative_count: 0 }),
			OBLIGATION_TIERS.pre_block,
			true,
		);
		expect(v.grandfathered).toBe(true);
		expect(v.satisfied).toBe(false);
	});

	it("scales the same evidence differently by tier", () => {
		const ev = evidence({ positive_count: 1, negative_count: 1 });
		expect(judge(ev, OBLIGATION_TIERS.post_advisory, false).satisfied).toBe(true);
		expect(judge(ev, OBLIGATION_TIERS.pre_block, false).satisfied).toBe(false);
	});
});

describe("evaluateEvidence — staged dimensions", () => {
	const WITH_CORPUS: readonly EvidenceDimension[] = ["cases", "corpus"];

	it("P1: fails a missing corpus run once corpus is enforced", () => {
		const ev = evidence({ corpus_satisfied: false });
		const v = judge(ev, OBLIGATION_TIERS.pre_block, false, WITH_CORPUS);
		expect(v.satisfied).toBe(false);
		expect(v.shortfalls[0]).toMatch(/no current complete corpus evidence/);
	});

	it("P2: names the unadjudicated-hit count when a run exists but is unresolved", () => {
		const ev = evidence({ corpus_satisfied: false, unadjudicated_hits: 7 });
		const v = judge(ev, OBLIGATION_TIERS.pre_block, false, WITH_CORPUS);
		expect(v.shortfalls[0]).toMatch(/7 corpus hit\(s\) unadjudicated/);
	});

	it("N1: does not fail a missing corpus run while corpus is unenforced", () => {
		const ev = evidence({ corpus_satisfied: false, unadjudicated_hits: 7 });
		expect(judge(ev, OBLIGATION_TIERS.pre_block, false).satisfied).toBe(true);
	});

	it("N2: does not demand a corpus run from a tier that does not require one", () => {
		const ev = evidence({ corpus_satisfied: false, positive_count: 1, negative_count: 1 });
		expect(judge(ev, OBLIGATION_TIERS.post_advisory, false, WITH_CORPUS).satisfied).toBe(true);
	});

	it("N3: accepts a clean zero-hit corpus run", () => {
		const ev = evidence({ corpus_satisfied: true, unadjudicated_hits: 0 });
		expect(judge(ev, OBLIGATION_TIERS.pre_block, false, WITH_CORPUS).satisfied).toBe(true);
	});

	it("N4: an empty enforced set fails nothing", () => {
		const ev = evidence({ test_file: null, positive_count: 0, negative_count: 0, corpus_satisfied: false });
		expect(judge(ev, OBLIGATION_TIERS.pre_block, false, []).satisfied).toBe(true);
	});

	it("reports case and corpus shortfalls together", () => {
		const ev = evidence({ positive_count: 0, negative_count: 0, corpus_satisfied: false });
		const v = judge(ev, OBLIGATION_TIERS.pre_block, false, WITH_CORPUS);
		expect(v.shortfalls).toHaveLength(3);
	});
});

describe("evaluateEvidence — derived_cases dimension", () => {
	const DERIVED: readonly EvidenceDimension[] = ["derived_cases"];

	it("P1: fails a branchy detector with too few total cases", () => {
		const ev = evidence({ positive_count: 2, negative_count: 1, detector_cyclomatic: 9, derived_case_floor: 9 });
		const v = judge(ev, OBLIGATION_TIERS.post_advisory, false, DERIVED);
		expect(v.satisfied).toBe(false);
		expect(v.shortfalls[0]).toMatch(/≥9 labeled case\(s\).*9 branches.*found 3/);
	});

	it("P2: counts both directions toward the derived floor", () => {
		const ev = evidence({ positive_count: 3, negative_count: 3, derived_case_floor: 6 });
		expect(judge(ev, OBLIGATION_TIERS.post_advisory, false, DERIVED).satisfied).toBe(true);
	});

	it("N1: a one-branch detector satisfied by its tier floor passes", () => {
		const ev = evidence({ positive_count: 1, negative_count: 1, detector_cyclomatic: 1, derived_case_floor: 2 });
		expect(judge(ev, OBLIGATION_TIERS.post_advisory, false, DERIVED).satisfied).toBe(true);
	});

	it("N2: an UNKNOWN complexity is reported as a tier floor, not as branches", () => {
		const ev = evidence({ positive_count: 0, negative_count: 0, detector_cyclomatic: null, derived_case_floor: 2 });
		expect(judge(ev, OBLIGATION_TIERS.post_advisory, false, DERIVED).shortfalls[0]).toMatch(/tier floor/);
	});

	it("N3: unenforced, it never fails", () => {
		const ev = evidence({ positive_count: 0, negative_count: 0, derived_case_floor: 99 });
		expect(judge(ev, OBLIGATION_TIERS.post_advisory, false, ["cases"]).shortfalls.join(" ")).not.toMatch(/branches/);
	});
});

describe("evaluateEvidence — adversarial dimension", () => {
	const ADV: readonly EvidenceDimension[] = ["adversarial"];

	it("P1: fails a pre_block check with no recorded pass", () => {
		const v = judge(evidence({ adversarial_gap: "missing" }), OBLIGATION_TIERS.pre_block, false, ADV);
		expect(v.satisfied).toBe(false);
		expect(v.shortfalls[0]).toMatch(/only adversary/);
	});

	it("P2: fails a pass whose source has since changed", () => {
		const v = judge(evidence({ adversarial_gap: "stale_source" }), OBLIGATION_TIERS.pre_block, false, ADV);
		expect(v.shortfalls[0]).toMatch(/older version/);
	});

	it("P3: fails a self-review", () => {
		const v = judge(evidence({ adversarial_gap: "self_review" }), OBLIGATION_TIERS.pre_block, false, ADV);
		expect(v.shortfalls[0]).toMatch(/independent/);
	});

	it("N1: passes when the gap is null", () => {
		expect(judge(evidence({ adversarial_gap: null }), OBLIGATION_TIERS.pre_block, false, ADV).satisfied).toBe(true);
	});

	it("N2: tiers that do not require an adversary are unaffected", () => {
		const ev = evidence({ adversarial_gap: "missing" });
		expect(judge(ev, OBLIGATION_TIERS.pre_warn, false, ADV).satisfied).toBe(true);
		expect(judge(ev, OBLIGATION_TIERS.post_default, false, ADV).satisfied).toBe(true);
	});

	it("N3: unenforced, a missing pass never fails", () => {
		expect(judge(evidence({ adversarial_gap: "missing" }), OBLIGATION_TIERS.pre_block, false, ["cases"]).satisfied).toBe(true);
	});
});

describe("evaluateEvidence — mutation dimension", () => {
	const MUT: readonly EvidenceDimension[] = ["mutation"];

	it("P1: fails a detector with no recorded mutation score", () => {
		const ev = evidence({ mutation_score: null });
		const v = judge(ev, OBLIGATION_TIERS.pre_block, false, MUT);
		expect(v.satisfied).toBe(false);
		expect(v.shortfalls[0]).toMatch(/no mutation score/);
	});

	it("P2: fails a score below the floor and names the surviving-mutant risk", () => {
		const ev = evidence({ mutation_score: 0.4 });
		const v = judge(ev, OBLIGATION_TIERS.pre_block, false, MUT);
		expect(v.shortfalls[0]).toMatch(/0\.40 is below the 0\.80 floor/);
		expect(v.shortfalls[0]).toMatch(/false negatives/);
	});

	it("N1: passes a score at or above the floor", () => {
		expect(judge(evidence({ mutation_score: 0.8 }), OBLIGATION_TIERS.pre_block, false, MUT).satisfied).toBe(true);
	});

	it("N2: tiers that do not require mutation are unaffected by a missing score", () => {
		const ev = evidence({ mutation_score: null });
		expect(judge(ev, OBLIGATION_TIERS.post_default, false, MUT).satisfied).toBe(true);
	});

	it("N3: unenforced, a missing score never fails", () => {
		expect(judge(evidence({ mutation_score: null }), OBLIGATION_TIERS.pre_block, false, ["cases"]).satisfied).toBe(true);
	});
});
