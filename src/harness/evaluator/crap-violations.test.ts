// Direct unit coverage for the shared CRAP-violation builders used by BOTH the
// per-edit CRAP gate (coverage-crap-decision.ts) and the commit gate
// (commit-gate-scan.ts). The two surfaces previously carried byte-identical
// copies of these builders; this pins the single implementation.

import { describe, expect, it } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { crapViolationsPerFunction, crapViolationsPerLine } from "./crap-violations.js";

function fn(name: string, line: number, endLine: number, cyclomatic: number): FunctionComplexityEntry {
	return { name, line, endLine, cyclomatic, language: "js_ts" };
}

function perFunctionCov(functions: PerFileCoverage["functions"]): PerFileCoverage {
	return { filePath: "src/a.ts", mtime: 0, functions };
}

function perLineCov(covered: number[], uncovered: number[]): PerFileCoverage {
	return {
		filePath: "src/a.py",
		mtime: 0,
		functions: [],
		coveredLines: new Set(covered),
		uncoveredLines: new Set(uncovered),
	};
}

describe("crapViolationsPerFunction — positive (must fire)", () => {
	it("P1: reports a complex, under-covered function at/above the threshold", () => {
		const hits = crapViolationsPerFunction(
			"src/a.ts",
			[fn("big", 1, 9, 12)],
			perFunctionCov([{ name: "big", line: 1, endLine: 9, hits: 2, statement_pct: 10 }]),
			30,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.function).toBe("big");
		expect(hits[0]?.line).toBe(1);
		expect(hits[0]?.cyclomatic).toBe(12);
		expect(hits[0]?.coverage_pct).toBe(10);
		expect(hits[0]?.crap_score).toBeGreaterThanOrEqual(30);
	});

	it("P2: matches a coverage entry whose line drifted within the ±3-line slack", () => {
		const hits = crapViolationsPerFunction(
			"src/a.ts",
			[fn("drift", 10, 20, 12)],
			perFunctionCov([{ name: "drift", line: 12, endLine: 20, hits: 1, statement_pct: 0 }]),
			30,
		);
		expect(hits.map((h) => h.function)).toEqual(["drift"]);
	});
});

describe("crapViolationsPerFunction — negative (must not fire)", () => {
	it("N1: stays silent for a fully covered function", () => {
		const hits = crapViolationsPerFunction(
			"src/a.ts",
			[fn("big", 1, 9, 12)],
			perFunctionCov([{ name: "big", line: 1, endLine: 9, hits: 9, statement_pct: 100 }]),
			30,
		);
		expect(hits).toEqual([]);
	});

	it("N2: stays silent for an uncovered but SIMPLE function under the threshold", () => {
		const hits = crapViolationsPerFunction(
			"src/a.ts",
			[fn("tiny", 1, 3, 1)],
			perFunctionCov([{ name: "tiny", line: 1, endLine: 3, hits: 0, statement_pct: 0 }]),
			30,
		);
		expect(hits).toEqual([]);
	});
});

describe("crapViolationsPerLine — positive (must fire)", () => {
	it("P3: scores a function from the covered/uncovered lines inside its body range", () => {
		const hits = crapViolationsPerLine([fn("f", 1, 4, 12)], perLineCov([1], [2, 3, 4]), 30);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.function).toBe("f");
		expect(hits[0]?.cyclomatic).toBe(12);
		expect(hits[0]?.coverage_pct).toBeCloseTo(25, 6);
		expect(hits[0]?.crap_score).toBeGreaterThanOrEqual(30);
	});

	it("P4: sorts worst-first when several functions are over the threshold", () => {
		const hits = crapViolationsPerLine(
			[fn("mild", 1, 4, 10), fn("worst", 5, 8, 20)],
			perLineCov([1], [2, 3, 4, 5, 6, 7, 8]),
			30,
		);
		expect(hits.map((h) => h.function)).toEqual(["worst", "mild"]);
	});

	it("P5: counts only lines INSIDE the body range (start/end inclusive)", () => {
		const hits = crapViolationsPerLine([fn("f", 2, 3, 12)], perLineCov([1, 4], [2, 3]), 30);
		expect(hits[0]?.coverage_pct).toBe(0);
	});
});

describe("crapViolationsPerLine — negative (must not fire)", () => {
	it("N3: skips a function with no executable line in range", () => {
		expect(crapViolationsPerLine([fn("f", 10, 20, 30)], perLineCov([1], [2]), 30)).toEqual([]);
	});

	it("N4: stays silent when the score is below the threshold", () => {
		expect(crapViolationsPerLine([fn("f", 1, 4, 2)], perLineCov([1], [2, 3, 4]), 30)).toEqual([]);
	});

	it("N5: treats missing covered/uncovered sets as empty (no executable lines)", () => {
		const cov: PerFileCoverage = { filePath: "src/a.py", mtime: 0, functions: [] };
		expect(crapViolationsPerLine([fn("f", 1, 4, 30)], cov, 30)).toEqual([]);
	});
});
