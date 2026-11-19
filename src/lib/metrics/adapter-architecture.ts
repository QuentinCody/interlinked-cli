import type { RepositoryAnalysis } from "./analysis.js";
import { qualityFinding, ratioReading } from "./adapter-values.js";
import type { AdapterResult } from "./measurement-types.js";
import type { ScoringGraph } from "./graph-types.js";
import { reachableModules } from "./scoring-graph.js";

export interface ImportBoundary { from: string; forbidden: string; }
function under(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix.replace(/\/$/, "")}/`);
}

/** ` (reason: count, ...)` for the unresolved imports that carry a reason, largest first; empty when none does. */
function unresolvedReasons(graph: ScoringGraph): string {
    const counts = new Map<string, number>();
    for (const item of graph.unresolved) if (item.reason) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return ranked.length ? ` (${ranked.map(([reason, count]) => `${reason}: ${count}`).join(", ")})` : "";
}

export function measureArchitecture(analysis: RepositoryAnalysis, graph: ScoringGraph, boundaries: readonly ImportBoundary[] = []): AdapterResult {
    const products = analysis.files.filter(file => file.input.role === "product");
    const paths = new Set(products.map(file => file.input.path));
    const edges = graph.edges.filter(edge => paths.has(edge.from) && paths.has(edge.to));
    const cycles = new Set<string>();
    let pairs = 0;
    for (const path of paths) {
        const reached = reachableModules([path], edges);
        pairs += reached.size - 1;
        if (edges.some(edge => edge.to === path && reached.has(edge.from))) cycles.add(path);
    }
    const violations = edges.filter(edge => boundaries.some(boundary => under(edge.from, boundary.from) && under(edge.to, boundary.forbidden)));
    const metrics = [ratioReading("architecture.cycles", cycles.size, products.length),
        ratioReading("architecture.reach", pairs, products.length * Math.max(0, products.length - 1)),
        ratioReading("architecture.boundaries", violations.length, boundaries.length ? edges.length : 0)];
    const findings = products.filter(file => cycles.has(file.input.path)).map(file => qualityFinding({
        metric: "architecture.cycles", file: file.input, line: 1, evidence: "proven", message: "Module belongs to a resolved dependency cycle" }));
    for (const edge of violations) {
        const file = products.find(item => item.input.path === edge.from);
        if (file) findings.push(qualityFinding({ metric: "architecture.boundaries", file: file.input,
            line: edge.line, evidence: "proven", message: `Import of ${edge.to} violates a declared boundary` }));
    }
    if (graph.unresolved.length) for (const metric of metrics) {
        if (metric.state === "measured") metric.state = "inconclusive";
        metric.limitations.push(`${graph.unresolved.length} imports could not be resolved${unresolvedReasons(graph)}; graph scope is incomplete`);
    }
    return { metrics, findings };
}
