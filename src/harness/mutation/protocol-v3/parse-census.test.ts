// Companion test for the mutant-census parser. Every accounting rule
// (generated == executable + approved_excluded, one row per mutant, excluded
// disjoint from executable) is exercised by the wider protocol-v3 conformance
// suite through valid census payloads; this file targets the row-shape guard
// on `excluded`/`mutants` that those payloads never violate.
import { describe, expect, it } from "vitest";
import { checkGeneratedCensusGroup } from "./parse-census.js";
import { IDENTITY_ALGORITHM } from "./types.js";

describe("checkGeneratedCensusGroup", () => {
	it("rejects a non-array excluded field instead of iterating it as rows", () => {
		const raw = {
			identity_algorithm: IDENTITY_ALGORITHM,
			census: { generated: 1, executable: 1, approved_excluded: 0 },
			mutants: [],
			excluded: "not-an-array",
		};
		expect(checkGeneratedCensusGroup(raw)).toBe(
			"excluded must be an array of at most 65536 rows",
		);
	});

	it("rejects a mutants field that stops being an array between row validation and accounting", () => {
		let reads = 0;
		const raw: Record<string, unknown> = {
			identity_algorithm: IDENTITY_ALGORITHM,
			census: { generated: 1, executable: 1, approved_excluded: 0 },
			excluded: [],
		};
		// checkIdRows reads `mutants` once (row-shape pass) and
		// checkCensusAccounting reads it again (accounting pass) via the
		// shared `Raw = Record<string, unknown>` type, which permits an
		// accessor property — so the second read is not bound to what the
		// first read already validated as an array.
		Object.defineProperty(raw, "mutants", {
			enumerable: true,
			get: () => (++reads === 1 ? [] : "not-an-array"),
		});
		expect(() => checkGeneratedCensusGroup(raw)).toThrow(
			"internal census parser invariant: mutants rows were not validated",
		);
	});
});
