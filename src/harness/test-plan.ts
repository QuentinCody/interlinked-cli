import { hashBytes } from "../lib/metrics/inventory.js";
import { basename, dirname, join } from "node:path";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { buildTestDependencyGraph, testDependencyClosure, type TestDependencyGraph } from "./test-dependency-graph.js";

export interface PlannedTest { path: string; reasons: string[]; durationMs: number | null; }
export interface TestPlan {
    version: 1;
    snapshot: string;
    changedPaths: string[];
    mode: "selected" | "full";
    tests: PlannedTest[];
    omitted: string[];
    reasons: string[];
    estimatedSerialMs: number | null;
    reusable: boolean;
    runtimeHash?: string;
    runtimeIssue?: string;
}
export interface TestPlanInput {
    inventory: RepositoryInventory;
    tests: string[];
    supportFiles: string[];
    changedPaths: string[];
    dependencies?: Record<string, string[]>;
    historical?: Record<string, { dependencies: string[]; durationMs: number }>;
    uncertainty?: string[];
    full?: boolean;
}

function fullReasons(input: TestPlanInput, graph: TestDependencyGraph): string[] {
    const supportClosure = testDependencyClosure(graph, input.supportFiles), support = supportClosure.paths;
    const known = new Set([...input.inventory.files.map(file => file.path), ...Object.values(input.dependencies ?? {}).flat()]);
    const config = new Set(input.inventory.files.filter(file => file.role === "configuration").map(file => file.path));
    const reasons = [...input.uncertainty ?? []];
    if (input.full) reasons.push("Full reconciliation requested");
    if (graph.incomplete) reasons.push("Repository inventory is incomplete");
    if (supportClosure.opaque && input.changedPaths.length) reasons.push("Opaque shared setup or configuration");
    for (const path of input.changedPaths) {
        if (support.has(path) || config.has(path)) reasons.push(`Shared setup or configuration changed: ${path}`);
        else if (!known.has(path)) reasons.push(`Unknown or deleted input: ${path}`);
    }
    return reasons;
}

function companion(test: string, source: string): boolean {
    const stem = source.replace(/\.[cm]?[jt]sx?$/, "");
    const bases = [stem, join(dirname(stem), "__tests__", basename(stem))];
    return bases.some(base => test.startsWith(`${base}.test.`) || test.startsWith(`${base}.spec.`));
}

function selectionReasons(path: string, input: TestPlanInput, paths: Set<string>): string[] {
    return input.changedPaths.flatMap(change => {
        if (change === path) return [`Test changed: ${change}`];
        if (paths.has(change)) return [`Transitive dependency changed: ${change}`];
        if (input.dependencies?.[path]?.includes(change)) return [`Declared dependency changed: ${change}`];
        if (input.historical?.[path]?.dependencies.includes(change)) return [`Recorded dependency changed: ${change}`];
        if (companion(path, change)) return [`Companion source changed: ${change}`];
        return [];
    });
}

function selectUniverse(input: TestPlanInput, graph: TestDependencyGraph, reasons: string[]): { tests: PlannedTest[]; omitted: string[]; reusable: boolean } {
    // Once every test is required, avoid an all-sources companion scan for each test.
    if (reasons.length) return { tests: [...new Set(input.tests)].sort().map(path => ({ path, reasons: [...reasons],
        durationMs: input.historical?.[path]?.durationMs ?? null })), omitted: [], reusable: false };
    const tests: PlannedTest[] = [], omitted: string[] = [];
    let reusable = reasons.length === 0;
    for (const path of [...new Set(input.tests)].sort()) {
        const sources = input.inventory.files.filter(file => companion(path, file.path)).map(file => file.path);
        const closure = testDependencyClosure(graph, [path, ...sources]);
        const why = selectionReasons(path, input, closure.paths);
        if (closure.opaque && input.changedPaths.length) why.push("Opaque dependency: rerun on any input change");
        why.push(...reasons);
        if (!why.length) { omitted.push(path); continue; }
        reusable &&= !closure.opaque;
        tests.push({ path, reasons: why, durationMs: input.historical?.[path]?.durationMs ?? null });
    }
    return { tests, omitted, reusable };
}

/** One union of direct, static, declared, and historically covering tests. Unknowns widen. */
export function buildTestPlan(input: TestPlanInput): TestPlan {
    const changedPaths = [...new Set(input.changedPaths)].sort();
    const normalized = { ...input, changedPaths }, graph = buildTestDependencyGraph(input.inventory);
    const reasons = fullReasons(normalized, graph), selection = selectUniverse(normalized, graph, reasons);
    const snapshot = hashBytes(JSON.stringify([input.inventory.inputHash, [...input.tests].sort(), input.supportFiles, input.dependencies ?? {}, changedPaths]));
    const estimatedSerialMs = selection.tests.every(test => test.durationMs !== null)
        ? selection.tests.reduce((sum, test) => sum + (test.durationMs ?? 0), 0) : null;
    return { version: 1, snapshot, changedPaths, mode: reasons.length ? "full" : "selected", ...selection, reasons, estimatedSerialMs };
}
