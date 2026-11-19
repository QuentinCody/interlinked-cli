import { describe, expect, it } from "vitest";
import { NAN_COMPARISON } from "./nan-comparison-scan.js";

describe("NAN_COMPARISON — Number.NaN spelling", () => {
	// test-contract: public-api — `Number . NaN` with whitespace around the dot is still the global NaN.
	it("matches a comparison against Number . NaN written with spaces", () => {
		expect(NAN_COMPARISON.test("if (Number . NaN === x) {}")).toBe(true);
	});

	// test-contract: public-api — `Number .NaN` with whitespace before the dot is still the global NaN.
	it("matches a comparison against Number .NaN written with a space before the dot", () => {
		expect(NAN_COMPARISON.test("if (Number .NaN === x) {}")).toBe(true);
	});
});
