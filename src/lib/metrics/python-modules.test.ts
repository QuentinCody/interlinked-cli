import { describe, expect, it } from "vitest";
import type { AnalyzedFile } from "./analysis.js";
import { pythonDynamicImports, pythonModuleResolver } from "./python-modules.js";
import type { PythonImportRow } from "./python-measure.js";

function ref(module: string, names: string[] = ["*"], level = 0): PythonImportRow {
    return { module, level, names, line: 1, typeOnly: false };
}
const known = new Set(["app/__init__.py", "app/main.py", "app/util.py", "app/sub/__init__.py", "app/sub/leaf.py", "scripts/run.py",
    "scripts/helper.py", "src/lib/core.py", "top.py", "app/models.py"]);
const resolve = pythonModuleResolver(known);

describe("pythonModuleResolver", () => {
    it("resolves absolute imports from the repository root, with and without a leading src directory", () => {
        expect(resolve("top.py", ref("app.util"))).toEqual(["app/util.py"]);
        expect(resolve("top.py", ref("lib.core"))).toEqual(["src/lib/core.py"]);
        expect(resolve("top.py", ref("app.sub"))).toEqual(["app/sub/__init__.py"]);
    });

    it("resolves relative imports by level and lets from-import names pick submodules", () => {
        expect(resolve("app/main.py", ref("util", ["helper"], 1))).toEqual(["app/util.py"]);
        expect(resolve("app/main.py", ref("", ["util", "models"], 1)).sort()).toEqual(["app/models.py", "app/util.py"]);
        expect(resolve("app/sub/leaf.py", ref("util", ["f"], 2))).toEqual(["app/util.py"]);
        expect(resolve("app/sub/__init__.py", ref("", ["leaf"], 1))).toEqual(["app/sub/leaf.py"]);
        expect(resolve("app/sub/leaf.py", ref("", ["leaf"], 1))).toEqual([]);
    });

    it("points a from-import of a non-module name at the package itself, and ignores the package for submodule names", () => {
        expect(resolve("top.py", ref("app", ["VERSION"]))).toEqual(["app/__init__.py"]);
        expect(resolve("top.py", ref("app", ["util"]))).toEqual(["app/util.py"]);
    });

    it("resolves a sibling module from the importing script's own directory", () => {
        expect(resolve("scripts/run.py", ref("helper"))).toEqual(["scripts/helper.py"]);
    });

    it("treats unknown modules as external and never returns a self edge", () => {
        expect(resolve("top.py", ref("numpy.linalg"))).toEqual([]);
        expect(resolve("top.py", ref("os"))).toEqual([]);
        expect(resolve("app/util.py", ref("app.util"))).toEqual([]);
        expect(resolve("top.py", ref("", ["x"], 3))).toEqual([]);
    });
});

describe("pythonDynamicImports", () => {
    const withLines = (path: string, dynamicImports: number[]) => ({ input: { path }, python: { row: { facts: { dynamicImports } } } }) as unknown as AnalyzedFile;

    it("reports each computed import as an unresolved reference with a null specifier, as a non-literal require() is in JavaScript", () => {
        expect(pythonDynamicImports([withLines("a.py", [3, 9]), withLines("b.py", []), { input: { path: "c.ts" } } as unknown as AnalyzedFile]))
            .toEqual([{ file: "a.py", line: 3, specifier: null }, { file: "a.py", line: 9, specifier: null }]);
    });
});
