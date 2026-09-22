import { describe, expect, it } from "vitest";
import { percentileOf, percentileRanks } from "./percentile-rank.js";

describe("percentileOf — positive (must fire)", () => {
	it("P1: ranks by the share of the population strictly below the value", () => {
		expect(percentileOf(5, [1, 2, 3, 4, 6, 7, 8, 9, 10, 11])).toBe(40);
		expect(percentileOf(100, [1, 2, 3])).toBe(100);
		expect(percentileOf(1, [1, 2, 3])).toBe(0);
	});
});

describe("percentileOf — negative (must not fire)", () => {
	it("N1: an empty population is no ruler", () => {
		expect(percentileOf(5, [])).toBeNull();
	});
});

describe("percentileRanks — positive (must fire)", () => {
	it("P1: every value gets the same rank percentileOf would give it, in input order", () => {
		const values = [30, 10, 20, 10, 40];
		const ranks = percentileRanks(values);
		expect(ranks).toEqual(values.map((v) => percentileOf(v, values)));
		expect(ranks).toEqual([60, 0, 40, 0, 80]);
	});
	it("P2: ties share a rank and the maximum is below 100 when it is not unique", () => {
		expect(percentileRanks([7, 7, 7])).toEqual([0, 0, 0]);
		expect(percentileRanks([1, 9, 9])).toEqual([0, 33, 33]);
	});
});

describe("percentileRanks — negative (must not fire)", () => {
	it("N1: an empty input yields an empty output, and a non-finite value throws", () => {
		expect(percentileRanks([])).toEqual([]);
		expect(() => percentileRanks([1, Number.NaN])).toThrow(/finite/);
	});
});
