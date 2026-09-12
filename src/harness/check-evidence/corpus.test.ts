// Tests for corpus dogfood records.

import { describe, expect, it } from "vitest";
import {
	buildCorpusRecord,
	type CorpusHit,
	type CorpusRecord,
	corpusSatisfied,
	EMPTY_CORPUS,
	falsePositiveSignatures,
	hitSignature,
	parseCorpusStore,
	staleAdjudications,
	unadjudicatedHits,
} from "./corpus.js";

const HIT_A: CorpusHit = { file: "src/a.ts", line: 10, text: "  if (Date.parse(x) < now) {" };
const HIT_B: CorpusHit = { file: "src/b.ts", line: 3, text: "const n = Number(raw);" };

/** Same hit at a different line — signatures must be line-independent. */
const HIT_A_MOVED: CorpusHit = { ...HIT_A, line: 999 };

function record(over: Partial<CorpusRecord> = {}): CorpusRecord {
	return { files_scanned: 100, hits: [], adjudications: {}, ...over };
}

describe("hitSignature", () => {
	it("is stable for the same file and text", () => {
		expect(hitSignature(HIT_A)).toBe(hitSignature(HIT_A_MOVED));
	});

	it("ignores leading/trailing and collapsed whitespace", () => {
		expect(hitSignature(HIT_A)).toBe(hitSignature({ ...HIT_A, text: "if (Date.parse(x)   < now) {" }));
	});

	it("differs across files with identical text", () => {
		expect(hitSignature(HIT_A)).not.toBe(hitSignature({ ...HIT_A, file: "src/z.ts" }));
	});

	it("differs across different text in the same file", () => {
		expect(hitSignature(HIT_A)).not.toBe(hitSignature({ file: "src/a.ts", text: "other" }));
	});
});

describe("buildCorpusRecord", () => {
	it("records one signature per distinct hit", () => {
		const r = buildCorpusRecord([HIT_A, HIT_B], 50);
		expect(r.hits).toHaveLength(2);
		expect(r.files_scanned).toBe(50);
	});

	it("deduplicates identical hits", () => {
		expect(buildCorpusRecord([HIT_A, { ...HIT_A, line: 77 }], 50).hits).toHaveLength(1);
	});

	it("starts with no adjudications when there is no prior record", () => {
		expect(buildCorpusRecord([HIT_A], 50).adjudications).toEqual({});
	});

	it("preserves a prior verdict across a re-scan", () => {
		const sig = hitSignature(HIT_A);
		const prior = record({ hits: [sig], adjudications: { [sig]: { verdict: "false_positive", note: "guarded" } } });
		const next = buildCorpusRecord([HIT_A], 60, prior);
		expect(next.adjudications[sig]?.verdict).toBe("false_positive");
	});

	it("drops a prior verdict whose hit no longer occurs", () => {
		const goneSig = hitSignature(HIT_B);
		const prior = record({ hits: [goneSig], adjudications: { [goneSig]: { verdict: "true_positive" } } });
		expect(buildCorpusRecord([HIT_A], 60, prior).adjudications).toEqual({});
	});

	it("records an empty hit list for a clean scan", () => {
		const r = buildCorpusRecord([], 791);
		expect(r.hits).toEqual([]);
		expect(r.files_scanned).toBe(791);
	});
});

describe("unadjudicatedHits / corpusSatisfied", () => {
	it.each([0, -1, 0.5, NaN, Infinity])("does not certify a scan without a valid positive file count: %s", (files_scanned) => {
		expect(corpusSatisfied(buildCorpusRecord([], files_scanned))).toBe(false);
	});

	it("reports a hit with no verdict", () => {
		const r = record({ hits: ["abc"] });
		expect(unadjudicatedHits(r)).toEqual(["abc"]);
		expect(corpusSatisfied(r)).toBe(false);
	});

	it("is satisfied when every hit is adjudicated", () => {
		const r = record({ hits: ["abc"], adjudications: { abc: { verdict: "true_positive" } } });
		expect(unadjudicatedHits(r)).toEqual([]);
		expect(corpusSatisfied(r)).toBe(true);
	});

	it("is satisfied by a clean zero-hit scan", () => {
		// Zero hits clears THIS obligation; recall is Phase 3's question.
		expect(corpusSatisfied(record({ hits: [] }))).toBe(true);
	});

	it("is not satisfied when no run has been recorded at all", () => {
		expect(corpusSatisfied(undefined)).toBe(false);
	});
});

describe("falsePositiveSignatures / staleAdjudications", () => {
	it("lists only false-positive verdicts", () => {
		const r = record({
			hits: ["a", "b"],
			adjudications: { a: { verdict: "false_positive" }, b: { verdict: "true_positive" } },
		});
		expect(falsePositiveSignatures(r)).toEqual(["a"]);
	});

	it("flags verdicts whose hit is gone", () => {
		const r = record({ hits: ["a"], adjudications: { a: { verdict: "true_positive" }, old: { verdict: "false_positive" } } });
		expect(staleAdjudications(r)).toEqual(["old"]);
	});

	it("reports nothing stale when hits and verdicts align", () => {
		expect(staleAdjudications(record({ hits: ["a"], adjudications: { a: { verdict: "true_positive" } } }))).toEqual([]);
	});
});

describe("parseCorpusStore", () => {
	it.each([undefined, null, "invalid", [7], ["reviewed", null]])("does not turn malformed hits into a satisfied corpus obligation: %j", (hits) => {
		const store = parseCorpusStore({ checks: {
			bad: { files_scanned: 5, hits, adjudications: { reviewed: { verdict: "true_positive" } } },
			good: { files_scanned: 5, hits: [], adjudications: {} },
		} });
		expect(corpusSatisfied(store.checks.bad)).toBe(false);
		expect(store.checks.bad).toBeUndefined();
		expect(corpusSatisfied(store.checks.good)).toBe(true);
	});

	it("reads a well-formed store", () => {
		const store = parseCorpusStore({
			version: 1,
			checks: { my_check: { files_scanned: 5, hits: ["a"], adjudications: { a: { verdict: "true_positive", note: "bug" } } } },
		});
		expect(store.checks.my_check?.adjudications.a).toEqual({ verdict: "true_positive", note: "bug" });
	});

	it("drops an adjudication with an unrecognized verdict", () => {
		const store = parseCorpusStore({
			checks: { c: { hits: ["a"], adjudications: { a: { verdict: "probably_fine" } } } },
		});
		expect(store.checks.c?.adjudications).toEqual({});
	});

	it("rejects a mixed hit list instead of silently dropping unresolved evidence", () => {
		expect(parseCorpusStore({ checks: { c: { hits: ["a", 7, null] } } }).checks.c).toBeUndefined();
	});

	it("fails closed on a missing checks map", () => {
		expect(parseCorpusStore({ version: 1 })).toEqual(EMPTY_CORPUS);
	});

	it("fails closed on non-object input", () => {
		expect(parseCorpusStore(null)).toEqual(EMPTY_CORPUS);
		expect(parseCorpusStore("nope")).toEqual(EMPTY_CORPUS);
	});
});
