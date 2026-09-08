// ===========================================
// Reconciliation — scoring primitives (mutation-hardening)
// ===========================================
// graph-prediction-reconcile.test.ts exercises scoreListSection / scoreCount
// / scoreRisk only indirectly, through reconcile()'s severity predicates —
// which never pins the exact score/recall/precision/missDetail values these
// functions compute. These cases call the scoring primitives directly and
// assert EXACT return values (via toEqual on the whole object, not just a
// truthy check) so that mutating a branch condition, a filter predicate, an
// arithmetic operator, or a returned literal is observable.
//
// Every case below (plus a randomized fuzz run) was verified against a
// shadow-mutated copy of the real module — see scratch/probes/
// rps-full-mutation-verify.mts and rps-equivalence-fuzz.mts. Two atoms in
// scoreListSection are mutation-EQUIVALENT given the surrounding code and
// are deliberately not targeted here:
//   - `oracleSet.length > 0` inside branch3's and branch4's guard
//     conditions: by the time either guard runs, branch1+branch2 having
//     both failed already PROVES oracleSet.length > 0, so mutating this
//     atom to `true` or `>= 0` cannot change behavior.
//
// The defensive `oracleTopK.length === 0 || predFull.length === 0` zero-guard
// that used to sit right before the recall/precision division was DELETED as
// provably dead (coverage review, 2026-09-05): branches 1-4 are exhaustive
// over every empty-set permutation of (oracleSet, predFull), so neither
// denominator can be zero once control reaches the division. The main-path
// cases below pin the exact score/recall/precision values that division
// produces, so re-introducing an early `{ score: 0, recall: 0, precision: 0 }`
// return there would fail them.

import { describe, expect, it } from "vitest";
import { scoreCount, scoreListSection, scoreRisk } from "../graph-prediction-reconcile-scoring.js";

describe("scoreListSection — abstention detection (isAbstainedList)", () => {
	it("P: null predicted counts as abstained, and an empty oracle set is a perfect score", () => {
		expect(scoreListSection(null, [])).toEqual({
			score: 1,
			recall: 1,
			precision: 1,
			abstained: true,
			missDetail: null,
		});
	});

	it("P: the UNKNOWN_SENTINEL string alone counts as abstained (empty-oracle case)", () => {
		expect(scoreListSection("unknown", [])).toEqual({
			score: 1,
			recall: 1,
			precision: 1,
			abstained: true,
			missDetail: null,
		});
	});

	it("P: the UNKNOWN_SENTINEL string against a nonempty oracle scores the half-credit abstention branch", () => {
		expect(scoreListSection("unknown", ["x", "y"])).toEqual({
			score: 0.5,
			recall: 0,
			precision: 0,
			abstained: true,
			missDetail: { missed: ["x", "y"] },
		});
	});

	it("N: a plain array with no sentinel is NOT abstained", () => {
		expect(scoreListSection(["a", "b"], [])).toEqual({
			score: 0,
			recall: 1,
			precision: 0,
			abstained: false,
			missDetail: { over_predicted: ["a", "b"] },
		});
	});

	it("P: a sentinel value embedded INSIDE the array also counts as abstained, and predictedListAsArray filters it out of the scored set entirely", () => {
		// predicted has 3 entries but the sentinel is dropped before scoring,
		// so a full match against a 2-item oracle still yields recall=1,
		// precision=1 — only the abstention discount (baseScore * 0.7) keeps
		// the final score below 1.
		expect(scoreListSection(["a", "unknown", "b"], ["a", "b"])).toEqual({
			score: 0.7,
			recall: 1,
			precision: 1,
			abstained: true,
			missDetail: null,
		});
	});
});

