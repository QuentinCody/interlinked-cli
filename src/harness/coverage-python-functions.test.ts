import { describe, expect, it, vi } from "vitest";
import type { FunctionComplexityEntry } from "./checks/cyclomatic.js";
import type { PerFileCoverage } from "./coverage-final-reader.js";
import { parsePythonFunctionCoverage, pythonFunctionCoverageIssue } from "./coverage-python-functions.js";
import { decideCrap } from "./evaluator/coverage-crap-decision.js";
import { crapViolationsPerLine } from "./evaluator/crap-violations.js";

const outer: FunctionComplexityEntry = { name: "outer", line: 1, endLine: 12, cyclomatic: 10, language: "python" };
const inner: FunctionComplexityEntry = { name: "inner", line: 3, endLine: 10, cyclomatic: 10, language: "python" };

function coverage(functions: unknown): PerFileCoverage {
    return {
        filePath: "example.py", mtime: 0, functions: [],
        coveredLines: new Set([1, 2, 3, 11, 12]), uncoveredLines: new Set([4, 5, 6, 7, 8, 9, 10]),
        pythonFunctions: parsePythonFunctionCoverage(functions),
    };
}

function region(start: number, covered: number[], missing: number[], excluded: number[] = []) {
    return { start_line: start, executed_lines: covered, missing_lines: missing, excluded_lines: excluded };
}

describe("native Python CRAP attribution", () => {
    it("does not charge an outer function for an unexecuted nested body", () => {
        const cov = coverage({ outer: region(1, [2, 3, 11, 12], []), "outer.inner": region(3, [], [4, 5, 6, 7, 8, 9, 10]) });
        expect(pythonFunctionCoverageIssue([outer, inner], cov.pythonFunctions!)).toBeNull();
        expect(crapViolationsPerLine([outer, inner], cov, 30)).toEqual([
            { function: "inner", line: 3, cyclomatic: 10, coverage_pct: 0, crap_score: 110 },
        ]);
    });

    it("uses executable line ownership, excluding pragmas and ignoring branch percentages", () => {
        const cov = coverage({ outer: { ...region(1, [2, 3], [4], [3]), summary: { percent_covered: 99 } }, "": {} });
        expect(crapViolationsPerLine([outer], cov, 0)[0]?.coverage_pct).toBe(50);
    });

    it.each([undefined, { outer: { executed_lines: [2], missing_lines: [], excluded_lines: [] } },
        { outer: region(1, [2], [2]) }, { outer: region(1, [2.5], []) }])("degrades unusable native regions instead of inferring from file ranges", (raw) => {
        const cov = coverage(raw);
        const onDegrade = vi.fn(() => ({ decision: "allow" as const, warnings: ["unmeasured"] }));
        const result = decideCrap({ relPath: "example.py", proposed: "", cov, editedLines: undefined, threshold: 30, analyzer: () => [outer] }, onDegrade);
        expect(result?.warnings).toEqual(["unmeasured"]);
        expect(onDegrade).toHaveBeenCalledWith("example.py", expect.stringContaining("Python CRAP not measured"));
        expect(crapViolationsPerLine([outer], cov, 0)).toEqual([]);
    });

    it.each([
        { outer: region(2, [2], []) },
        { "A.outer": region(1, [2], []), "B.outer": region(1, [2], []) },
        { outer: region(1, [], []) },
    ])("marks unmatched, ambiguous or unmeasured functions unavailable", (raw) => {
        expect(pythonFunctionCoverageIssue([outer], coverage(raw).pythonFunctions!)).toBeTruthy();
    });
});
