import type { RepositoryAnalysis } from "./analysis.js";
import { qualityFinding, ratioReading } from "./adapter-values.js";
import type { ScoringGraph } from "./graph-types.js";
import type { AdapterResult, QualityFinding } from "./measurement-types.js";
import { reachableModules } from "./scoring-graph.js";

function unusedDeclarations(analysis: RepositoryAnalysis, graph: ScoringGraph): { total: number; findings: QualityFinding[] } {
    const findings: QualityFinding[] = [];
    let total = 0;
    for (const file of analysis.files.filter(item => item.input.role === "product")) {
        const incoming = graph.edges.filter(edge => edge.to === file.input.path);
        for (const declaration of file.syntax.declarations) {
            total++;
            if ((file.syntax.identifiers.get(declaration.name) ?? 0) > 1) continue;
            if (declaration.exported && graph.publicEntries.includes(file.input.path)) continue;
            if (incoming.some(edge => edge.names.includes("*") || edge.names.includes(declaration.name))) continue;
            findings.push(qualityFinding({ metric: "redundancy.unused", file: file.input, line: declaration.line,
                message: `${declaration.name} has no reference in the resolved scope; check external consumers before removal` }));
        }
    }
    return { total, findings };
}

export function measureReachability(analysis: RepositoryAnalysis, graph: ScoringGraph): AdapterResult {
    const products = analysis.files.filter(file => file.input.role === "product");
    const reached = reachableModules(graph.entries, graph.edges.filter(edge => !edge.typeOnly));
    const testRoots = analysis.files.filter(file => file.input.role === "test").map(file => file.input.path);
    const testsReach = reachableModules(testRoots, graph.edges);
    const disconnected = products.filter(file => !reached.has(file.input.path));
    const unused = unusedDeclarations(analysis, graph);
    const findings = [...unused.findings, ...disconnected.map(file => qualityFinding({
        metric: "redundancy.disconnected", file: file.input, line: 1,
        message: testsReach.has(file.input.path) ? "Only tests reach this module through resolved imports; review runtime entry points or unfinished integration"
            : "No declared application entry point reaches this module through resolved imports",
    }))];
    const metrics = [ratioReading("redundancy.unused", unused.findings.length, unused.total),
        ratioReading("redundancy.disconnected", disconnected.length, products.length)];
    for (const metric of metrics) {
        metric.limitations.push("Static reachability candidates; public consumers, reflection, and framework wiring require review.");
        if (graph.dynamic || graph.unresolved.length || !graph.entries.length) metric.state = "inconclusive";
    }
    return { metrics, findings };
}
