import { dirname, join } from "node:path";
import { resolveSourceTarget } from "../lib/metrics/graph-entries.js";
import type { RepositoryInventory } from "../lib/metrics/measurement-types.js";
import { parseTsSource } from "./checks/cyclomatic-ast.js";
import { isTestPath } from "./coverage-test-selector.js";
import { hasExactSyntax } from "./function-tokens/ast-tokens.js";
import { fileEffects } from "./runtime-effects.js";
import { buildTestDependencyGraph, type GraphFile, type TestDependencyGraph } from "./test-dependency-graph.js";

/**
 * Rank the causes of test opacity by the execution time they make non-reusable (verification-efficiency step 1).
 *
 * A test's passing result is reusable only when nothing in its import closure reads an input the check identity
 * does not hash (`runtime-effects.ts`). This module attributes each test's recorded duration to every opaque
 * module in its closure and names the chain through which the cause reaches the costliest test, so phase 4 can fix
 * the highest-cost causes first. It changes nothing about selection or reuse: opaque stays opaque.
 */
export interface OpacityCause {
    /** The opaque module, `<inventory>` for an incomplete inventory. */
    path: string;
    reasons: string[];
    /** Tests whose closure reaches this module. */
    tests: number;
    /** Summed recorded duration of those tests that have one. */
    duration_ms: number;
    /** Tests without a recorded duration: their cost is unknown, never zero. */
    unmeasured_tests: number;
    /** Import chain from the costliest measured affected test to the module. */
    chain: string[];
}
export interface OpacityReport {
    tests: number;
    opaque_tests: number;
    measured_duration_ms: number;
    opaque_duration_ms: number;
    incomplete: boolean;
    causes: OpacityCause[];
    /** Causes beyond `limit`, not shown. */
    omitted: number;
}
export type HistoricalDurations = Readonly<Record<string, { durationMs: number | null }>>;
interface RankOptions { limit?: number; tests?: readonly string[]; supportFiles?: readonly string[]; }

const DEFAULT_LIMIT = 25;

/** Why one module is opaque: its unhashed reads and its unresolved imports, from its own bytes. */
function opacityReasons(file: GraphFile, known: ReadonlySet<string>): string[] {
    const parsed = parseTsSource(file.content, file.path);
    if (!parsed || !hasExactSyntax(parsed)) return ["unparseable module"];
    const effects = fileEffects(parsed);
    const unresolved = effects.specifiers.filter(specifier => !resolveSourceTarget(join(dirname(file.path), specifier), known)).map(specifier => `unresolved import: ${specifier}`);
    return [...new Set([...effects.opaque, ...unresolved])];
}

interface Attribution { tests: Set<string>; duration: number; unmeasured: number; best: { test: string; duration: number; chain: string[] } | null; }

/** Breadth-first closure of one test with parent pointers, so a chain to any reached module can be rebuilt. */
function reach(graph: TestDependencyGraph, test: string, supportFiles: readonly string[]): Map<string, string | null> {
    const parents = new Map<string, string | null>([[test, null]]);
    const queue = [test];
    for (let index = 0; index < queue.length; index++) {
        const path = queue[index]!;
        const targets = path === "<runner support>" ? supportFiles : [...graph.dependencies.get(path) ?? [],
            ...(path === test && supportFiles.length ? ["<runner support>"] : [])];
        for (const target of targets) {
            if (!parents.has(target)) { parents.set(target, path); queue.push(target); }
        }
    }
    return parents;
}

function chainTo(parents: ReadonlyMap<string, string | null>, module: string): string[] {
    const chain: string[] = [];
    for (let current: string | null | undefined = module; current; current = parents.get(current)) chain.unshift(current);
    return chain;
}

