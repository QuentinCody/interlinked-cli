import type { RepositoryAnalysis } from "./analysis.js";
import { discoverScoringEntries } from "./graph-entries.js";
import type { ScoringEdge, ScoringGraph } from "./graph-types.js";
import { scoringModuleResolver } from "./module-resolution.js";
import { pythonScoringEntries } from "./python-entries.js";
import { pythonDynamicImports, pythonScoringEdges } from "./python-modules.js";
import { pythonUnresolvedImports } from "./python-unresolved.js";
import { componentKind } from "../import-resolution/component-scripts.js";
import type { ImportReference } from "./analysis-syntax.js";
import { componentImports } from "./scoring-components.js";

interface ImportSource { path: string; imports: readonly ImportReference[]; }

/** Single-file components are importers: their script imports become edges, they are not measured. */
function componentSources(analysis: RepositoryAnalysis): ImportSource[] {
    return analysis.inventory.files
        .filter(file => componentKind(file.path) !== null && (file.role === "product" || file.role === "test"))
        .map(file => ({ path: file.path, imports: componentImports(file.path, file.content) }));
}

export function buildScoringGraph(analysis: RepositoryAnalysis): ScoringGraph {
    const known = new Set(analysis.files.map(file => file.input.path));
    const components = componentSources(analysis);
    const nodes = new Set([...known, ...components.map(component => component.path)]);
    const entries = discoverScoringEntries(analysis.inventory, nodes);
    const resolveModule = scoringModuleResolver(analysis.inventory, nodes);
    const edges: ScoringEdge[] = [], unresolved: ScoringGraph["unresolved"] = [];
    let dynamic = false;
    edges.push(...pythonScoringEdges(analysis.files, known));
    const computed = pythonDynamicImports(analysis.files);
    if (computed.length) dynamic = true;
    unresolved.push(...computed, ...pythonUnresolvedImports(analysis.files, analysis.inventory.files.map(file => file.path)));
    const sources: ImportSource[] = [...analysis.files.map(file => ({ path: file.input.path, imports: file.syntax.imports })), ...components];
    for (const source of sources) for (const reference of source.imports) {
        if (reference.specifier === null) { dynamic = true; unresolved.push({ file: source.path, line: reference.line, specifier: null }); continue; }
        const resolved = resolveModule(source.path, reference.specifier);
        if (resolved.kind === "external") continue;
        if (resolved.kind === "local") edges.push({ from: source.path, to: resolved.target, line: reference.line, names: reference.names, typeOnly: reference.typeOnly });
        else unresolved.push({ file: source.path, line: reference.line, specifier: reference.specifier, reason: resolved.reason });
    }
    const python = pythonScoringEntries(analysis.inventory, analysis.files, known);
    return { files: analysis.files, edges, entries: [...new Set([...entries.entries, ...python.entries])].sort(),
        publicEntries: [...new Set([...entries.publicEntries, ...python.publicEntries])].sort(), unresolved, dynamic,
        components: components.map(component => component.path).sort() };
}

export function reachableModules(entries: readonly string[], edges: readonly ScoringEdge[]): Set<string> {
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    const reached = new Set(entries), queue = [...entries];
    for (let index = 0; index < queue.length; index++) {
        for (const next of adjacency.get(queue[index] ?? "") ?? []) {
            if (!reached.has(next)) { reached.add(next); queue.push(next); }
        }
    }
    return reached;
}
