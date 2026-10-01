import { describe, expect, it } from "vitest";
import { checkSingleUseTrivialHelper } from "../../harness/checks/over-extraction.js";
import { measureExactClones } from "./adapter-clones.js";
import { analyzeRepository } from "./analysis.js";
import { lineUnionCounts } from "./diagnostic-lines.js";
import { measureDiagnosticInventory } from "./diagnostic-report.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import { sourceLanguage, sourceRole } from "./inventory-roles.js";
import type { RepositoryInventory } from "./measurement-types.js";

function inventory(sources: Record<string, string>): RepositoryInventory {
    const files = Object.entries(sources).map(([path, content]) => ({ path, content, language: sourceLanguage(path), role: sourceRole(path), sha256: hashBytes(content) }));
    return { version: "interlinked-source-roles-v3", root: "/fixture", discovery: "git", files, gaps: [], excluded: [], issues: [],
        inputHash: inventoryHash(files), sourceHash: inventoryHash(files.filter(file => file.role === "product")) };
}
function report(sources: Record<string, string>) { return measureDiagnosticInventory(inventory(sources)); }
const branchy = (name: string, branches: number): string => `function ${name}(x: number) {\n${Array.from({ length: branches }, (_, i) => `if(x === ${i}) return ${i};`).join("\n")}\nreturn -1;\n}`;

describe("explained iterative diagnostics", () => {
    it("uses token-bearing lines, excluding blank/comment/JSDoc lines but preserving multiline literals", () => {
        const result = report({ "a.ts": '/** docs\n * more docs\n */\nfunction a() {\n // comment\n\n return `one\n\ntwo`;\n}\nconst outside = 1;\n' });
        expect(result.files[0]?.sloc).toBe(6);
        expect(result.functions[0]?.sloc).toBe(5);
        expect(result.verbosity).toMatchObject({ numerator: 0, denominator: 6, fraction: 0 });
    });

    it("assigns nested tokens to their own function, without charging the nested branches to the parent", () => {
        const result = report({ "a.ts": 'function outer() {\n function inner(x: boolean) {\n  if(x) return 1;\n  return 0;\n }\n return inner(true);\n}\nconst after = 1;' });
        expect(result.functions.map(fn => [fn.name, fn.sloc, fn.cyclomatic])).toEqual([["outer", 3, 1], ["inner", 4, 2]]);
        expect(result.erosion.denominator).toBeCloseTo(Math.sqrt(3) + 2 * Math.sqrt(4));
        expect(result.files[0]?.sloc).toBe(8);
    });

    it("exposes unchanged absolute burden when simple code dilutes the erosion ratio", () => {
        const before = report({ "a.ts": branchy("complex", 10) });
        const after = report({ "a.ts": branchy("complex", 10), "b.ts": "export function simple() { return 1; }" });
        expect(before.erosion.numerator).toBeCloseTo(11 * Math.sqrt(13));
        expect(before.erosion.fraction).toBe(1);
        expect(after.erosion.numerator).toBe(before.erosion.numerator);
        expect(after.erosion.fraction).toBeLessThan(1);
        expect(after.measurementIdentity).toBe(before.measurementIdentity);
        expect(after.sourceHash).not.toBe(before.sourceHash);
    });

    it("makes the CC 10 boundary explicit", () => {
        expect(report({ "a.ts": branchy("atBoundary", 9) }).erosion.numerator).toBe(0);
        expect(report({ "a.ts": branchy("aboveBoundary", 10) }).erosion.highComplexityFunctions).toBe(1);
    });

    it("unions clone and pattern lines and keeps all members distinct from redundant copies", () => {
        const body = "{\n const result = input.map(item => item + 1).filter(item => item > 1);\n return result.join(',');\n}";
        const source = `function processItems(input: number[]) ${body}\nfunction handleData(input: number[]) ${body}\nprocessItems([]); handleData([]);`;
        const result = report({ "a.ts": source });
        expect(result.clones).toHaveLength(1);
        expect(result.verbosity).toMatchObject({ numerator: 8, denominator: 9, patternLines: 8, cloneLines: 8, overlapLines: 8, redundantCloneLines: 4 });
        expect(result.findings).toHaveLength(2);
        expect(result.findings.every(finding => finding.evidence === "heuristic")).toBe(true);
        const old = measureExactClones(analyzeRepository(inventory({ "a.ts": source })));
        expect(old.findings).toHaveLength(1);
        // Legacy exclusive token exposure excludes the small nested callbacks from the numerator.
        expect(old.metrics[0]?.value).toBeCloseTo(100 * 32 / 84);
    });

    it("does not merge renamed identifiers/literals or tiny bodies", () => {
        const source = `${branchy("a", 4)}\n${branchy("b", 4).replaceAll("x", "y")}\nfunction c(){return 1;}\nfunction d(){return 1;}`;
        expect(report({ "a.ts": source }).clones).toEqual([]);
    });

    it("does not turn public wrappers or useful domain names into trivial-helper findings", () => {
        const source = "export function processItems(x: number[]) { return x.length; }\nprocessItems([]);\nfunction isEligibleForRefund(x: number) { return x > 3; }\nisEligibleForRefund(4);";
        expect(report({ "a.ts": source }).findings).toEqual([]);
    });

    it("keeps the interactive warning cap while measuring every offline helper", () => {
        const source = Array.from({ length: 12 }, (_, i) => `function processItems${i}(x: number[]) { return x.length; }\nprocessItems${i}([]);`).join("\n");
        // Distinct names that still match the detector's shape vocabulary.
        const names = ["Items", "Data", "Rows", "Lines", "Entries", "Files", "Values", "Records", "Inputs", "Outputs", "Tasks", "Nodes"];
        const named = names.reduce((text, name, i) => text.replaceAll(`processItems${i}(`, `process${name}(`), source);
        expect(checkSingleUseTrivialHelper(named, "a.ts")).toHaveLength(10);
        expect(report({ "a.ts": named }).findings).toHaveLength(12);
    });

    it("distinguishes no-functions and empty input from measured zero", () => {
        const empty = report({ "empty.ts": "// only a comment\n" });
        expect(empty.verbosity).toMatchObject({ state: "not-applicable", fraction: null });
        expect(empty.erosion).toMatchObject({ state: "not-applicable", fraction: null });
        expect(report({ "a.ts": "const value = 1;" }).erosion.fraction).toBeNull();
    });

    it("reports Python and parser recovery as gaps, excluding tests from the product census", () => {
        const result = report({ "a.ts": "export const a = 1;", "broken.ts": "function ( {", "main.py": "def f(): return 1", "a.test.ts": "function ( {" });
        expect(result.scope).toMatchObject({ status: "partial", eligibleFiles: 3, measuredFiles: 1 });
        expect(result.scope.notMeasured.map(gap => gap.path)).toEqual(["broken.ts", "main.py"]);
        expect(result.scope.exclusions).toContainEqual(expect.objectContaining({ path: "a.test.ts", role: "test" }));
        expect(result.verbosity.denominator).toBe(1);
    });

    it("never treats overlapping or repeated spans as additional lines", () => {
        expect(lineUnionCounts([1, 2, 2, 3], [2, 3, 4, 4])).toEqual({ pattern: 3, clone: 3, overlap: 2, union: 4 });
    });
});
