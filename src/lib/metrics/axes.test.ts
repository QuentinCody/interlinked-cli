// Stability vs correctness: a display grouping over the composite groups; it never changes a score.
import { describe, expect, it } from "vitest";
import { evidenceAxes, renderAxes } from "./axes.js";
import type { CompositeGroupReading } from "./composite.js";

const group = (id: string, weight: number, score: number | null): CompositeGroupReading => ({ id, weight, applicable: true, score, lower: 0, upper: 100, reach: score === null ? 0 : 1, missing: [] });

describe("evidenceAxes", () => {
	it("puts coverage, mutation and test integrity on stability; correctness detectors and contracts on correctness", () => {
		const axes = evidenceAxes([group("coverage", 15, 20), group("mutation", 15, 40), group("test_integrity", 10, 10), group("correctness", 5, 8), group("contracts", 3, null), group("structure", 20, 50)]);
		expect(axes.map(a => [a.id, a.groups.map(g => g.id)])).toEqual([
			["stability", ["coverage", "mutation", "test_integrity"]],
			["correctness", ["correctness", "contracts"]],
		]);
		// Weighted mean of the measured groups only: (15·20 + 15·40 + 10·10) / 40.
		expect(axes[0]?.burden).toBeCloseTo(25, 6);
		expect(axes[1]?.burden).toBeCloseTo(8, 6);
	});

	it("is null for an axis with no measured group", () => {
		const axes = evidenceAxes([group("coverage", 15, null)]);
		expect(axes[0]?.burden).toBeNull();
		expect(axes[1]?.groups).toEqual([]);
	});
});

describe("renderAxes", () => {
	it("names what each axis can and cannot show", () => {
		const text = renderAxes(evidenceAxes([group("mutation", 15, 40), group("correctness", 5, null)]));
		expect(text).toMatch(/Stability .*40\.0\/100/);
		expect(text).toMatch(/Correctness .*unavailable/);
		expect(text).toMatch(/neither axis shows the behaviour is the required one/);
	});
});
