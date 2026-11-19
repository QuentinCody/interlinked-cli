import { describe, expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "../types.js";
import { checkPackageBoundaryViolations } from "./package-boundary.js";

function node(kind: "module" | "package", id: string, file: string): ArtifactNode {
	return { id: makeGlobalRef(kind, id), kind, label: id, file, provenance: "extracted", determinism_ceiling: "partially_deterministic" };
}

function edge(from: string, to: string, kind: ArtifactEdge["kind"]): ArtifactEdge {
	return { id: makeEdgeId(from, to), kind, from, to, provenance: "extracted", confidence: 0.9 };
}

describe("checkPackageBoundaryViolations affected files", () => {
	// test-contract: public-api — the finding is filed on the importer and lists the imported internal module as affected
	it("names the imported module, not the importer, in affected_files", () => {
		const g = new ArtifactGraph();
		const p1 = node("package", "app", "app/package.json");
		const p2 = node("package", "lib", "lib/package.json");
		const importer = node("module", "app-mod", "app/src/x.ts");
		const internal = node("module", "lib-internal", "lib/src/internals.ts");
		for (const n of [p1, p2, importer, internal]) g.addNode(n);
		g.addEdge(edge(importer.id, p1.id, "belongs_to_package"));
		g.addEdge(edge(internal.id, p2.id, "belongs_to_package"));
		g.addEdge(edge(importer.id, internal.id, "imports"));

		const findings = checkPackageBoundaryViolations(g);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.file).toBe("app/src/x.ts");
		expect(findings[0]?.affected_files).toEqual(["lib/src/internals.ts"]);
	});
});
