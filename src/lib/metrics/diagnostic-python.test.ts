import { afterEach, describe, expect, it, vi } from "vitest";
import { measurePythonDiagnosticInventory, measurePythonDiagnosticInventoryAsync } from "./diagnostic-python.js";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import { sourceLanguage, sourceRole } from "./inventory-roles.js";
import * as childProcess from "node:child_process";
import * as managedProcess from "../../harness/check-engine/spawn-async.js";
import { withProcessCancellation } from "../../harness/check-engine/process-cancellation.js";
import type { RepositoryInventory } from "./measurement-types.js";

vi.mock("node:child_process", async importOriginal => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

function report(sources: Record<string, string>) {
    const files = Object.entries(sources).map(([path, content]) => ({ path, content, language: sourceLanguage(path), role: sourceRole(path), sha256: hashBytes(content) }));
    return measurePythonDiagnosticInventory({ version: "interlinked-source-roles-v3", root: "/fixture", discovery: "git", files, gaps: [], excluded: [], issues: [],
        sourceHash: inventoryHash(files), inputHash: inventoryHash(files) });
}

function foregroundInventory(count = 1): RepositoryInventory {
    const files = Array.from({ length: count }, (_, index) => {
        const content = "raise RuntimeError('target must not execute')\n";
        return { path: `module${index}.py`, content, language: "python", role: "product" as const, sha256: hashBytes(content) };
    });
    return { version: "interlinked-source-roles-v4", root: process.cwd(), discovery: "git", files, gaps: [], excluded: [], issues: [], sourceHash: inventoryHash(files), inputHash: inventoryHash(files) };
}
afterEach(() => vi.restoreAllMocks());

describe("foreground Python diagnostics", () => {
    it("uses one process for the whole tree, with complete capture and no implicit deadline", async () => {
        const spy = vi.spyOn(managedProcess, "runProcessAsync").mockImplementation(async (_command, _args, options) => {
            const inputs: { path: string }[] = JSON.parse(options?.input ?? "[]");
            return { code: 0, stdout: JSON.stringify({ parser: "3.14", files: inputs.map(input => ({ path: input.path, result: { sloc: 1, functions: [], patterns: [] } })) }), stderr: "", timedOut: false, killed: false };
        });
        const result = await measurePythonDiagnosticInventoryAsync(foregroundInventory(17));
        expect(result.scope).toMatchObject({ status: "complete", eligibleFiles: 17, measuredFiles: 17 });
        expect(spy).toHaveBeenCalledTimes(1);
        for (const [command, args, options] of spy.mock.calls) {
            expect(command).toBe("python3"); expect(args.slice(0, 4)).toEqual(["-I", "-S", "-B", "-c"]);
            expect(options).toMatchObject({ timeout: 0, maxBufferBytes: null, cwd: "/" });
        }
    });
    it("retains a complete report beyond the legacy sixteen-MiB capture ceiling", async () => {
        vi.spyOn(managedProcess, "runProcessAsync").mockResolvedValue({ code: 0, stdout: JSON.stringify({ parser: "3.14", padding: "x".repeat(16 * 1024 * 1024), files: [{ path: "module0.py", result: { sloc: 1, functions: [], patterns: [] } }] }), stderr: "", timedOut: false, killed: false });
        expect((await measurePythonDiagnosticInventoryAsync(foregroundInventory())).scope.status).toBe("complete");
    });
    it("records every file as unavailable, never as a measured zero, when the single native process fails", async () => {
        const spy = vi.spyOn(managedProcess, "runProcessAsync").mockResolvedValue({ code: null, stdout: "", stderr: "", timedOut: false, killed: true });
        const result = await measurePythonDiagnosticInventoryAsync(foregroundInventory(17));
        expect(result.scope).toMatchObject({ status: "partial", measuredFiles: 0 }); expect(result.scope.notMeasured).toHaveLength(17);
        expect(result.erosion.fraction).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
    });
    it("stops before another batch when the invocation is cancelled", async () => {
        const controller = new AbortController();
        const spy = vi.spyOn(managedProcess, "runProcessAsync").mockImplementation(async () => {
            controller.abort(new Error("operator cancelled"));
            return { code: null, stdout: "", stderr: "", timedOut: false, killed: true };
        });
        await expect(withProcessCancellation(controller.signal, () => measurePythonDiagnosticInventoryAsync(foregroundInventory(17)))).rejects.toThrow("operator cancelled");
        expect(spy).toHaveBeenCalledTimes(1);
    });
    it("uses the native isolated parser without executing selected Python code", async () => {
        const result = await measurePythonDiagnosticInventoryAsync(foregroundInventory());
        expect(result.scope).toMatchObject({ status: "complete", measuredFiles: 1 });
        expect(result.files[0]?.sloc).toBe(1);
    });
});

/** `return x + x + ...` with `pairs` extra operands: 8 + 2 * pairs written tokens in the whole function, signature included. */
function sum(name: string, pairs: number, tail = "", doc = ""): string {
    return `def ${name}(x):\n${doc}    return ${"x + ".repeat(pairs)}x${tail}\n`;
}

describe("exact Python clone rule (python-exact-body-v1)", () => {
    it("MUST-FIRE: two functions with the same body form one group, keeping both members", () => {
        const result = report({ "a.py": sum("first", 11) + "\n" + sum("second", 11) });
        expect(result.clones).toHaveLength(1);
        expect(result.clones[0]?.members).toHaveLength(2);
        expect(result.clones[0]?.members.map(member => member.representative)).toEqual([true, false]);
    });
    it("MUST-FIRE: the same body in two files is one group across files", () => {
        const result = report({ "a.py": sum("first", 11), "b.py": sum("renamed", 11) });
        expect(result.clones).toHaveLength(1);
        expect(result.clones[0]?.members.map(member => member.file)).toEqual(["a.py", "b.py"]);
    });
    it("MUST-FIRE: a differing docstring, comment or blank line is not a difference", () => {
        const result = report({ "a.py": sum("first", 11, "  # note") + "\n\n" + sum("second", 11, "", '    """other words"""\n') });
        expect(result.clones).toHaveLength(1);
    });
    it("MUST-NOT-FIRE: the same body with a different literal is not a group", () => {
        const result = report({ "a.py": sum("first", 11, " + 1") + "\n" + sum("second", 11, " + 2") });
        expect(result.clones).toHaveLength(0);
    });
    it("MUST-NOT-FIRE: the same body with a different identifier is not a group", () => {
        const result = report({ "a.py": sum("first", 11) + "\n" + sum("second", 11).replaceAll("x", "y") });
        expect(result.clones).toHaveLength(0);
    });
    it("boundary: 30 written tokens are eligible and 29 are not, in both members", () => {
        expect(report({ "a.py": sum("first", 11) + "\n" + sum("second", 11) }).clones).toHaveLength(1);
        const below = sum("first", 10).replace("return x", "return -x") + "\n" + sum("second", 10).replace("return x", "return -x");
        expect(report({ "a.py": below }).clones).toHaveLength(0);
    });
    it("MUST-NOT-FIRE: a body that only holds a docstring is never a clone", () => {
        const doc = (name: string) => `def ${name}(a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z):\n    """only a docstring"""\n`;
        expect(report({ "a.py": doc("first") + "\n" + doc("second") }).clones).toHaveLength(0);
    });
    it("counts a nested function as its own member and the enclosing function as its own body", () => {
        const inner = sum("inner", 11).replace(/^/gm, "    ");
        const source = `def outer_a(x):\n${inner}    return inner(x)\n\ndef outer_b(x):\n${inner}    return inner(x)\n`;
        const result = report({ "a.py": source });
        expect(result.functions.map(fn => fn.name)).toEqual(["outer_a", "inner", "outer_b", "inner"]);
        expect(result.clones.map(group => group.members.length)).toEqual([2, 2]);
        const spans = result.clones.map(group => group.members[0]!.endOffset - group.members[0]!.startOffset).sort((a, b) => a - b);
        expect(spans[0]!).toBeLessThan(spans[1]!);
    });
});

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