function attribute(graph: TestDependencyGraph, tests: readonly string[], historical: HistoricalDurations, supportFiles: readonly string[]): { causes: Map<string, Attribution>; opaqueTests: number; opaqueDuration: number } {
    const causes = new Map<string, Attribution>();
    let opaqueTests = 0, opaqueDuration = 0;
    for (const test of tests) {
        const parents = reach(graph, test, supportFiles);
        const opaque = [...parents.keys()].filter(path => graph.opaqueFiles.has(path));
        if (!opaque.length) continue;
        const duration = historical[test]?.durationMs ?? null;
        opaqueTests += 1; opaqueDuration += duration ?? 0;
        for (const module of opaque) {
            const entry = causes.get(module) ?? { tests: new Set(), duration: 0, unmeasured: 0, best: null };
            entry.tests.add(test);
            if (duration === null) entry.unmeasured += 1; else entry.duration += duration;
            if (duration !== null && (!entry.best || duration > entry.best.duration)) entry.best = { test, duration, chain: chainTo(parents, module) };
            else if (entry.best === null && duration === null) entry.best = { test, duration: -1, chain: chainTo(parents, module) };
            causes.set(module, entry);
        }
    }
    return { causes, opaqueTests, opaqueDuration };
}

/** Rank opacity causes for the inventory's tests (or `options.tests`) by the recorded duration they affect. */
export function rankOpacity(inventory: RepositoryInventory, extra: readonly GraphFile[], historical: HistoricalDurations, options: RankOptions = {}): OpacityReport {
    const graph = buildTestDependencyGraph(inventory, extra);
    const known = new Set([...inventory.files.map(file => file.path), ...extra.map(file => file.path)]);
    const files = new Map<string, GraphFile>([...inventory.files, ...extra].map(file => [file.path, file]));
    const tests = [...new Set(options.tests ?? inventory.files.filter(file => isTestPath(file.path)).map(file => file.path))].sort();
    const support = [...new Set(options.supportFiles ?? [])].sort();
    for (const path of [...tests, ...support]) if (!graph.dependencies.has(path)) graph.opaqueFiles.add(path);
    const measured = tests.reduce((sum, test) => sum + (historical[test]?.durationMs ?? 0), 0);
    const { causes, opaqueTests, opaqueDuration } = attribute(graph, tests, historical, support);
    const ranked: OpacityCause[] = [...causes.entries()].map(([path, entry]) => ({
        path, reasons: files.has(path) ? opacityReasons(files.get(path)!, known) : ["not in inventory"],
        tests: entry.tests.size, duration_ms: entry.duration, unmeasured_tests: entry.unmeasured, chain: entry.best?.chain ?? [path],
    })).sort((a, b) => b.duration_ms - a.duration_ms || b.tests - a.tests || a.path.localeCompare(b.path));
    if (graph.incomplete) {
        const reasons = [...inventory.gaps.map(gap => `inventory incomplete: ${gap.path} (${gap.reason})`), ...inventory.issues.map(issue => `inventory issue: ${issue}`)];
        ranked.unshift({ path: "<inventory>", reasons, tests: tests.length, duration_ms: measured, unmeasured_tests: tests.filter(test => historical[test]?.durationMs == null).length, chain: ["<inventory>"] });
    }
    const limit = options.limit ?? DEFAULT_LIMIT;
    return { tests: tests.length, opaque_tests: graph.incomplete ? tests.length : opaqueTests, measured_duration_ms: measured, opaque_duration_ms: graph.incomplete ? measured : opaqueDuration,
        incomplete: graph.incomplete, causes: ranked.slice(0, limit), omitted: Math.max(0, ranked.length - limit) };
}

function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
}

export function renderOpacityReport(report: OpacityReport): string {
    const lines = [`${report.opaque_tests} of ${report.tests} tests opaque (${seconds(report.opaque_duration_ms)} of ${seconds(report.measured_duration_ms)} recorded duration not reusable)${report.incomplete ? "; inventory incomplete" : ""}`];
    for (const cause of report.causes) {
        lines.push(`  ${cause.path}: ${cause.tests} test(s), ${seconds(cause.duration_ms)}${cause.unmeasured_tests ? ` + ${cause.unmeasured_tests} unmeasured` : ""} — ${cause.reasons.join("; ")}`);
        if (cause.chain.length > 1) lines.push(`    via ${cause.chain.join(" → ")}`);
    }
    if (report.omitted) lines.push(`  … ${report.omitted} more cause(s); raise --limit to see them`);
    if (!report.causes.length) lines.push("  no opacity causes: every test closure is fully tracked");
    return lines.join("\n");
}
