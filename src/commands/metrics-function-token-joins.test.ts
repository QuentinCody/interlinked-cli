// ===========================================
// metrics-function-token-joins tests — complexity-by-location join + text compare
// ===========================================
import { describe, expect, it } from "vitest";
import type { FnMetric } from "./metrics-renderers.js";
import { compareMetricText, uniqueMetricComplexities } from "./metrics-function-token-joins.js";

function fn(overrides: Partial<FnMetric> = {}): FnMetric {
	return {
		file: "src/a.ts",
		name: "f",
		line: 1,
		cyclomatic: 1,
		coveragePct: null,
		crap: null,
		...overrides,
	};
}

describe("uniqueMetricComplexities", () => {
	it("P1: a unique file:name:line key maps to that row's cyclomatic value", () => {
		const values = uniqueMetricComplexities([fn({ line: 10, cyclomatic: 7 })]);
		expect(values.get("src/a.ts:f:10")).toBe(7);
	});

	it("N1: a colliding key (two rows sharing file+name+line) is dropped from the map entirely", () => {
		const values = uniqueMetricComplexities([
			fn({ line: 10, cyclomatic: 7 }),
			fn({ line: 10, cyclomatic: 9 }),
		]);
		expect(values.has("src/a.ts:f:10")).toBe(false);
		expect(values.size).toBe(0);
	});
});

describe("compareMetricText", () => {
	it("P1: an ordered pair sorts ascending (negative for a < b)", () => {
		expect(compareMetricText("a.ts", "b.ts")).toBe(-1);
	});

	it("P2: a reversed pair sorts as its inverse (positive for a > b)", () => {
		expect(compareMetricText("b.ts", "a.ts")).toBe(1);
	});

	it("N1: an equal pair compares as zero", () => {
		expect(compareMetricText("same.ts", "same.ts")).toBe(0);
	});
});
