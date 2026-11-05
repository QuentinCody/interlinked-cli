// Mutation-directed companion for crap-violations.ts (kill-proof census
// 2026-11-05). Fault: the per-line builder's `score < threshold` becomes
// `score <= threshold`, so a function sitting exactly AT the CRAP cap is no
// longer reported by the per-edit or commit gate.
import { describe, expect, it } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { crapViolationsPerLine } from "./crap-violations.js";

function fn(name: string, line: number, endLine: number, cyclomatic: number): FunctionComplexityEntry {
	return { name, line, endLine, cyclomatic, language: "python" };
}

function perLineCov(covered: number[], uncovered: number[]): PerFileCoverage {
	return { filePath: "src/a.py", mtime: 0, functions: [], coveredLines: new Set(covered), uncoveredLines: new Set(uncovered) };
}

const fullyCovered = perLineCov([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], []);

describe("crapViolationsPerLine — the threshold is inclusive", () => {
	// test-contract: boundary - CRAP at 100% coverage equals the cyclomatic value, so cyclomatic 30 against threshold 30 is AT the cap and must be reported
	it("reports a function whose CRAP score equals the threshold exactly", () => {
		const out = crapViolationsPerLine([fn("at_cap", 1, 10, 30)], fullyCovered, 30);
		expect(out).toEqual([expect.objectContaining({ function: "at_cap", crap_score: 30, coverage_pct: 100 })]);
	});

	// test-contract: boundary - one point under the cap is the first score the gate lets through
	it("does not report a function one point under the threshold", () => {
		expect(crapViolationsPerLine([fn("under_cap", 1, 10, 30)], fullyCovered, 31)).toEqual([]);
	});
});
