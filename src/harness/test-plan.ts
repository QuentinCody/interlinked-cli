import { hashBytes } from "../lib/metrics/inventory.js";
import { basename, dirname, join } from "node:path";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { buildTestDependencyGraph, testDependencyClosure, type GraphFile, type TestDependencyClosure, type TestDependencyGraph } from "./test-dependency-graph.js";

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
    /** What static selection WOULD have decided (telemetry only when `staticSelection` is off). */
    classifierEstimate?: { omitted: number; reusable: boolean };
}
export interface TestPlanInput {
    /**
     * Let the static effect classifier OMIT unaffected tests and mark a plan REUSABLE. Off by default (operator
     * decision 2026-10-06, option A): three review rounds found classifier escapes (`mkdirSync`, aliased or
     * parenthesized `vi.importActual`, escaped `Function`, `import.meta["url"]`, unhashed environment keys…) that
     * produced false-green plans — a cached pass for a test that now fails, or an affected test left out. With it
     * off every test runs and no result is reused; the classifier's verdict is kept in `classifierEstimate`.
     */
    staticSelection?: boolean;
    inventory: RepositoryInventory;
    tests: string[];
    supportFiles: string[];
    changedPaths: string[];
    dependencies?: Record<string, string[]>;
    historical?: Record<string, { dependencies: string[]; durationMs: number }>;
    uncertainty?: string[];
    full?: boolean;
    /**
     * Discovered tests the repository inventory does not carry (gitignored-but-present scripts, fixture-role files).
     * Selection cannot reason about them, so the whole suite runs, and because their dependencies are unresolved the
     * run is fresh-only evidence: the runtime snapshot hashes their bytes, not what they read.
     */
    outsideInventory?: string[];
    /**
     * src/ fixture modules the score inventory excludes by role. They are import targets with known contents, so a
     * test that imports one stays selectable and a changed fixture selects its importers instead of widening the
     * plan; they are NOT in the identity hash, so a closure that reaches one is never reused.
     */
    extraFiles?: GraphFile[];
}

/**
 * A closure's passing result is reusable evidence only when it reads nothing unhashed (not opaque), repeats (not
 * nondeterministic — the clock, randomness, timers) and every path it reaches is in the identity's inventory.
 */
function reusableClosure(closure: TestDependencyClosure, inventoried: ReadonlySet<string>): boolean {
    return !closure.opaque && !closure.nondeterministic && [...closure.paths].every(path => inventoried.has(path));
}

/**
 * Why the whole suite must run, split by what it says about EVIDENCE:
 * - `scope` reasons are deterministic requests for full coverage (an explicit full run, a changed shared
 *   setup file); the run's inputs are still fully tracked, so its passing result is reusable.
 * - `uncertainty` reasons mean some input is NOT tracked (incomplete inventory, unknown or deleted path,
 *   discovery gaps); such a run proves only that it passed once and can never be reused.
 */
interface FullReasons { scope: string[]; uncertainty: string[]; }

function fullReasons(input: TestPlanInput, graph: TestDependencyGraph): FullReasons {
    const supportClosure = testDependencyClosure(graph, input.supportFiles), support = supportClosure.paths;
    const known = new Set([...input.inventory.files.map(file => file.path), ...(input.extraFiles ?? []).map(file => file.path), ...Object.values(input.dependencies ?? {}).flat()]);
    const config = new Set(input.inventory.files.filter(file => file.role === "configuration").map(file => file.path));
    const scope: string[] = [], uncertainty = [...input.uncertainty ?? []];
    if (input.full) scope.push("Full reconciliation requested");
    // Their bytes are on disk, but their dependencies are unresolved: what they read is unknown, so their pass proves nothing later.
    if (input.outsideInventory?.length) uncertainty.push(`Discovered tests outside analyzed inventory: ${input.outsideInventory.length}`);
    if (graph.incomplete) uncertainty.push("Repository inventory is incomplete");
    if (supportClosure.opaque && input.changedPaths.length) scope.push("Opaque shared setup or configuration");
    for (const path of input.changedPaths) {
        if (support.has(path) || config.has(path)) scope.push(`Shared setup or configuration changed: ${path}`);
        else if (!known.has(path)) uncertainty.push(`Unknown or deleted input: ${path}`);
    }
    return { scope, uncertainty };
}

function companionPrefixes(source: string): string[] {
    const stem = source.replace(/\.[cm]?[jt]sx?$/, "");
    const bases = [stem, join(dirname(stem), "__tests__", basename(stem))];
    return bases.flatMap(base => [`${base}.test.`, `${base}.spec.`]);
}

