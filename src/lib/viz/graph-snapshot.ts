// ===========================================
// Viz Graph Snapshot — RAM-light topology for the dashboard
// ===========================================
// Projects a ProjectGraph into a flat, serializable node/edge snapshot the
// browser can render ("Cells. Interlinked."). Pure read over the
// already-initialized graph: no disk walk of its own, no whole-file loads.
//
// Two cleanups the force layout depends on:
//   - Edges are deduped to one per ordered (from -> to) pair, so a module
//     imported twice isn't double-springed.
//   - Dangling edges (whose target never resolved to an indexed node) are
//     dropped — the renderer can only place an edge between two real cells.

import type { ProjectGraph } from "../../harness/project-graph.js";
import type { ModuleRole } from "../../harness/types.js";

/** One module/cell in the graph. `id` is the project-relative path. */
interface VizNode {
	id: string;
	role: ModuleRole;
	dependents: number;
	dependencies: number;
	/** Subsystem the cell belongs to: the first path segment of `id` (or "root" for a top-level file). */
	group: string;
}

/** The subsystem a node belongs to — its first path segment, or "root" when top-level. */
export function groupOf(id: string): string {
	const slash = id.indexOf("/");
	return slash > 0 ? id.slice(0, slash) : "root";
}

/** A directed import edge between two cells (both endpoints are real nodes). */
interface VizEdge {
	from: string;
	to: string;
	typeOnly: boolean;
}

export interface VizGraphSnapshot {
	generated_at: string;
	root: string;
	node_count: number;
	edge_count: number;
	/** The single most-depended-upon cell — the "stem". Null on an empty graph. */
	super_hub: { id: string; dependents: number } | null;
	roles: Record<ModuleRole, number>;
	nodes: VizNode[];
	edges: VizEdge[];
}

const EDGE_KEY_SEP = " ";

/**
 * Build a serializable snapshot of the whole graph. O(nodes + edges) over the
 * in-memory maps; safe to call per `/api/graph` request (the server caches it).
 */
export function buildGraphSnapshot(graph: ProjectGraph, rootLabel = ""): VizGraphSnapshot {
	const files = graph.allFiles();
	const nodes: VizNode[] = [];
	const nodeIds = new Set<string>();
	const roles: Record<ModuleRole, number> = { hub: 0, root: 0, internal: 0, leaf: 0 };
	const rawEdges = new Map<string, VizEdge>();
	let superHub: { id: string; dependents: number } | null = null;

	for (const abs of files) {
		const id = graph.toRelative(abs);
		const role = graph.classifyModule(abs);
		const dependents = graph.getDependents(abs).length;
		const deps = graph.getDependencies(abs);

		roles[role] += 1;
		nodeIds.add(id);
		nodes.push({ id, role, dependents, dependencies: deps.length, group: groupOf(id) });
		if (!superHub || dependents > superHub.dependents) {
			superHub = { id, dependents };
		}
		collectEdges(graph, id, deps, rawEdges);
	}

	// Keep only edges whose target also resolved to a real node — a dangling
	// endpoint has nothing to spring against in the layout.
	const edges: VizEdge[] = [];
	for (const edge of rawEdges.values()) {
		if (nodeIds.has(edge.to)) edges.push(edge);
	}

	return {
		generated_at: new Date().toISOString(),
		root: rootLabel,
		node_count: nodes.length,
		edge_count: edges.length,
		super_hub: superHub,
		roles,
		nodes,
		edges,
	};
}

/** Fold a file's import edges into the dedup map (one entry per from->to). */
function collectEdges(
	graph: ProjectGraph,
	fromId: string,
	deps: ReturnType<ProjectGraph["getDependencies"]>,
	out: Map<string, VizEdge>,
): void {
	for (const edge of deps) {
		if (!edge.toFile) continue; // unresolved / external — not drawable
		const toId = graph.toRelative(edge.toFile);
		if (toId === fromId) continue; // ignore self-imports
		const key = fromId + EDGE_KEY_SEP + toId;
		const existing = out.get(key);
		if (existing) {
			// A value import anywhere collapses the pair to a value edge.
			if (!edge.isTypeOnly) existing.typeOnly = false;
		} else {
			out.set(key, { from: fromId, to: toId, typeOnly: edge.isTypeOnly });
		}
	}
}