describe("scoreListSection — the four empty-set early-return branches", () => {
	it("N: empty oracle AND empty predicted scores a bare 1 with no missDetail", () => {
		// Branch1's own `&&`-vs-`||` and single-atom mutants are killed by the
		// abstention-detection cases above (an empty ORACLE alone, or a
		// nonempty one, each holds one operand fixed while the other varies) —
		// this case just pins the "both sides trivially satisfied" shape.
		expect(scoreListSection([], [])).toEqual({
			score: 1,
			recall: 1,
			precision: 1,
			abstained: false,
			missDetail: null,
		});
	});

	it("P: a single plain prediction against an empty oracle is pure over-prediction (precision 0, recall 1)", () => {
		expect(scoreListSection(["a"], [])).toEqual({
			score: 0,
			recall: 1,
			precision: 0,
			abstained: false,
			missDetail: { over_predicted: ["a"] },
		});
	});

	it("P: a nonempty oracle with an empty (not abstained) prediction scores a confident miss — precision 1, recall 0", () => {
		// predicted=[] is a real empty array (not null, not the sentinel), so
		// isAbstainedList([]) is false: this is a *confident* "nothing here"
		// call, distinct from the abstention branch below.
		expect(scoreListSection([], ["x", "y"])).toEqual({
			score: 0,
			recall: 0,
			precision: 1,
			abstained: false,
			missDetail: { missed: ["x", "y"] },
		});
	});

	it("P: a nonempty oracle with an empty AND abstained prediction gets the half-credit branch, not the confident-miss branch", () => {
		// Same missed set as the previous case, but a different score/recall/
		// precision triple — this is what separates the `!abstained` branch
		// from the `abstained` branch (a BooleanLiteral-negation mutant flips
		// which one fires for a given input).
		expect(scoreListSection(null, ["x", "y"])).toEqual({
			score: 0.5,
			recall: 0,
			precision: 0,
			abstained: true,
			missDetail: { missed: ["x", "y"] },
		});
	});
});

