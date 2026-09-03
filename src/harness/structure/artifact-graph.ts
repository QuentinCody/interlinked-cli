// ===========================================
// Generic Artifact Structure V1 — Artifact Graph
// ===========================================

import type { ArtifactEdge, ArtifactKind, ArtifactNode, EdgeKind } from "./types.js";

// -------------------------------------------
// Helpers
// -------------------------------------------

export function makeGlobalRef(kind: ArtifactKind, localId: string): string {
	return `${kind}:${localId}`;
}

export function makeEdgeId(from: string, to: string): string {
	return `edge:${from}->${to}`;
}

// -------------------------------------------
// ArtifactGraph
// -------------------------------------------

export class ArtifactGraph {
	private nodes: Map<string, ArtifactNode> = new Map();
	private edges: ArtifactEdge[] = [];
	private edgeIds: Set<string> = new Set();

	// -- Node operations --

	addNode(node: ArtifactNode): void {
		this.nodes.set(node.id, node);
	}

	addEdge(edge: ArtifactEdge): void {
		if (this.edgeIds.has(edge.id)) {
			return;
		}
		this.edgeIds.add(edge.id);
		this.edges.push(edge);
	}

	getNode(globalRef: string): ArtifactNode | undefined {
		return this.nodes.get(globalRef);
	}

	getNodesByKind(kind: ArtifactKind): ArtifactNode[] {
		const result: ArtifactNode[] = [];
		for (const node of this.nodes.values()) {
			if (node.kind === kind) {
				result.push(node);
			}
		}
		return result;
	}

	getNodesByFile(file: string): ArtifactNode[] {
		const result: ArtifactNode[] = [];
		for (const node of this.nodes.values()) {
			if (node.file === file) {
				result.push(node);
			}
		}
		return result;
	}

	// -- Edge queries --

	getEdgesFrom(globalRef: string): ArtifactEdge[] {
		return this.edges.filter((e) => e.from === globalRef);
	}

	getEdgesTo(globalRef: string): ArtifactEdge[] {
		return this.edges.filter((e) => e.to === globalRef);
	}

	getEdgesByKind(kind: EdgeKind): ArtifactEdge[] {
		return this.edges.filter((e) => e.kind === kind);
	}

	// -- Incremental refresh --

	removeNodesByFile(file: string): void {
		const refsToRemove = new Set<string>();
		for (const node of this.nodes.values()) {
			if (node.file === file) {
				refsToRemove.add(node.id);
			}
		}
		for (const ref of refsToRemove) {
			this.nodes.delete(ref);
		}
		// Remove edges that reference any removed node
		this.edges = this.edges.filter((e) => {
			if (refsToRemove.has(e.from) || refsToRemove.has(e.to)) {
				this.edgeIds.delete(e.id);
				return false;
			}
			return true;
		});
	}

	// -- Companion traversal --

	// Resolves one companion edge relative to `globalRef`, following companion
	// edges in both directions:
	// - artifact -> companion (e.g., public_symbol:X -> doc:Y)
	// - companion -> artifact (e.g., doc:Y covers public_symbol:X)
	// Returns null when the edge is not a companion edge for this ref, or the
	// companion has already been seen / can't be resolved to a node. Marks the
	// resolved companion ref as seen as a side effect.
	private resolveCompanionEdge(
		edge: ArtifactEdge,
		globalRef: string,
		seen: Set<string>,
	): { kind: "documents" | "tests" | "illustrates"; node: ArtifactNode } | null {
		if (edge.kind !== "documents" && edge.kind !== "tests" && edge.kind !== "illustrates")
			return null;

		let companionRef: string | null = null;
		if (edge.from === globalRef) companionRef = edge.to;
		else if (edge.to === globalRef) companionRef = edge.from;
		if (!companionRef || seen.has(companionRef)) return null;

		const companionNode = this.nodes.get(companionRef);
		if (!companionNode) return null;
		seen.add(companionRef);

		return { kind: edge.kind, node: companionNode };
	}

	getCompanions(globalRef: string): {
		docs: ArtifactNode[];
		tests: ArtifactNode[];
		examples: ArtifactNode[];
	} {
		const docs: ArtifactNode[] = [];
		const tests: ArtifactNode[] = [];
		const examples: ArtifactNode[] = [];
		const seen = new Set<string>();

		for (const edge of this.edges) {
			const resolved = this.resolveCompanionEdge(edge, globalRef, seen);
			if (!resolved) continue;

			if (resolved.kind === "documents") docs.push(resolved.node);
			else if (resolved.kind === "tests") tests.push(resolved.node);
			else examples.push(resolved.node);
		}

		return { docs, tests, examples };
	}

	// -- Serialization --

	toNodesJson(): { schema_version: 1; nodes: ArtifactNode[] } {
		return {
			schema_version: 1,
			nodes: Array.from(this.nodes.values()),
		};
	}

	toEdgesJson(): { schema_version: 1; edges: ArtifactEdge[] } {
		return {
			schema_version: 1,
			edges: [...this.edges],
		};
	}

	static fromJson(
		nodesData: { nodes: ArtifactNode[] },
		edgesData: { edges: ArtifactEdge[] },
	): ArtifactGraph {
		const graph = new ArtifactGraph();
		for (const node of nodesData.nodes) {
			graph.addNode(node);
		}
		for (const edge of edgesData.edges) {
			graph.addEdge(edge);
		}
		return graph;
	}

	// -- Counts --

	get nodeCount(): number {
		return this.nodes.size;
	}

	get edgeCount(): number {
		return this.edges.length;
	}
}
