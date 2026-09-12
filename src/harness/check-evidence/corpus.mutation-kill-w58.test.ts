import { describe, expect, it } from "vitest";
import {
	CHECK_CORPUS_PATH,
	EMPTY_CORPUS,
	buildCorpusRecord,
	corpusSatisfied,
	falsePositiveSignatures,
	hitSignature,
	parseCorpusStore,
	staleAdjudications,
	unadjudicatedHits,
} from "./corpus.js";

describe("hitSignature — positive (must fire)", () => {
	// test-contract: invariant — hitSignature normalizes internal whitespace runs
	// to a single space (doc comment: "normalized line text"), so differently
	// spaced occurrences of the same line collapse to one signature.
	it("normalizes whitespace runs to a single space before hashing", () => {
		const collapsed = hitSignature({ file: "a.ts", text: "foo   bar" });
		const single = hitSignature({ file: "a.ts", text: "foo bar" });
		expect(collapsed).toBe(single);
	});

	// test-contract: public-api — hitSignature must slice the sha256 digest to
	// 16 hex chars, not return the full 64-char digest.
	it("produces a 16-character hex signature (sliced sha256), not the full 64", () => {
		const sig = hitSignature({ file: "a.ts", text: "hello" });
		expect(sig).toHaveLength(16);
		expect(sig).toMatch(/^[0-9a-f]{16}$/);
	});

	// test-contract: boundary — the space joining file and normalized text in
	// the hashed string must be present; without it "a"+"bcd" and "ab"+"cd"
	// would hash identically.
	it("keeps file and text from colliding across the join boundary", () => {
		const sigA = hitSignature({ file: "a", text: "bcd" });
		const sigB = hitSignature({ file: "ab", text: "cd" });
		expect(sigA).not.toBe(sigB);
	});
});

describe("buildCorpusRecord — positive (must fire)", () => {
	// test-contract: public-api — buildCorpusRecord must sort the deduped
	// signature list (source comment: "[...new Set(...)].sort()").
	it("sorts signatures ascending", () => {
		const hits = [
			{ file: "z.ts", line: 1, text: "zzz" },
			{ file: "a.ts", line: 1, text: "aaa" },
			{ file: "m.ts", line: 1, text: "mmm" },
		];
		const record = buildCorpusRecord(hits, 3);
		const sorted = [...record.hits].sort();
		expect(record.hits).toEqual(sorted);
		expect(record.hits.length).toBe(3);
	});

	// test-contract: invariant — buildCorpusRecord dedupes hits sharing a
	// signature via `new Set`.
	it("dedupes identical hits into a single signature", () => {
		const hits = [
			{ file: "a.ts", line: 1, text: "same" },
			{ file: "a.ts", line: 2, text: "same" },
		];
		const record = buildCorpusRecord(hits, 2);
		expect(record.hits.length).toBe(1);
	});

	// test-contract: bug — `if (prior) adjudications[sig] = prior` must not
	// assign when there is no prior verdict for the signature.
	it("does not create an adjudication entry when there is no prior verdict", () => {
		const sig = hitSignature({ file: "a.ts", text: "x" });
		const previous = { files_scanned: 1, hits: [sig], adjudications: {} };
		const record = buildCorpusRecord([{ file: "a.ts", line: 1, text: "x" }], 1, previous);
		expect(record.adjudications[sig]).toBeUndefined();
		expect(Object.keys(record.adjudications).length).toBe(0);
	});

	// test-contract: public-api — an existing verdict in `previous` must carry
	// forward into the new record's adjudications for a repeated signature.
	it("carries forward an existing verdict when present", () => {
		const sig = hitSignature({ file: "a.ts", text: "x" });
		const previous = {
			files_scanned: 1,
			hits: [sig],
			adjudications: { [sig]: { verdict: "false_positive" as const, note: "ok" } },
		};
		const record = buildCorpusRecord([{ file: "a.ts", line: 1, text: "x" }], 1, previous);
		expect(record.adjudications[sig]).toEqual({ verdict: "false_positive", note: "ok" });
	});
});

