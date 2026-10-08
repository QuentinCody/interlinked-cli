import { expect, it } from "vitest";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { buildTestDependencyGraph, runtimeOpacity, testDependencyClosure } from "./test-dependency-graph.js";

function inventory(): RepositoryInventory {
    return { version: "interlinked-source-roles-v3", root: "/repo", discovery: "git", gaps: [],
        excluded: [], issues: [], inputHash: "", sourceHash: "", files: [] };
}

it("preserves dependency resolution and effects after the bounded analysis cache evicts older modules", () => {
    const root = inventory();
    const consumer = { path: "consumer.ts", content: 'import "./dependency"; export const now = Date.now();' };
    const dependency = { path: "dependency.ts", content: "export {};" };
    const before = testDependencyClosure(buildTestDependencyGraph(root, [consumer, dependency]), [consumer.path]);
    // More distinct modules than the cache can retain, with small valid bodies.
    const churn = Array.from({ length: 8193 }, (_, i) => ({ path: `module-${i}.ts`, content: "export {};" }));
    expect(buildTestDependencyGraph(root, churn).dependencies.size).toBe(churn.length);
    const after = testDependencyClosure(buildTestDependencyGraph(root, [consumer, dependency]), [consumer.path]);
    expect(after).toEqual(before);
    expect(after).toEqual({ paths: new Set(["consumer.ts", "dependency.ts"]), opaque: false, nondeterministic: true });
    expect(testDependencyClosure(buildTestDependencyGraph(root, [consumer]), [consumer.path]).opaque).toBe(true);
});

it("keeps the conservative external-reporter opacity rule separate from test dependency classification", () => {
    expect(runtimeOpacity("export const answer = 42;")).toBeNull();
    expect(runtimeOpacity("export const now = Date.now();")).toBe("Date");
    expect(testDependencyClosure(buildTestDependencyGraph(inventory()), ["missing.ts"]))
        .toEqual({ paths: new Set(["missing.ts"]), opaque: false, nondeterministic: false });
});

it("marks a partial inventory uncertain even when every discovered module is transparent", () => {
    const partial = inventory();
    partial.gaps.push({ path: "unreadable.ts", role: "product", reason: "read failed" });
    expect(testDependencyClosure(buildTestDependencyGraph(partial), [])).toEqual({
        paths: new Set(), opaque: true, nondeterministic: false,
    });
});

it("follows JavaScript dependencies while leaving non-module assets out of analysis", () => {
    const mixed = inventory();
    mixed.files = [
        { path: "entry.js", content: 'import "./clock.js";', role: "product", language: "javascript", sha256: "entry" },
        { path: "clock.js", content: "export const now = Date.now();", role: "product", language: "javascript", sha256: "clock" },
        { path: "notes.txt", content: "not JavaScript", role: "asset", language: null, sha256: "notes" },
    ];
    const graph = buildTestDependencyGraph(mixed);
    expect(graph.dependencies.has("notes.txt")).toBe(false);
    expect(testDependencyClosure(graph, ["entry.js"])).toEqual({
        paths: new Set(["entry.js", "clock.js"]), opaque: false, nondeterministic: true,
    });
});
