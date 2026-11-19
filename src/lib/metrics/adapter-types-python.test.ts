import { describe, expect, it } from "vitest";
import type { AnalyzedFile, RepositoryAnalysis } from "./analysis.js";
import { mergePythonTypes } from "./adapter-types-python.js";
import { emptyReading, ratioReading } from "./adapter-values.js";
import type { AdapterResult, InventoryFile } from "./measurement-types.js";
import type { PythonFileRow } from "./python-measure.js";

function pythonFile(path: string, slots: number, anyLines: number[], role: InventoryFile["role"] = "product"): AnalyzedFile {
    const row: PythonFileRow = { astTokens: 0, topLevelTokens: 0, functions: [], imports: [], deadStores: [], initializers: 0, annotationSlots: slots, anyLines,
        facts: { statements: [], declarations: [], mainGuard: false, exports: [], starImport: false, dynamicImports: [] } };
    return { input: { path, role, language: "python", sha256: "h", content: "" }, structure: null, python: { row, cloneHashes: new Map() },
        syntax: { statements: [], tests: [], imports: [], declarations: [], identifiers: new Map(), topLevelTokens: 0 } };
}
function analysis(...files: AnalyzedFile[]): RepositoryAnalysis {
    return { inventory: { files: [] } as unknown as RepositoryAnalysis["inventory"], files, gaps: [], exclusions: [] };
}
const NO_TYPESCRIPT: AdapterResult = { metrics: [emptyReading("types.unsafe", "not-applicable", 0, "No TypeScript product files")], findings: [] };

describe("mergePythonTypes", () => {
    it("returns the TypeScript result untouched when there are no Python product files", () => {
        expect(mergePythonTypes(NO_TYPESCRIPT, analysis(pythonFile("tests/test_a.py", 4, [1], "test")))).toBe(NO_TYPESCRIPT);
    });

    it("measures explicit Any over annotated slots for a Python-only repository", () => {
        const result = mergePythonTypes(NO_TYPESCRIPT, analysis(pythonFile("a.py", 8, [3, 9]), pythonFile("b.py", 2, [])));
        const metric = result.metrics[0]!;
        expect(metric).toMatchObject({ id: "types.unsafe", state: "measured", numerator: 2, denominator: 10, value: 20 });
        expect(metric.details).toEqual({ explicitAnyTypes: 2, explicitUnknownTypes: 0, unsafeOperations: 2 });
        expect(result.findings.map(finding => [finding.file, finding.line, finding.metric])).toEqual([["a.py", 3, "types.unsafe"], ["a.py", 9, "types.unsafe"]]);
    });

    it("is not-applicable with a reason when no Python annotation exists", () => {
        const metric = mergePythonTypes(NO_TYPESCRIPT, analysis(pythonFile("a.py", 0, []))).metrics[0]!;
        expect(metric.state).toBe("not-applicable");
        expect(metric.limitations.join(" ")).toContain("no type annotations");
    });

    it("adds Python opportunities to a measured TypeScript reading and keeps its state", () => {
        const typescript = { ...ratioReading("types.unsafe", 1, 10), details: { explicitAnyTypes: 1, explicitUnknownTypes: 0, unsafeOperations: 1 } };
        const merged = mergePythonTypes({ metrics: [typescript], findings: [] }, analysis(pythonFile("a.py", 10, [2]))).metrics[0]!;
        expect(merged).toMatchObject({ state: "measured", numerator: 2, denominator: 20, value: 10 });
        expect(merged.details).toEqual({ explicitAnyTypes: 2, explicitUnknownTypes: 0, unsafeOperations: 2 });
        const inconclusive = { ...ratioReading("types.unsafe", 1, 10), state: "inconclusive" as const };
        expect(mergePythonTypes({ metrics: [inconclusive], findings: [] }, analysis(pythonFile("a.py", 10, [2]))).metrics[0]!.state).toBe("inconclusive");
    });

    it("keeps a TypeScript reading that has no ratio and says Python was not combined", () => {
        const unsupported = emptyReading("types.unsafe", "unsupported", 3, "TypeScript compiler unavailable");
        const merged = mergePythonTypes({ metrics: [unsupported], findings: [] }, analysis(pythonFile("a.py", 10, [2]))).metrics[0]!;
        expect(merged.state).toBe("unsupported");
        expect(merged.limitations.join(" ")).toContain("Python");
    });
});
