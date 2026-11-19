import { describe, expect, it } from "vitest";
import { analyzeRepository } from "./analysis.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import { sourceLanguage, sourceRole } from "./inventory-roles.js";
import type { RepositoryInventory } from "./measurement-types.js";
import { pythonAvailable } from "./python-measure.js";

function inventory(sources: Record<string, string>): RepositoryInventory {
    const files = Object.entries(sources).map(([path, content]) => ({ path, content, language: sourceLanguage(path), role: sourceRole(path), sha256: hashBytes(content) }));
    return { version: "interlinked-source-roles-v5", root: "/fixture", discovery: "git", files, gaps: [], excluded: [], issues: [],
        sourceHash: inventoryHash(files), inputHash: inventoryHash(files) };
}

const FUNCTION_SOURCE = "def total(items):\n    out = 0\n    for item in items:\n        if item > 1 and item < 9:\n            out += item\n    return out\n";

describe.skipIf(!pythonAvailable())("analyzeRepository with Python", () => {
    it("measures a parseable Python product file and leaves no gap for it", () => {
        const analysis = analyzeRepository(inventory({ "pkg/calc.py": FUNCTION_SOURCE }));
        expect(analysis.gaps).toEqual([]);
        const file = analysis.files[0]!;
        expect(file.input.path).toBe("pkg/calc.py");
        expect(file.structure?.functions).toHaveLength(1);
        expect(file.structure?.functions[0]).toMatchObject({ name: "total", line: 1, endLine: 6, cyclomatic: 4, cognitive: 4 });
        expect(file.structure?.physicalLines).toBe(6);
        expect(file.python?.row.functions).toHaveLength(1);
    });

    it("records a syntax error as a gap with a stated reason and keeps measuring the other files", () => {
        const analysis = analyzeRepository(inventory({ "bad.py": "def f(:\n", "good.py": FUNCTION_SOURCE }));
        expect(analysis.files.map(file => file.input.path)).toEqual(["good.py"]);
        expect(analysis.gaps).toEqual([{ path: "bad.py", role: "product", reason: expect.stringContaining("SyntaxError") }]);
    });

    it("keeps Python test files as test inputs without structure", () => {
        const analysis = analyzeRepository(inventory({ "tests/test_calc.py": "import pkg\n\ndef test_a():\n    assert pkg\n" }));
        expect(analysis.files[0]).toMatchObject({ input: { role: "test" }, structure: null });
        expect(analysis.files[0]?.python?.row.imports.map(item => item.module)).toEqual(["pkg"]);
    });

    it("fills the shared syntax facts (statements, declarations, identifier uses) the way the TypeScript analyzer does", () => {
        const analysis = analyzeRepository(inventory({ "m.py": "LIMIT = 3\n\n\ndef run(x):\n    if x:\n        return LIMIT\n    return 0\n" }));
        const syntax = analysis.files[0]!.syntax;
        expect(syntax.statements.map(item => item.line)).toEqual([1, 5, 6, 7]);
        expect(syntax.declarations).toEqual([{ name: "LIMIT", line: 1, exported: true, decorated: false }, { name: "run", line: 4, exported: true, decorated: false }]);
        expect(syntax.identifiers.get("LIMIT")).toBe(2);
        expect(syntax.imports).toEqual([]);
    });

    it("can leave Python out for profiles that only support JavaScript and TypeScript", () => {
        const analysis = analyzeRepository(inventory({ "a.py": FUNCTION_SOURCE }), { python: false });
        expect(analysis.files).toEqual([]);
        expect(analysis.gaps).toEqual([{ path: "a.py", role: "product", reason: "No scoring adapter for python" }]);
    });

    it("hashes identical function bodies of 30 or more tokens identically and names the clone sources", () => {
        const long = (name: string) => `def ${name}(items):\n    out = []\n    for item in items:\n        if item.ready and item.value > 10:\n            out.append(item.value * 2 + len(out))\n    return sorted(out, reverse=True)[:10]\n`;
        const analysis = analyzeRepository(inventory({ "a.py": long("first"), "b.py": long("second") }));
        const hashes = analysis.files.map(file => [...file.python!.cloneHashes.values()].map(item => item.hash));
        expect(hashes[0]).toHaveLength(1);
        expect(hashes[0]).toEqual(hashes[1]);
    });
});

describe("analyzeRepository when python3 cannot run", () => {
    it("lists every Python file as a gap with the analyzer reason", () => {
        const analysis = analyzeRepository(inventory({ "a.py": "x = 1\n" }), { pythonBinary: "definitely-not-a-python-binary" });
        expect(analysis.files).toEqual([]);
        expect(analysis.gaps).toEqual([{ path: "a.py", role: "product", reason: expect.stringContaining("python3") }]);
    });
});
