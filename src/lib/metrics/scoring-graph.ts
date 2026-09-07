import { dirname, join } from "node:path";
import type { RepositoryAnalysis } from "./analysis.js";
import { discoverScoringEntries, resolveSourceTarget } from "./graph-entries.js";
import type { ScoringEdge, ScoringGraph } from "./graph-types.js";

export function buildScoringGraph(analysis: RepositoryAnalysis): ScoringGraph {
    const known = new Set(analysis.files.map(file => file.input.path));
    const entries = discoverScoringEntries(analysis.inventory, known);
    const edges: ScoringEdge[] = [], unresolved: ScoringGraph["unresolved"] = [];
    let dynamic = false;
    for (const file of analysis.files) for (const reference of file.syntax.imports) {
        if (reference.specifier === null) { dynamic = true; unresolved.push({ file: file.input.path, line: reference.line, specifier: null }); continue; }
        if (!reference.specifier.startsWith(".")) continue;
        const target = resolveSourceTarget(join(dirname(file.input.path), reference.specifier), known);
        if (target) edges.push({ from: file.input.path, to: target, line: reference.line, names: reference.names, typeOnly: reference.typeOnly });
        else unresolved.push({ file: file.input.path, line: reference.line, specifier: reference.specifier });
    }
    return { files: analysis.files, edges, ...entries, unresolved, dynamic };
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
