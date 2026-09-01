// interlinked-tdd: exempt
// ===========================================
// Project Graph — Import-Cycle Detection
// ===========================================
// Pure DFS cycle detection extracted from `project-graph.ts`. Operates only on
// its inputs (the already-absolute start file and the forward import graph).
// No module-private state.

import type { ImportEdge } from "./types.js";

/**
 * Detect import cycles involving `absPath` (an already-absolute file path).
 * Returns arrays of file paths forming each cycle, or empty if none. Depth is
 * capped to avoid pathological cases.
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
			if (edge.toFile && !edge.isTypeOnly) {
				dfs(edge.toFile, [...path, current]);
			}
		}
		visited.delete(current);
	};

	const startEdges = importGraph.get(absPath) || [];
	for (const edge of startEdges) {
		if (edge.toFile && !edge.isTypeOnly) {
			dfs(edge.toFile, [absPath]);
		}
	}

	return cycles;
}
