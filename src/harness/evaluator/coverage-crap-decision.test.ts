// Direct unit coverage for the CRAP-decision module extracted from
// coverage-write-guard.ts. The end-to-end CRAP behavior is also exercised through
// the guard (coverage-write-guard.test.ts → "CRAP block"); this pins the
// extracted public surface (decideCrap / hasPerLineData / DEFAULT_CRAP_THRESHOLD)
// in isolation.

import { describe, expect, it, vi } from "vitest";
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { HarnessDecision } from "../types.js";
import {
	type CrapInput,
	DEFAULT_CRAP_THRESHOLD,
	decideCrap,
	defaultCyclomaticFor,
	hasPerLineData,
} from "./coverage-crap-decision.js";

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

/** A never-called degrade sink — asserts decideCrap did NOT fail open. */
function failIfDegraded(): (relPath: string, why: string) => HarnessDecision {
	return () => {
		throw new Error("onDegrade should not have been called");
	};
}

/** A degrade stub mirroring the guard's loud-degrade: ALLOW + an agent-visible warning. */
function allowDegrade(): (relPath: string, why: string) => HarnessDecision {
	return (relPath, why) => ({
		decision: "allow",
		warnings: [`[interlinked:coverage] WARNING: ${relPath} (${why})`],
	});
}

const baseInput = (over: Partial<CrapInput>): CrapInput => ({
	relPath: "src/a.ts",
	proposed: "export function big() {\n  return 1;\n}\n",
	cov: perFunctionCov([{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 }]),
	editedLines: undefined,
	threshold: DEFAULT_CRAP_THRESHOLD,
	analyzer: () => [fn("big", 1, 3, 10)],
	...over,
});

describe("defaultCyclomaticFor", () => {
	it("resolves js and ts to the real TS-AST analyzer", () => {
		expect(defaultCyclomaticFor("js")).toBe(computeCyclomaticAst);
		expect(defaultCyclomaticFor("ts")).toBe(computeCyclomaticAst);
	});

	it("resolves python to the real radon-backed analyzer", () => {
		expect(defaultCyclomaticFor("python")).toBe(computeCyclomaticPython);
	});
});

describe("DEFAULT_CRAP_THRESHOLD", () => {
	it("is the McCabe/SonarQube cutoff of 30", () => {
		expect(DEFAULT_CRAP_THRESHOLD).toBe(30);
	});
});

describe("hasPerLineData", () => {
	it("is true when coverage carries per-line sets, false for per-function only", () => {
		expect(hasPerLineData(perLineCov([1], [2]))).toBe(true);
		expect(hasPerLineData(perFunctionCov([{ name: "f", line: 1, endLine: 2, hits: 1, statement_pct: 100 }]))).toBe(
			false,
		);
	});
});

describe("decideCrap — per-function (istanbul) shape", () => {
	it("BLOCKS a complex + under-covered touched function, naming CRAP/cyclomatic/coverage", () => {
		// cyclomatic 10 @ 20% → CRAP ≈ 61 (≥ 30).
		const decision = decideCrap(baseInput({}), failIfDegraded());
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 61/);
		expect(decision?.reason).toMatch(/`big`/);
		expect(decision?.reason).toMatch(/cyclomatic 10/);
		expect(decision?.reason).toMatch(/coverage 20%/);
		expect(decision?.rule_id).toBe("per-edit-coverage");
	});

	it("ALLOWS (null) when the same function is fully covered (CRAP ≈ cyclomatic < 30)", () => {
		const decision = decideCrap(
			baseInput({ cov: perFunctionCov([{ name: "big", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]) }),
			failIfDegraded(),
		);
		expect(decision).toBeNull();
	});

	it("ALLOWS (null) when no touched function exists (edited lines miss the function)", () => {
		const decision = decideCrap(baseInput({ editedLines: new Set([99]) }), failIfDegraded());
		expect(decision).toBeNull();
	});

	it("respects a raised threshold (CRAP-61 passes a threshold of 100)", () => {
		const decision = decideCrap(baseInput({ threshold: 100 }), failIfDegraded());
		expect(decision).toBeNull();
	});
});

