import { describe, expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "../types.js";
import { checkLayerBoundaryViolations } from "./layer-boundary.js";

function node(kind: "module" | "layer", id: string, file: string): ArtifactNode {
	return { id: makeGlobalRef(kind, id), kind, label: id, file, provenance: "declared", determinism_ceiling: "fully_deterministic" };
}
function edge(from: string, to: string, kind: "imports" | "belongs_to_layer"): ArtifactEdge {
	return { id: makeEdgeId(from, to), kind, from, to, provenance: "extracted", confidence: 0.9 };
}

describe("checkLayerBoundaryViolations — mutation-directed", () => {
	// test-contract: invariant — a layer violation is a proven (fully deterministic) finding
	it("tags a layer violation fully_deterministic", () => {
		const g = new ArtifactGraph();
		const ui = node("layer", "ui", "."), db = node("layer", "db", ".");
		const uiMod = node("module", "ui-file", "src/ui/a.ts"), dbMod = node("module", "db-file", "src/db/b.ts");
		for (const n of [ui, db, uiMod, dbMod]) g.addNode(n);
		g.addEdge(edge(uiMod.id, ui.id, "belongs_to_layer"));
		g.addEdge(edge(dbMod.id, db.id, "belongs_to_layer"));
		g.addEdge(edge(uiMod.id, dbMod.id, "imports"));
		const findings = checkLayerBoundaryViolations(g, [{ from: ui.id, cannot_import: [db.id] }]);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.determinism).toBe("fully_deterministic");
	});
});