describe("parseCorpusStore — positive (must fire)", () => {
	// test-contract: security — a null payload must fail closed to EMPTY_CORPUS,
	// never throw or return a partially-parsed structure.
	it("returns EMPTY_CORPUS for null", () => {
		expect(parseCorpusStore(null)).toEqual(EMPTY_CORPUS);
	});

	// test-contract: boundary — a non-object top-level value must fail closed.
	it("returns EMPTY_CORPUS for a non-object", () => {
		expect(parseCorpusStore("string")).toEqual(EMPTY_CORPUS);
		expect(parseCorpusStore(42)).toEqual(EMPTY_CORPUS);
	});

	// test-contract: boundary — a missing `checks` key must fail closed.
	it("returns EMPTY_CORPUS when checks is missing", () => {
		expect(parseCorpusStore({})).toEqual(EMPTY_CORPUS);
	});

	// test-contract: boundary — a non-object `checks` value must fail closed.
	it("returns EMPTY_CORPUS when checks is not an object", () => {
		expect(parseCorpusStore({ checks: "nope" })).toEqual(EMPTY_CORPUS);
		expect(parseCorpusStore({ checks: 5 })).toEqual(EMPTY_CORPUS);
	});

	// test-contract: public-api — a well-formed store parses through, keeping
	// the complete hit list and dropping unrecognized adjudication verdicts/shapes.
	it("parses a well-formed store, keeping only valid records", () => {
		const raw = {
			checks: {
				my_check: {
					files_scanned: 10,
					hits: ["sig1", "sig2"],
					adjudications: {
						sig1: { verdict: "true_positive" },
						sig2: { verdict: "false_positive", note: "legit" },
						bad_verdict: { verdict: "maybe" },
						bad_shape: "not-an-object",
					},
				},
			},
		};
		const store = parseCorpusStore(raw);
		expect(store.checks.my_check).toEqual({
			files_scanned: 10,
			hits: ["sig1", "sig2"],
			adjudications: {
				sig1: { verdict: "true_positive" },
				sig2: { verdict: "false_positive", note: "legit" },
			},
		});
	});

	// test-contract: invariant — `typeof o.files_scanned === "number"` must
	// gate the default-to-0 fallback for a non-number value.
	it("defaults files_scanned to 0 when not a number", () => {
		const raw = { checks: { c1: { files_scanned: "not-a-number", hits: [], adjudications: {} } } };
		const store = parseCorpusStore(raw);
		expect(store.checks.c1).toEqual({ files_scanned: 0, hits: [], adjudications: {} });
	});

	// test-contract: boundary — a null record value inside `checks` must be
	// dropped by parseRecord's `!raw || typeof raw !== "object"` guard.
	it("drops a null record entry inside checks", () => {
		const raw = { checks: { c1: null } };
		const store = parseCorpusStore(raw);
		expect(store.checks.c1).toBeUndefined();
		expect(Object.keys(store.checks)).toEqual([]);
	});

	// test-contract: boundary — an adjudication entry whose value is null must
	// be dropped by parseAdjudications' `!value || typeof value !== "object"`.
	it("drops adjudications whose value is null", () => {
		const raw = {
			checks: {
				c1: { files_scanned: 1, hits: ["sig1"], adjudications: { sig1: null } },
			},
		};
		const store = parseCorpusStore(raw);
		expect(store.checks.c1).toBeDefined();
		expect(store.checks.c1?.adjudications).toEqual({});
	});

	// test-contract: bug — the note field must be dropped when it is not a
	// string (`typeof note === "string"` guard), keeping only `verdict`.
	it("drops a note that is not a string", () => {
		const raw = {
			checks: {
				c1: {
					files_scanned: 1,
					hits: ["sig1"],
					adjudications: { sig1: { verdict: "true_positive", note: 123 } },
				},
			},
		};
		const store = parseCorpusStore(raw);
		expect(store.checks.c1).toBeDefined();
		expect(store.checks.c1?.adjudications.sig1).toEqual({ verdict: "true_positive" });
	});

	// test-contract: boundary — a missing `adjudications` key must default to
	// an empty map, not throw or leave it undefined.
	it("defaults a missing adjudications map to empty", () => {
		const raw = { checks: { c1: { files_scanned: 1, hits: [] } } };
		const store = parseCorpusStore(raw);
		expect(store.checks.c1).toBeDefined();
		expect(store.checks.c1?.adjudications).toEqual({});
	});
});