function companion(test: string, source: string): boolean {
    return companionPrefixes(source).some(prefix => test.startsWith(prefix));
}

/** Invert the prefix lookup once per plan instead of scanning every source for
 * every test. Preserve all prefix matches and the inventory's source order. */
function indexCompanionSources(input: TestPlanInput): Map<string, string[]> {
    const testsByPrefix = new Map<string, string[]>();
    for (const test of new Set(input.tests)) {
        for (const marker of [".test.", ".spec."]) {
            let position = test.indexOf(marker);
            while (position !== -1) {
                const prefix = test.slice(0, position + marker.length);
                const matches = testsByPrefix.get(prefix) ?? [];
                matches.push(test);
                testsByPrefix.set(prefix, matches);
                position = test.indexOf(marker, position + 1);
            }
        }
    }
    const sources = new Map<string, string[]>();
    for (const file of input.inventory.files) {
        const matches = new Set(companionPrefixes(file.path).flatMap(prefix => testsByPrefix.get(prefix) ?? []));
        for (const test of matches) {
            const paths = sources.get(test) ?? [];
            paths.push(file.path);
            sources.set(test, paths);
        }
    }
    return sources;
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

function selectUniverse(input: TestPlanInput, graph: TestDependencyGraph, full: FullReasons): { tests: PlannedTest[]; omitted: string[]; reusable: boolean } {
    const reasons = [...full.scope, ...full.uncertainty];
    // Shared setup and configuration (setupFiles, the vitest config) run in every test; an opaque one may read an
    // external fixture, the network or the clock, so its presence makes ANY run fresh-only — selected or full,
    // whether or not it changed.
    const inventoried = new Set(input.inventory.files.map(file => file.path));
    const supportReusable = reusableClosure(testDependencyClosure(graph, input.supportFiles), inventoried);
    // Once every test is required, avoid an all-sources companion scan for each test. A full run is reusable
    // evidence only when every input is tracked: no uncertainty AND every closure (tests and support) reusable.
    if (reasons.length) {
        const reusable = supportReusable && reusableClosure(testDependencyClosure(graph, input.tests), inventoried);
        return { tests: [...new Set(input.tests)].sort().map(path => ({ path, reasons: [...reasons],
            durationMs: input.historical?.[path]?.durationMs ?? null })), omitted: [], reusable: full.uncertainty.length === 0 && reusable };
    }
    const tests: PlannedTest[] = [], omitted: string[] = [];
    const companions = indexCompanionSources(input);
    let reusable = supportReusable;
    for (const path of [...new Set(input.tests)].sort()) {
        const sources = companions.get(path) ?? [];
        const closure = testDependencyClosure(graph, [path, ...sources]);
        const why = selectionReasons(path, input, closure.paths);
        if (closure.opaque && input.changedPaths.length) why.push("Opaque dependency: rerun on any input change");
        why.push(...reasons);
        if (!why.length) { omitted.push(path); continue; }
        reusable &&= reusableClosure(closure, inventoried);
        tests.push({ path, reasons: why, durationMs: input.historical?.[path]?.durationMs ?? null });
    }
    return { tests, omitted, reusable };
}

/** One union of direct, static, declared, and historically covering tests. Unknowns widen. */
export function buildTestPlan(input: TestPlanInput): TestPlan {
    const changedPaths = [...new Set(input.changedPaths)].sort();
    const normalized = { ...input, changedPaths }, graph = buildTestDependencyGraph(input.inventory, input.extraFiles);
    const full = fullReasons(normalized, graph), estimate = selectUniverse(normalized, graph, full);
    const classifierEstimate = { omitted: estimate.omitted.length, reusable: estimate.reusable };
    if (!input.staticSelection) full.uncertainty.push(STATIC_SELECTION_DISABLED);
    const selection = input.staticSelection ? estimate : selectUniverse(normalized, graph, full);
    const reasons = [...full.scope, ...full.uncertainty];
    const snapshot = hashBytes(JSON.stringify([input.inventory.inputHash, [...input.tests].sort(), input.supportFiles, input.dependencies ?? {}, changedPaths]));
    const estimatedSerialMs = selection.tests.every(test => test.durationMs !== null)
        ? selection.tests.reduce((sum, test) => sum + (test.durationMs ?? 0), 0) : null;
    return { version: 1, snapshot, changedPaths, mode: reasons.length ? "full" : "selected", ...selection, reasons, estimatedSerialMs, classifierEstimate };
}

/** An UNCERTAINTY reason, so the full run it forces is also never reusable evidence. */
const STATIC_SELECTION_DISABLED = "Static test selection and result reuse are disabled: the effect classifier cannot prove a test unaffected or its result repeatable (telemetry only)";
