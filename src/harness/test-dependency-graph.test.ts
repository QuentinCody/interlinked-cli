import { expect, it } from "vitest";
import { buildTestDependencyGraph, testDependencyClosure } from "./test-dependency-graph.js";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";

function graphInventory(files: Record<string, string>): RepositoryInventory {
    return { version: "interlinked-source-roles-v2", root: "/repo", discovery: "git", gaps: [], excluded: [], issues: [], inputHash: "", sourceHash: "",
        files: Object.entries(files).map(([path, content]) => ({ path, content, role: "product", language: "typescript", sha256: content })) };
}

it("limits opaque dependencies to their transitive consumers", () => {
    const graph = buildTestDependencyGraph(graphInventory({
        "pure.ts": "export const value = 1;", "io.ts": 'import fs from "node:fs"; export const read = fs.readFileSync;',
        "pure.test.ts": 'import { value } from "./pure";', "io.test.ts": 'import { read } from "./io";',
    }));
    expect(testDependencyClosure(graph, ["pure.test.ts"])).toEqual({ paths: new Set(["pure.test.ts", "pure.ts"]), opaque: false });
    expect(testDependencyClosure(graph, ["io.test.ts"])).toEqual({ paths: new Set(["io.test.ts", "io.ts"]), opaque: true });
});

it("terminates on cycles and retains unresolved imports as uncertainty", () => {
    const graph = buildTestDependencyGraph(graphInventory({ "a.ts": 'import "./b";', "b.ts": 'import "./a"; import "./missing";' }));
    expect(testDependencyClosure(graph, ["a.ts"])).toEqual({ paths: new Set(["a.ts", "b.ts"]), opaque: true });
});

it.each(['import(target)', 'vi.importActual(target)', 'new Date()', 'global["fetch"](url)'])("widens uncontrolled runtime dependency %s", source => {
    const graph = buildTestDependencyGraph(graphInventory({ "runtime.test.ts": source }));
    expect(testDependencyClosure(graph, ["runtime.test.ts"]).opaque).toBe(true);
});
