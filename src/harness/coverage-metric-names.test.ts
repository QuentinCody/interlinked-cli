import { describe, expect, it } from "vitest";
import { baselineKeyFor, COVERAGE_METRICS, isCoverageMetricName } from "./coverage-metric-names.js";

describe("COVERAGE_METRICS — positive (must fire)", () => {
	it("P1: names exactly the four istanbul per-file metrics, lines first", () => {
		expect([...COVERAGE_METRICS]).toEqual(["lines", "statements", "functions", "branches"]);
	});

	it("P2: baselineKeyFor maps every metric to its `_pct` baseline key", () => {
		expect(COVERAGE_METRICS.map(baselineKeyFor)).toEqual([
			"lines_pct",
			"statements_pct",
			"functions_pct",
			"branches_pct",
		]);
	});

	it("P3: isCoverageMetricName accepts each listed metric", () => {
		for (const metric of COVERAGE_METRICS) expect(isCoverageMetricName(metric)).toBe(true);
	});
});

describe("isCoverageMetricName — negative (must not fire)", () => {
	it("N1: rejects the baseline key spelling", () => {
		expect(isCoverageMetricName("lines_pct")).toBe(false);
	});

	it("N2: rejects non-strings and unknown metric names", () => {
		expect(isCoverageMetricName(3)).toBe(false);
		expect(isCoverageMetricName(null)).toBe(false);
		expect(isCoverageMetricName("Lines")).toBe(false);
		expect(isCoverageMetricName("mutants")).toBe(false);
	});
});
