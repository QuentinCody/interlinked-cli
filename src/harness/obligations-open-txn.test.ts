import { describe, expect, it } from "vitest";
import { parseOpenTxnOptional, parseOpenTxnRequired } from "./obligations-open-txn.js";

// ----- parseOpenTxnRequired — positive (must accept) ----------------------

describe("parseOpenTxnRequired — positive (must accept)", () => {
	it("P1: accepts a well-formed set of required fields", () => {
		const value = { op: "open", kind: "coverage", file: "src/a.ts", contentHash: "c", sessionId: "s", atMs: 1 };
		expect(parseOpenTxnRequired(value)).toEqual({
			kind: "coverage",
			file: "src/a.ts",
			contentHash: "c",
			sessionId: "s",
			atMs: 1,
		});
	});

	it("P2: ignores extra unrelated fields on the object", () => {
		const value = { op: "open", kind: "mutation", file: "src/b.ts", contentHash: "c2", sessionId: "s2", atMs: 2, extra: "ignored" };
		expect(parseOpenTxnRequired(value)).toEqual({
			kind: "mutation",
			file: "src/b.ts",
			contentHash: "c2",
			sessionId: "s2",
			atMs: 2,
		});
	});
});

// ----- parseOpenTxnRequired — negative (must reject) -----------------------

describe("parseOpenTxnRequired — negative (must reject)", () => {
	it("N1: rejects a non-open op", () => {
		expect(parseOpenTxnRequired({ op: "discharge", kind: "coverage", file: "f", contentHash: "c", sessionId: "s", atMs: 1 })).toBeNull();
	});

	it("N2: rejects an unknown kind", () => {
		expect(parseOpenTxnRequired({ op: "open", kind: "bogus", file: "f", contentHash: "c", sessionId: "s", atMs: 1 })).toBeNull();
	});

	it("N3: rejects a non-string file", () => {
		expect(parseOpenTxnRequired({ op: "open", kind: "coverage", file: 1, contentHash: "c", sessionId: "s", atMs: 1 })).toBeNull();
	});

	it("N4: rejects a non-string contentHash", () => {
		expect(parseOpenTxnRequired({ op: "open", kind: "coverage", file: "f", contentHash: 1, sessionId: "s", atMs: 1 })).toBeNull();
	});

	it("N5: rejects a non-string sessionId", () => {
		expect(parseOpenTxnRequired({ op: "open", kind: "coverage", file: "f", contentHash: "c", sessionId: 1, atMs: 1 })).toBeNull();
	});

	it("N6: rejects a non-number atMs", () => {
		expect(parseOpenTxnRequired({ op: "open", kind: "coverage", file: "f", contentHash: "c", sessionId: "s", atMs: "x" })).toBeNull();
	});
});

// ----- parseOpenTxnOptional — positive (must accept) ------------------------

describe("parseOpenTxnOptional — positive (must accept)", () => {
	it("P1: returns an empty object when every optional field is absent", () => {
		expect(parseOpenTxnOptional({})).toEqual({});
	});

	it("P2: parses a well-formed region", () => {
		expect(parseOpenTxnOptional({ region: { start: 1, end: 2 } })).toEqual({ region: { start: 1, end: 2 } });
	});

	it("P3: parses editSeq, detector, strikes, and failingTestFiles together", () => {
		expect(
			parseOpenTxnOptional({
				editSeq: 4,
				detector: "coverage-detector",
				strikes: 2,
				failingTestFiles: ["a.test.ts", "b.test.ts"],
			}),
		).toEqual({
			editSeq: 4,
			detector: "coverage-detector",
			strikes: 2,
			failingTestFiles: ["a.test.ts", "b.test.ts"],
		});
	});

	it("P4: accepts an empty failingTestFiles array", () => {
		expect(parseOpenTxnOptional({ failingTestFiles: [] })).toEqual({ failingTestFiles: [] });
	});
});

// ----- parseOpenTxnOptional — negative (must reject) -------------------------

describe("parseOpenTxnOptional — negative (must reject)", () => {
	it("N1: rejects a malformed region", () => {
		expect(parseOpenTxnOptional({ region: { start: "x", end: 2 } })).toBeNull();
	});

	it("N2: rejects a non-number editSeq", () => {
		expect(parseOpenTxnOptional({ editSeq: "x" })).toBeNull();
	});

	it("N3: rejects a non-string detector", () => {
		expect(parseOpenTxnOptional({ detector: 1 })).toBeNull();
	});

	it("N4: rejects a non-number strikes", () => {
		expect(parseOpenTxnOptional({ strikes: "x" })).toBeNull();
	});

	it("N5: rejects a failingTestFiles array with a non-string entry", () => {
		expect(parseOpenTxnOptional({ failingTestFiles: [1] })).toBeNull();
	});

	it("N6: rejects a non-array failingTestFiles", () => {
		expect(parseOpenTxnOptional({ failingTestFiles: "a.test.ts" })).toBeNull();
	});
});
