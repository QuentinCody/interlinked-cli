// interlinked-tdd: exempt
// ===========================================
// Project Graph — Import-Cycle Detection
// ===========================================
// Pure DFS cycle detection extracted from `project-graph.ts`. Operates only on
// its inputs (the already-absolute start file and the forward import graph).
// No module-private state.

import type { ImportEdge } from "./types.js";

/**
 * True when `edge` runs when the module loads: it resolved to a project file,
 * the compiler keeps it, and it is not a lazy `import()` expression.
 */
function isLoadTimeEdge(edge: ImportEdge): boolean {
	return edge.toFile !== "" && !edge.isTypeOnly && edge.isDynamic !== true;
}

/**
 * Detect import cycles involving `absPath` (an already-absolute file path).
 * Returns arrays of file paths forming each cycle, or empty if none. Depth is
 * capped to avoid pathological cases.
 *
 * Dynamic `import()` edges are skipped too: they run lazily, after both modules
 * finished loading, so a loop that needs one cannot deadlock at load time. They
 * stay in the graph for reachability, dead-code and blast-radius readers.
 * KNOWN GAPS: an `import { X }` without `type` whose binding is used only in
 * type positions is elided by TypeScript but still counted as a runtime edge.
 *
 * Type-only edges (`import type { X }`) are skipped: the compiler erases them,
 * so a loop that crosses one cannot execute at runtime. Mirrors Effect's madge
 * `skipTypeImports: true` (effect-ts-harness-additions.md §2.4).
 */
export function findCyclesThroughGraph(
	absPath: string,
	importGraph: Map<string, ImportEdge[]>,
): string[][] {
	const cycles: string[][] = [];
	const visited = new Set<string>();

	const dfs = (current: string, path: string[]): void => {
		if (path.length > 1 && current === absPath) {
			cycles.push([...path, current]);
			return;
		}
		if (visited.has(current)) return;
		if (path.length > 15) return; // Limit depth to avoid pathological cases

		visited.add(current);
		const edges = importGraph.get(current) || [];
		for (const edge of edges) {
			if (isLoadTimeEdge(edge)) {
				dfs(edge.toFile, [...path, current]);
			}
		}
		visited.delete(current);
	};

	const startEdges = importGraph.get(absPath) || [];
	for (const edge of startEdges) {
		if (isLoadTimeEdge(edge)) {
			dfs(edge.toFile, [absPath]);
		}
	}

	return cycles;
}