describe("corpusSatisfied — positive (must fire)", () => {
	// test-contract: public-api — `if (!record) return false` must reject an
	// undefined record rather than throwing or returning true.
	it("is false for undefined record", () => {
		expect(corpusSatisfied(undefined)).toBe(false);
	});

	// test-contract: public-api — a record whose every hit is adjudicated must
	// be satisfied.
	it("is true only when every hit has an adjudication", () => {
		const record = {
			files_scanned: 1,
			hits: ["a", "b"],
			adjudications: { a: { verdict: "true_positive" as const }, b: { verdict: "true_positive" as const } },
		};
		expect(corpusSatisfied(record)).toBe(true);
	});

	// test-contract: bug — a record with an unadjudicated hit must be
	// unsatisfied, and unadjudicatedHits must name exactly that hit.
	it("is false when a hit lacks an adjudication", () => {
		const record = {
			files_scanned: 1,
			hits: ["a", "b"],
			adjudications: { a: { verdict: "true_positive" as const } },
		};
		expect(corpusSatisfied(record)).toBe(false);
		expect(unadjudicatedHits(record)).toEqual(["b"]);
	});
});

describe("falsePositiveSignatures — positive (must fire)", () => {
	// test-contract: public-api — must filter to only `false_positive` verdicts
	// (`a.verdict === "false_positive"`), excluding true_positive entries.
	it("only returns signatures verdicted false_positive, not true_positive", () => {
		const record = {
			files_scanned: 2,
			hits: ["a", "b"],
			adjudications: {
				a: { verdict: "true_positive" as const },
				b: { verdict: "false_positive" as const },
			},
		};
		expect(falsePositiveSignatures(record)).toEqual(["b"]);
	});
});

describe("staleAdjudications — positive (must fire)", () => {
	// test-contract: invariant — an adjudication naming a signature absent from
	// `hits` must be reported as stale.
	it("flags adjudications referencing signatures no longer in hits", () => {
		const record = {
			files_scanned: 1,
			hits: ["a"],
			adjudications: { a: { verdict: "true_positive" as const }, ghost: { verdict: "true_positive" as const } },
		};
		expect(staleAdjudications(record)).toEqual(["ghost"]);
	});
});

describe("constants — positive (must fire)", () => {
	// test-contract: public-api — CHECK_CORPUS_PATH is the real committed repo
	// path consumers read/write against; it must not be empty.
	it("CHECK_CORPUS_PATH is the real committed path, not empty", () => {
		expect(CHECK_CORPUS_PATH).toBe(".interlinked/check-corpus.json");
		expect(CHECK_CORPUS_PATH.length).toBeGreaterThan(0);
	});

	// test-contract: public-api — EMPTY_CORPUS is the documented "empty or
	// malformed" fallback shape `{ version: 1, checks: {} }`, not `{}`.
	it("EMPTY_CORPUS has version 1 and an empty checks map, not an empty object", () => {
		expect(EMPTY_CORPUS).toEqual({ version: 1, checks: {} });
		expect(EMPTY_CORPUS.version).toBe(1);
		expect(EMPTY_CORPUS.checks).toEqual({});
	});
});
