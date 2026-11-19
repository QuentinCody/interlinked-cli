import { describe, expect, it } from "vitest";
import { calculateAdoption } from "./adoption.js";
import { ArtifactGraph, makeGlobalRef } from "./artifact-graph.js";
import type { ArtifactNode } from "./types.js";

function node(kind: ArtifactNode["kind"], id: string, provenance: "extracted" | "declared" | "inferred"): ArtifactNode {
	return { id: makeGlobalRef(kind, id), kind, label: id, file: `${id}.ts`, provenance, determinism_ceiling: "fully_deterministic" };
}

describe("calculateAdoption provenance", () => {
	// test-contract: invariant — only declared nodes count as adopted; inferred nodes do not
	it("does not count inferred nodes as declared", () => {
		const g = new ArtifactGraph();
		g.addNode(node("public_symbol", "foo", "extracted"));
		g.addNode(node("public_symbol", "bar", "extracted"));
		g.addNode(node("public_symbol", "guess", "inferred"));
		g.addNode(node("public_symbol", "dec", "declared"));
		expect(calculateAdoption(g, null).public_api).toBe(0.5);
	});
});
