import { expect, it } from "vitest";
import { buildTestDependencyGraph, testDependencyClosure } from "./test-dependency-graph.js";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";

function graphInventory(files: Record<string, string>): RepositoryInventory {
    return { version: "interlinked-source-roles-v3", root: "/repo", discovery: "git", gaps: [], excluded: [], issues: [], inputHash: "", sourceHash: "",
        files: Object.entries(files).map(([path, content]) => ({ path, content, role: "product", language: "typescript", sha256: content })) };
}

it("limits opaque dependencies to their transitive consumers", () => {
    const graph = buildTestDependencyGraph(graphInventory({
        "pure.ts": "export const value = 1;", "io.ts": 'import fs from "node:fs"; export const read = fs.readFileSync;',
        "pure.test.ts": 'import { value } from "./pure";', "io.test.ts": 'import { read } from "./io";',
    }));
    expect(testDependencyClosure(graph, ["pure.test.ts"])).toEqual({ paths: new Set(["pure.test.ts", "pure.ts"]), opaque: false, nondeterministic: false });
    expect(testDependencyClosure(graph, ["io.test.ts"])).toEqual({ paths: new Set(["io.test.ts", "io.ts"]), opaque: true, nondeterministic: false });
});

it("terminates on cycles and retains unresolved imports as uncertainty", () => {
    const graph = buildTestDependencyGraph(graphInventory({ "a.ts": 'import "./b";', "b.ts": 'import "./a"; import "./missing";' }));
    expect(testDependencyClosure(graph, ["a.ts"])).toEqual({ paths: new Set(["a.ts", "b.ts"]), opaque: true, nondeterministic: false });
});

it.each(['import(target)', 'vi.importActual(target)', 'global["fetch"](url)', 'import { readFileSync } from "node:fs";', 'import { Command } from "commander";'])("widens uncontrolled runtime dependency %s", source => {
    const graph = buildTestDependencyGraph(graphInventory({ "runtime.test.ts": source }));
    expect(testDependencyClosure(graph, ["runtime.test.ts"]).opaque).toBe(true);
});

// test-contract: invariant — the clock, randomness and uninitialized memory make a result unrepeatable without reading any input: the closure is nondeterministic (never reused) but not opaque (not rerun on an unrelated change) (H1, 2026-10-02)
it.each(["new Date()", "Buffer.allocUnsafe(32)[0]", "Math.random()", "setTimeout(done, 1)"])("marks %s nondeterministic, not opaque", source => {
    const graph = buildTestDependencyGraph(graphInventory({ "runtime.test.ts": source }));
    expect(testDependencyClosure(graph, ["runtime.test.ts"])).toMatchObject({ opaque: false, nondeterministic: true });
});

// test-contract: invariant — setup writes do not read unknown inputs, but the
// checkout path is not bound by the cross-checkout identity, so cwd prevents reuse.
it("keeps setup with a checkout path transparent but nondeterministic", () => {
    const setup = 'import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; process.env.HOME = mkdtempSync(join(tmpdir(), "home-")); process.env.ROOT = process.cwd();';
    const graph = buildTestDependencyGraph(graphInventory({ "setup.ts": setup }));
    expect(testDependencyClosure(graph, ["setup.ts"])).toMatchObject({ opaque: false, nondeterministic: true });
});

it("keeps deterministic filesystem outputs and identity-bound environment reads transparent", () => {
    const setup = 'import { writeFileSync } from "node:fs"; writeFileSync("output.txt", process.env.ROOT ?? "fixed fallback");';
    const graph = buildTestDependencyGraph(graphInventory({ "setup.ts": setup }));
    expect(testDependencyClosure(graph, ["setup.ts"])).toMatchObject({ opaque: false, nondeterministic: false });
});

// test-contract: invariant — an extra (fixture) module resolves as an import target with its own dependencies, so its importer is not opaque for an unresolved import
it("resolves imports of extra fixture modules and follows their dependencies", () => {
    const graph = buildTestDependencyGraph(graphInventory({ "a.test.ts": 'import { cases } from "./__fixtures__/cases";', "b.ts": "export const b = 1;" }),
        [{ path: "__fixtures__/cases.ts", content: 'import { b } from "../b"; export const cases = [b];' }]);
    expect(testDependencyClosure(graph, ["a.test.ts"])).toEqual({ paths: new Set(["a.test.ts", "__fixtures__/cases.ts", "b.ts"]), opaque: false, nondeterministic: false });
    expect(testDependencyClosure(buildTestDependencyGraph(graphInventory({ "a.test.ts": 'import { cases } from "./__fixtures__/cases";' })), ["a.test.ts"]).opaque).toBe(true);
});

// test-contract: invariant — reusing syntax analysis must never reuse resolved
// edges: a target can appear, disappear or change precedence between plans.
it("resolves unchanged imports against each current inventory", () => {
    const source = { "consumer.ts": 'import "./target";' };
    const first = buildTestDependencyGraph(graphInventory({ ...source, "target.js": "export {};" }));
    expect(first.dependencies.get("consumer.ts")).toEqual(["target.js"]);
    const replaced = buildTestDependencyGraph(graphInventory({ ...source, "target.ts": "export {};" }));
    expect(replaced.dependencies.get("consumer.ts")).toEqual(["target.ts"]);
    const missing = buildTestDependencyGraph(graphInventory(source));
    expect(testDependencyClosure(missing, ["consumer.ts"]).opaque).toBe(true);
    const restored = buildTestDependencyGraph(graphInventory({ ...source, "target.ts": "export {};" }));
    expect(testDependencyClosure(restored, ["consumer.ts"]).opaque).toBe(false);
});

// test-contract: invariant — content changes, including fixture modules outside
// the inventory hash, must refresh effects and preserve syntax uncertainty.
it("refreshes fixture effects from their bytes and does not retain caller mutations", () => {
    const inventory = graphInventory({ "consumer.ts": 'import "./fixture";' });
    const run = (content: string) => buildTestDependencyGraph(inventory, [{ path: "fixture.ts", content }]);
    const pure = run("export const value = 1;");
    expect(testDependencyClosure(pure, ["consumer.ts"]).opaque).toBe(false);
    pure.dependencies.get("consumer.ts")?.push("invented.ts");
    const clock = run("export const value = Date.now();");
    expect(testDependencyClosure(clock, ["consumer.ts"])).toEqual({
        paths: new Set(["consumer.ts", "fixture.ts"]), opaque: false, nondeterministic: true,
    });
    expect(testDependencyClosure(run('import fs from "node:fs";'), ["consumer.ts"]).opaque).toBe(true);
    expect(testDependencyClosure(run("export const = ;"), ["consumer.ts"]).opaque).toBe(true);
    expect(testDependencyClosure(run("export const value = 1;"), ["consumer.ts"])).toMatchObject({ opaque: false, nondeterministic: false });
});
