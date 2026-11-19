import { describe, expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "./artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "./types.js";

function node(kind: "public_symbol" | "doc" | "test", label: string, file: string): ArtifactNode {
	return { id: makeGlobalRef(kind, label), kind, label, file, provenance: "declared", determinism_ceiling: "fully_deterministic" };
}
function edge(kind: "documents" | "tests" | "illustrates", from: string, to: string): ArtifactEdge {
	return { id: makeEdgeId(from, to), kind, from, to, provenance: "declared", confidence: 1 };
}

// Census fault: the `seen.has(companionRef)` guard was dropped (docs/reviews/kill-proof-census-e2e-structure.md #15).
describe("ArtifactGraph.getCompanions — a companion reached by two edges is listed once", () => {
	// test-contract: invariant — two companion edges (one each direction) between a symbol and one doc yield that doc exactly once
	it("lists a doc once when both directions of edges reach it", () => {
		const g = new ArtifactGraph();
		const sym = node("public_symbol", "foo", "src/foo.ts");
		const doc = node("doc", "readme", "README.md");
		g.addNode(sym);
		g.addNode(doc);
		g.addEdge(edge("documents", sym.id, doc.id));
		g.addEdge(edge("documents", doc.id, sym.id));
		const companions = g.getCompanions(sym.id);
		expect(companions.docs.map(n => n.id)).toEqual([doc.id]);
		expect(companions.tests).toEqual([]);
	});
	// test-contract: invariant — the first edge that reaches a companion decides its kind; a later edge of another kind to the same companion adds nothing
	it("does not list the same node under a second kind", () => {
		const g = new ArtifactGraph();
		const sym = node("public_symbol", "foo", "src/foo.ts");
		const other = node("test", "foo-test", "src/foo.test.ts");
		g.addNode(sym);
		g.addNode(other);
		g.addEdge(edge("tests", sym.id, other.id));
		g.addEdge(edge("illustrates", other.id, sym.id));
		const companions = g.getCompanions(sym.id);
		expect(companions.tests.map(n => n.id)).toEqual([other.id]);
		expect(companions.examples).toEqual([]);
	});
});
