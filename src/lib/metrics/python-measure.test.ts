import { describe, expect, it } from "vitest";
import { hashBytes } from "./inventory.js";
import type { InventoryFile } from "./measurement-types.js";
import { measurePythonFiles, pythonAvailable } from "./python-measure.js";

function file(path: string, content: string): InventoryFile {
    return { path, content, language: "python", role: "product", sha256: hashBytes(content) };
}

const SAMPLE = `"""Module doc is not code."""
from __future__ import annotations
import os, sys as system
from . import sibling
from .pkg import thing as other
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .typing_only import Shape

LIMIT = 3


def plain(a, b):
    """Docstring is excluded."""
    return a + b


def branches(x: int, y: Any = None) -> Any:
    total = 0
    total = x
    if x > 1 and y:
        for i in range(x):
            if i % 2 == 0:
                total += i
            elif i == 3:
                total -= 1
    else:
        total = 2
    return total


class Box:
    def method(self, items):
        try:
            return [i for i in items if i]
        except ValueError:
            return None


if __name__ == "__main__":
    plain(1, 2)
`;

describe.skipIf(!pythonAvailable())("measurePythonFiles", () => {
    const [row] = measurePythonFiles([file("sample.py", SAMPLE)]);
    if (!row || "error" in row) throw new Error("sample must parse");
    const byName = (name: string) => row.functions.find(fn => fn.name === name)!;

    it("counts cyclomatic decisions for if, boolean operators, loops, elif and comprehension filters", () => {
        expect(byName("plain").cyclomatic).toBe(1);
        // base 1 + if + and + for + if + elif = 6
        expect(byName("branches").cyclomatic).toBe(6);
        // base 1 + comprehension (1 + one filter) + except = 4
        expect(byName("Box.method").cyclomatic).toBe(4);
    });

    it("scores cognitive complexity with nesting and flat elif/else", () => {
        expect(byName("plain").cognitive).toBe(0);
        // if(+1) and(+1) for(+2) if(+3) elif(+1) else(+1) = 9
        expect(byName("branches").cognitive).toBe(9);
    });

    it("reports spans, exclusive exposure and Halstead values for every function", () => {
        const plain = byName("plain");
        expect(plain.line).toBe(14);
        expect(plain.endLine).toBe(16);
        expect(plain.tokens).toBeGreaterThan(5);
        expect(plain.exposure).toBe(plain.tokens);
        expect(plain.volume).toBeGreaterThan(0);
        expect(plain.difficulty).toBeGreaterThan(0);
        expect(row.astTokens).toBeGreaterThan(plain.tokens);
    });

    it("extracts imports with relative levels and TYPE_CHECKING marks", () => {
        const names = row.imports.map(item => [item.module, item.level, item.names.join(","), item.typeOnly]);
        expect(names).toContainEqual(["os", 0, "*", false]);
        expect(names).toContainEqual(["sys", 0, "*", false]);
        expect(names).toContainEqual(["", 1, "sibling", false]);
        expect(names).toContainEqual(["pkg", 1, "thing", false]);
        expect(names).toContainEqual(["typing_only", 1, "Shape", true]);
    });

    it("finds a literal initializer that is overwritten before a read, and counts initializers", () => {
        expect(row.deadStores).toEqual([20]);
        expect(row.initializers).toBeGreaterThanOrEqual(4);
    });

    it("counts explicit Any annotations over annotated slots only", () => {
        // x: int, y: Any, return Any
        expect(row.annotationSlots).toBe(3);
        expect(row.anyLines).toEqual([19, 19]);
    });

    it("counts only executable top-level tokens (no defs, classes, imports or docstring)", () => {
        // `LIMIT = 3` (3 tokens) plus the __main__ block
        expect(row.topLevelTokens).toBeGreaterThan(10);
        expect(row.topLevelTokens).toBeLessThan(40);
    });
});

describe.skipIf(!pythonAvailable())("measurePythonFiles clone sequences and errors", () => {
    const body = (name: string) => `def ${name}(items):\n    out = []\n    for item in items:\n        if item.ready and item.value > 10:\n            out.append(item.value * 2 + len(out))\n    return sorted(out, reverse=True)[:10]\n`;
    it("gives identical bodies the same clone sequence and ignores the function name", () => {
        const [a, b] = measurePythonFiles([file("a.py", body("first")), file("b.py", body("second"))]);
        if (!a || !b || "error" in a || "error" in b) throw new Error("must parse");
        expect(a.functions[0]!.cloneTokens).not.toBeNull();
        expect(JSON.stringify(a.functions[0]!.cloneTokens)).toBe(JSON.stringify(b.functions[0]!.cloneTokens));
    });
    it("reports a syntax error as a per-file error with a reason and keeps the other files", () => {
        const rows = measurePythonFiles([file("bad.py", "def broken(:\n"), file("ok.py", "x = 1\n")]);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ error: expect.stringContaining("SyntaxError") });
        expect(rows[1] && "error" in rows[1]).toBe(false);
    });
    it("never executes the analyzed source", () => {
        const [row] = measurePythonFiles([file("boom.py", "import os\nos.system('exit 3')\nraise SystemExit(7)\n")]);
        expect(row && "error" in row).toBe(false);
    });
});

describe("measurePythonFiles without python3", () => {
    it("returns an unavailable reason for every file", () => {
        const rows = measurePythonFiles([file("a.py", "x = 1\n")], "definitely-not-a-python-binary");
        expect(rows).toEqual([{ error: expect.stringContaining("python3") }]);
    });
});
