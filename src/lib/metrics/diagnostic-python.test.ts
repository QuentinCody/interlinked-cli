import { describe, expect, it, vi } from "vitest";
import { measurePythonDiagnosticInventory } from "./diagnostic-python.js";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import { sourceLanguage, sourceRole } from "./inventory-roles.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async importOriginal => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

function report(sources: Record<string, string>) {
    const files = Object.entries(sources).map(([path, content]) => ({ path, content, language: sourceLanguage(path), role: sourceRole(path), sha256: hashBytes(content) }));
    return measurePythonDiagnosticInventory({ version: "interlinked-source-roles-v3", root: "/fixture", discovery: "git", files, gaps: [], excluded: [], issues: [],
        sourceHash: inventoryHash(files), inputHash: inventoryHash(files) });
}

describe("isolated Python diagnostics", () => {
    it("excludes comments/docstrings and preserves multiline literal SLOC without executing target code", () => {
        const result = report({ "main.py": '"""module docs\nmore docs"""\n# comment\ndef f():\n    """function docs"""\n    return """one\n\ntwo"""\nraise RuntimeError("must not execute")\n' });
        expect(result.scope.status).toBe("complete");
        expect(result.files[0]?.sloc).toBe(5);
        expect(result.functions[0]).toMatchObject({ sloc: 4, cyclomatic: 1 });
        expect(() => parseDiagnosticSnapshot(result)).not.toThrow();
    });
    it("counts nested functions and lambdas separately from decorators and defaults", () => {
        const result = report({ "main.py": '@decorate(1 if flag else 2)\ndef outer(x=1 if flag else 2):\n    def inner(y):\n        return 1 if y else 2\n    value = lambda z: z and x\n    return inner(value(x))\n' });
        expect(result.functions.map(fn => [fn.name, fn.cyclomatic, fn.sloc])).toEqual([["outer", 1, 3], ["inner", 2, 2], ["(lambda)", 2, 1]]);
        expect(result.files[0]?.sloc).toBe(6);
    });
    it("counts comprehensions, exception handlers and guarded match cases", () => {
        const result = report({ "main.py": 'def f(xs):\n    assert xs\n    try:\n        ys = [x for x in xs if x and x > 2]\n    except ValueError:\n        return []\n    match ys:\n        case [a] if a > 0: return ys\n        case _: return []\n' });
        expect(result.functions[0]?.cyclomatic).toBe(8);
    });
    it("unions boolean patterns with exact clones and retains unicode spans", () => {
        const body = '    """docs"""\n    label = "😀"\n    if x > 0 and len(label) > 0 and x != 100:\n        return True\n    else:\n        return False\n';
        const source = `def first(x):\n${body}\ndef second(x):\n${body}`;
        const result = report({ "main.py": source });
        expect(result.clones).toHaveLength(1);
        expect(result.verbosity).toMatchObject({ patternLines: 8, cloneLines: 10, overlapLines: 8, numerator: 10, denominator: 12, redundantCloneLines: 5 });
        expect(source.slice(result.functions[1]!.startOffset, result.functions[1]!.endOffset)).toContain("def second");
        expect(result.findings).toHaveLength(2);
    });
    it("keeps nested block indentation in clone identity", () => {
        const source = 'def a(x):\n    if x:\n        if x > 2:\n            return 1\n        return 2\n    return 3\n\ndef b(x):\n    if x:\n        if x > 2:\n            return 1\n    return 2\n    return 3\n';
        expect(report({ "main.py": source }).clones).toHaveLength(0);
    });
    it("preserves parse failures, unsupported source and test-role exclusions", () => {
        const result = report({ "good.py": "x = 1\n", "broken.py": "def f(:", "test_good.py": "def broken(:", "other.ts": "export const x = 1;" });
        expect(result.scope).toMatchObject({ status: "partial", measuredFiles: 1, eligibleFiles: 3 });
        expect(result.scope.notMeasured.map(gap => gap.path).sort()).toEqual(["broken.py", "other.ts"]);
        expect(result.scope.exclusions[0]).toMatchObject({ path: "test_good.py", role: "test" });
        expect(result.erosion.fraction).toBeNull();
        expect(() => parseDiagnosticSnapshot(result)).not.toThrow();
    });
    it("records unavailable Python as a gap rather than measured zero", () => {
        const spy = vi.spyOn(childProcess, "spawnSync").mockClear().mockReturnValue({ pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error: new Error("ENOENT") });
        try {
            const result = report(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`module${i}.py`, "def f(): return 1"])));
            expect(result.scope).toMatchObject({ status: "partial", measuredFiles: 0, eligibleFiles: 17 });
            expect(result.scope.notMeasured[0]?.reason).toContain("unavailable");
            expect(result.erosion.fraction).toBeNull();
            expect(spy).toHaveBeenCalledTimes(1);
        } finally { spy.mockRestore(); }
    });
});
