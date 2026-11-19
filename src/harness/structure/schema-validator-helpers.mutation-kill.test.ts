import { describe, expect, it } from "vitest";
import { isStringArray } from "./schema-validator-helpers.js";

describe("isStringArray", () => {
	// test-contract: boundary — an array is a string array only when every entry is a string
	it("rejects a mixed array and accepts uniform string arrays", () => {
		expect(isStringArray(["a", 1])).toBe(false);
		expect(isStringArray([1, "a"])).toBe(false);
		expect(isStringArray(["a", "b"])).toBe(true);
		expect(isStringArray([])).toBe(true);
		expect(isStringArray("a")).toBe(false);
	});
});
