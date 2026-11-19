import { posix } from "node:path";
import type { AnalyzedFile, RepositoryAnalysis } from "./analysis.js";
import type { Declaration } from "./analysis-syntax.js";
import { qualityFinding, ratioReading } from "./adapter-values.js";
import type { ScoringEdge, ScoringGraph } from "./graph-types.js";
import type { AdapterResult, QualityFinding } from "./measurement-types.js";
import { reachableWithPackageInits } from "./python-entries.js";
import { reachableModules } from "./scoring-graph.js";

/** `import * as ns` in JavaScript, and `import pkg.mod` or `from pkg import mod` in Python (the name binds the module itself), use every export. */
function usesWholeModule(edge: ScoringEdge): boolean {
    if (edge.names.includes("*")) return true;
    if (!edge.to.endsWith(".py")) return false;
    const module = edge.to.endsWith("/__init__.py") ? posix.basename(posix.dirname(edge.to)) : posix.basename(edge.to, ".py");
    return edge.names.includes(module);
}

/** Referenced in its own file, or exported and either in a public entry or named by an importer. */
function referenced(file: AnalyzedFile, declaration: Declaration, graph: ScoringGraph, incoming: readonly ScoringEdge[]): boolean {
    if ((file.syntax.identifiers.get(declaration.name) ?? 0) > 1) return true;
    if (!declaration.exported) return false;
    return graph.publicEntries.includes(file.input.path) || incoming.some(edge => usesWholeModule(edge) || edge.names.includes(declaration.name));
}

function unusedDeclarations(analysis: RepositoryAnalysis, graph: ScoringGraph): { total: number; decorated: number; findings: QualityFinding[] } {
    const findings: QualityFinding[] = [];
    let total = 0, decorated = 0;
    for (const file of analysis.files.filter(item => item.input.role === "product")) {
        const incoming = graph.edges.filter(edge => edge.to === file.input.path);
        for (const declaration of file.syntax.declarations) {
            if (declaration.decorated) { decorated++; continue; }
            total++;
            if (referenced(file, declaration, graph, incoming)) continue;
            findings.push(qualityFinding({ metric: "redundancy.unused", file: file.input, line: declaration.line,
                message: `${declaration.name} has no reference in the resolved scope; check external consumers before removal` }));
        }
    }
    return { total, decorated, findings };
}

function pythonLimitations(pythonProducts: number, decorated: number): string[] {
    if (!pythonProducts) return [];
    const notes = [`Python entry points come from declared scripts (pyproject.toml, setup.cfg, setup.py), \`__main__\` guards and files, and documented \`python\` runs; modules loaded by name from strings (plugins, Django settings, entry-point groups) are not seen.`];
    if (decorated) notes.push(`${decorated} decorated Python declarations are not counted: a decorator may register them when the module loads.`);
    return notes;
}

/** Why a reachability reading cannot be trusted: the graph may lack edges or roots. Empty when the graph is usable. */
function inconclusiveReasons(graph: ScoringGraph): string[] {
    const reasons: string[] = [];
    if (graph.dynamic) reasons.push("The tree imports a module by a computed name (a non-literal require or import_module), so the graph may lack edges.");
    const named = graph.unresolved.filter(item => item.specifier !== null).length;
    if (named) reasons.push(`${named} imports could not be resolved; graph scope is incomplete.`);
    if (!graph.entries.length) reasons.push("No entry point was found, so nothing can be called disconnected.");
    return reasons;
}

export function measureReachability(analysis: RepositoryAnalysis, graph: ScoringGraph): AdapterResult {
    const products = analysis.files.filter(file => file.input.role === "product");
    const pythonProducts = products.filter(file => file.python).length;
    const known = new Set(analysis.files.map(file => file.input.path));
    const reach = (roots: readonly string[]): Set<string> => reachableModules(roots, graph.edges);
    const reached = reachableWithPackageInits(graph.entries, reach, known);
    const testRoots = analysis.files.filter(file => file.input.role === "test").map(file => file.input.path);
    const testsReach = reachableWithPackageInits(testRoots, reach, known);
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
        metric.limitations.push("Static reachability candidates; public consumers, reflection, and framework wiring require review.", ...pythonLimitations(pythonProducts, unused.decorated));
        const reasons = inconclusiveReasons(graph);
        if (reasons.length) {
            metric.state = "inconclusive";
            metric.limitations.push(...reasons);
        }
    }
    return { metrics, findings };
}
