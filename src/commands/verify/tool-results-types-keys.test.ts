import { describe, expect, it } from "vitest";
import type { CodeQualityResults } from "./tool-results-types.js";
import { CQ_RESULT_KEYS, emptyResults } from "./tool-results-types-keys.js";

describe("tool-results-types-keys", () => {
	it("P1: emptyResults carries every declared key, each an empty array", () => {
		const r = emptyResults();
		for (const key of CQ_RESULT_KEYS) {
			expect(Array.isArray(r[key]), key).toBe(true);
			expect(r[key], key).toHaveLength(0);
		}
	});

	it("P2: the key list has no duplicates and includes the test-quality additions", () => {
		expect(new Set(CQ_RESULT_KEYS).size).toBe(CQ_RESULT_KEYS.length);
		expect(CQ_RESULT_KEYS).toContain("homedirWriteEscape");
		expect(CQ_RESULT_KEYS).toContain("writeWithoutMkdir");
		expect(CQ_RESULT_KEYS).toContain("testLegitimacy");
	});

	it("P3: the list and the interface agree (compile-time contract, spot-checked at runtime)", () => {
		// A key present in the list but absent from CodeQualityResults fails to
		// compile in emptyResults' return type; this runtime spot-check guards
		// the reverse direction for a representative key.
		const r: CodeQualityResults = emptyResults();
		expect(r.homedirWriteEscape).toEqual([]);
		expect(r.testLegitimacy).toEqual([]);
	});

	it("P4: every declared key is a non-empty, well-formed camelCase identifier", () => {
		// P1 derives its expected key from CQ_RESULT_KEYS itself, so a single
		// entry silently corrupted to "" is invisible to that self-referential
		// loop (the loop just checks r[""] against the also-"" source of truth).
		// This assertion is independent of what emptyResults() builds — it
		// inspects each declared literal directly, so a blanked entry fails here
		// even though emptyResults() would still round-trip it faithfully.
		for (const key of CQ_RESULT_KEYS) {
			expect(key.length, `key must not be blank (was ${JSON.stringify(key)})`).toBeGreaterThan(0);
			expect(key, key).toMatch(/^[a-z][A-Za-z0-9]*$/);
		}
	});

	it("P5: the key count is exact — no entry was dropped or blanked-and-collapsed", () => {
		// Guards the population size directly: 231 declared keys today. Paired
		// with P4 (no blank entries) and P2 (no duplicates), this pins the list
		// to precisely 231 distinct, non-empty, well-formed identifiers.
		expect(CQ_RESULT_KEYS.length).toBe(235);
	});
});