describe("decideCrap — per-line (coverage.py) shape", () => {
	it("BLOCKS using radon ranges ∩ coverage.py lines (covered 1/4 → 25% → CRAP ≥ 30)", () => {
		// function lines 1..6; covered {3}, uncovered {4,5,6} → 25% over 4 executable.
		const decision = decideCrap(
			{
				relPath: "src/a.py",
				proposed: "def big():\n    pass\n",
				cov: perLineCov([3], [4, 5, 6]),
				editedLines: undefined,
				threshold: DEFAULT_CRAP_THRESHOLD,
				analyzer: () => [{ name: "big", line: 1, endLine: 6, cyclomatic: 10, language: "python" }],
			},
			failIfDegraded(),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 52/);
		expect(decision?.reason).toMatch(/coverage 25%/);
	});

	it("skips a function with zero measurable lines in range and one under threshold, blocking on the worst of two over-threshold functions (sort comparator)", () => {
		// Four functions sharing one coverage map, exercising every branch of
		// crapViolationsPerLine in one pass:
		//   - "big"   (1..6):   covered{3}, uncovered{4,5,6} → 25% → CRAP ≈ 52 (kept, over threshold)
		//   - "small" (10..12): fully covered, low cyclomatic → CRAP under threshold (continue, L159 true)
		//   - "empty" (20..22): no covered/uncovered lines fall in range → executable===0 (continue, L156 true)
		//   - "big2"  (30..35): covered{32}, uncovered{33,34,35,36} minus 36 (out of range) → also over threshold, DIFFERENT score than "big" so the sort comparator (b.crap_score - a.crap_score) actually discriminates between two elements
		const decision = decideCrap(
			{
				relPath: "src/a.py",
				proposed: "def big():\n    pass\n",
				cov: perLineCov(
					[3, 10, 11, 12, 32],
					[4, 5, 6, 33, 34, 35],
				),
				editedLines: undefined,
				threshold: DEFAULT_CRAP_THRESHOLD,
				analyzer: () => [
					{ name: "big", line: 1, endLine: 6, cyclomatic: 10, language: "python" },
					{ name: "small", line: 10, endLine: 12, cyclomatic: 1, language: "python" },
					{ name: "empty", line: 20, endLine: 22, cyclomatic: 20, language: "python" },
					{ name: "big2", line: 30, endLine: 35, cyclomatic: 8, language: "python" },
				],
			},
			failIfDegraded(),
		);
		expect(decision?.decision).toBe("block");
		// "big" (cyclomatic 10 @ 25%) scores higher than "big2" (cyclomatic 8 @ 25%)
		// — the sort must surface "big", not just whichever came first.
		expect(decision?.reason).toContain("`big`");
		expect(decision?.reason).not.toContain("`small`");
		expect(decision?.reason).not.toContain("`empty`");
	});

	it("falls back to an empty set when coveredLines is undefined (uncoveredLines-only report)", () => {
		const cov: PerFileCoverage = {
			filePath: "src/a.py",
			mtime: 0,
			functions: [],
			uncoveredLines: new Set([1, 2, 3, 4, 5, 6]),
			// coveredLines intentionally omitted
		};
		const decision = decideCrap(
			{
				relPath: "src/a.py",
				proposed: "def big():\n    pass\n",
				cov,
				editedLines: undefined,
				threshold: DEFAULT_CRAP_THRESHOLD,
				analyzer: () => [{ name: "big", line: 1, endLine: 6, cyclomatic: 10, language: "python" }],
			},
			failIfDegraded(),
		);
		// 0% covered (empty covered-lines fallback) — the highest possible CRAP.
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/coverage 0%/);
	});

	it("falls back to an empty set when uncoveredLines is undefined (coveredLines-only report)", () => {
		const cov: PerFileCoverage = {
			filePath: "src/a.py",
			mtime: 0,
			functions: [],
			coveredLines: new Set([1, 2, 3, 4, 5, 6]),
			// uncoveredLines intentionally omitted
		};
		const decision = decideCrap(
			{
				relPath: "src/a.py",
				proposed: "def big():\n    pass\n",
				cov,
				editedLines: undefined,
				threshold: DEFAULT_CRAP_THRESHOLD,
				analyzer: () => [{ name: "big", line: 1, endLine: 6, cyclomatic: 10, language: "python" }],
			},
			failIfDegraded(),
		);
		// 100% covered (empty uncovered-lines fallback) — low CRAP, no block.
		expect(decision).toBeNull();
	});
});

describe("decideCrap — fail-open", () => {
	it("calls onDegrade AND propagates its allow-decision when the analyzer is null", () => {
		const onDegrade = vi.fn(allowDegrade());
		const decision = decideCrap(baseInput({ analyzer: null }), onDegrade);
		// The degrade decision (allow + warning) is returned verbatim, not swallowed
		// into a bare null — the silent-fail-open guard at the CRAP layer.
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/\[interlinked:coverage\]/);
		expect(onDegrade).toHaveBeenCalledOnce();
		expect(onDegrade.mock.calls[0]?.[1]).toMatch(/no cyclomatic analyzer/);
	});

	it("calls onDegrade and propagates its allow-decision when the analyzer returns null", () => {
		const onDegrade = vi.fn(allowDegrade());
		const decision = decideCrap(baseInput({ analyzer: () => null }), onDegrade);
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/\[interlinked:coverage\]/);
		expect(onDegrade).toHaveBeenCalledOnce();
		expect(onDegrade.mock.calls[0]?.[1]).toMatch(/unavailable/);
	});
});