describe("scoreListSection — main-scoring recall/precision math and the missDetail ternary", () => {
	it("N: a perfect, non-abstained match scores 1 with no missDetail (both missed and over_predicted are empty)", () => {
		expect(scoreListSection(["a", "b"], ["a", "b"])).toEqual({
			score: 1,
			recall: 1,
			precision: 1,
			abstained: false,
			missDetail: null,
		});
	});

	it("P: an over-predicted extra item drags precision below 1 and recall stays at 1 — Math.min must pick precision, not recall", () => {
		// recall = 2/2 = 1, precision = 2/3. Using Math.max instead of
		// Math.min would report score 1 instead of 2/3.
		expect(scoreListSection(["x", "y", "bogus"], ["x", "y"])).toEqual({
			score: 2 / 3,
			recall: 1,
			precision: 2 / 3,
			abstained: false,
			missDetail: { missed: [], over_predicted: ["bogus"] },
		});
	});

	it("P: a missed oracle item (not over-predicted) drags recall below 1 and precision stays at 1", () => {
		expect(scoreListSection(["a"], ["a", "b"])).toEqual({
			score: 0.5,
			recall: 0.5,
			precision: 1,
			abstained: false,
			missDetail: { missed: ["b"], over_predicted: [] },
		});
	});

	it("P: recall is capped to the lexicographically-sorted first 30 oracle items, and the input oracle array is never mutated in place", () => {
		// 35 oracle items: 30 "m*" items inserted first, then 5 "a*" items.
		// Sorted ascending, the "a*" items land first and all 5 fall inside
		// the top-30 cutoff — but if the cap or the sort is dropped, either
		// the denominator (30 -> 35) or the matched set (the unsorted top 30
		// would be all-"m", matching none of the predicted "a*" items)
		// changes the recall fraction.
		const mItems = Array.from({ length: 30 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`);
		const aItems = ["a01", "a02", "a03", "a04", "a05"];
		const oracleSet = [...mItems, ...aItems];
		const oracleSetSnapshot = [...oracleSet];

		const r = scoreListSection([...aItems], oracleSet);

		expect(r.recall).toBe(5 / 30);
		expect(r.precision).toBe(1);
		expect(r.score).toBe(5 / 30);
		expect(r.missDetail).toEqual({ missed: mItems, over_predicted: [] });
		// `.slice()` before `.sort()` is a defensive copy — sorting must not
		// reorder the caller's own oracleSet array as a side effect.
		expect(oracleSet).toEqual(oracleSetSnapshot);
	});
});

describe("scoreCount — abstention and exact match", () => {
	it("P: the UNKNOWN_SENTINEL predicted value scores the half-credit abstention branch", () => {
		expect(scoreCount("unknown", 7)).toEqual({
			score: 0.5,
			missDetail: { predicted: "unknown", oracle: 7 },
		});
	});

	it("N: an exact numeric match scores 1 with no missDetail, bypassing bucketIndex entirely", () => {
		expect(scoreCount(5, 5)).toEqual({ score: 1.0, missDetail: null });
	});
});

describe("scoreCount — bucketIndex boundaries (buckets: 0 | 1-3 | 4-10 | 10+)", () => {
	// Each pair below pins the exact score AND the exact "(bucket X)" label
	// text, so a boundary mutant (<=  vs  <  vs  >, or a forced true/false)
	// that only shifts ONE side's bucket, or swaps which side gets which
	// label, is caught even when the derived score alone would not change.
	it("P: 0 and 10 are two buckets apart (far) — the `n<=0` and `n<=10` cutoffs both matter", () => {
		expect(scoreCount(0, 10)).toEqual({
			score: 0.0,
			missDetail: { predicted: "0 (bucket 0)", oracle: "10 (bucket 4-10)" },
		});
	});

	it("P: 3 and 11 are two buckets apart (far) — the `n<=3` and `n<=10` cutoffs both matter", () => {
		expect(scoreCount(3, 11)).toEqual({
			score: 0.0,
			missDetail: { predicted: "3 (bucket 1-3)", oracle: "11 (bucket 10+)" },
		});
	});

	it("P: 4 and 7 are both inside the 4-10 bucket (same bucket -> 0.7)", () => {
		expect(scoreCount(4, 7)).toEqual({
			score: 0.7,
			missDetail: { predicted: "4 (bucket 4-10)", oracle: "7 (bucket 4-10)" },
		});
	});

	it("P: 9 and 10 are both inside the 4-10 bucket (same bucket -> 0.7), pinning the n<=10 upper edge", () => {
		expect(scoreCount(9, 10)).toEqual({
			score: 0.7,
			missDetail: { predicted: "9 (bucket 4-10)", oracle: "10 (bucket 4-10)" },
		});
	});

	it("P: 3 (bucket 1-3) and 4 (bucket 4-10) straddle the n<=3 cutoff — adjacent buckets -> 0.4", () => {
		expect(scoreCount(3, 4)).toEqual({
			score: 0.4,
			missDetail: { predicted: "3 (bucket 1-3)", oracle: "4 (bucket 4-10)" },
		});
	});

	it("P: 10 (bucket 4-10) and 11 (bucket 10+) straddle the n<=10 cutoff — adjacent buckets -> 0.4", () => {
		expect(scoreCount(10, 11)).toEqual({
			score: 0.4,
			missDetail: { predicted: "10 (bucket 4-10)", oracle: "11 (bucket 10+)" },
		});
	});

	it("P: 0 (bucket 0) and 1 (bucket 1-3) straddle the n<=0 cutoff — adjacent buckets -> 0.4", () => {
		expect(scoreCount(0, 1)).toEqual({
			score: 0.4,
			missDetail: { predicted: "0 (bucket 0)", oracle: "1 (bucket 1-3)" },
		});
	});

	it("P: 0 and 4 are two buckets apart (far), pinning the n<=0/n<=3 boundary pair together", () => {
		expect(scoreCount(0, 4)).toEqual({
			score: 0.0,
			missDetail: { predicted: "0 (bucket 0)", oracle: "4 (bucket 4-10)" },
		});
	});
});

describe("scoreRisk", () => {
	it("P: the UNKNOWN_SENTINEL predicted value scores the half-credit abstention branch", () => {
		expect(scoreRisk("unknown", "MEDIUM")).toEqual({
			score: 0.5,
			missDetail: { predicted: "unknown", oracle: "MEDIUM" },
		});
	});

	it("N: a matching risk level (after lowercasing the oracle) scores 1 with no missDetail", () => {
		// oracleRisk.toLowerCase() must actually lower-case: swapping in
		// toUpperCase() would compare "high" against "HIGH" and miss.
		expect(scoreRisk("high", "HIGH")).toEqual({ score: 1.0, missDetail: null });
	});

	it("P: a mismatched risk level scores 0, and missDetail carries the RAW predicted/oracle values (not normalized)", () => {
		expect(scoreRisk("low", "HIGH")).toEqual({
			score: 0.0,
			missDetail: { predicted: "low", oracle: "HIGH" },
		});
	});

	it("P: a second mismatch pair, to pin that the exact-match check is not accidentally satisfiable by any mismatched pair", () => {
		expect(scoreRisk("medium", "LOW")).toEqual({
			score: 0.0,
			missDetail: { predicted: "medium", oracle: "LOW" },
		});
	});
});
