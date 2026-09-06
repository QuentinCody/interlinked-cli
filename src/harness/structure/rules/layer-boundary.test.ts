import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactEdge, ArtifactNode } from "../types.js";
import { checkLayerBoundaryViolations } from "./layer-boundary.js";

function moduleNode(id: string, file: string): ArtifactNode {
	return {
		id: makeGlobalRef("module", id),
		kind: "module",
		label: id,
		file,
		provenance: "extracted",
		determinism_ceiling: "partially_deterministic",
	};
}

function layerNode(id: string): ArtifactNode {
	return {
		id: makeGlobalRef("layer", id),
		kind: "layer",
		label: id,
		file: ".",
		provenance: "declared",
		determinism_ceiling: "fully_deterministic",
	};
}

function edge(from: string, to: string, kind: "imports" | "belongs_to_layer"): ArtifactEdge {
	return {
		id: makeEdgeId(from, to),
		kind,
		from,
		to,
		provenance: "extracted",
		confidence: 0.9,
	};
}

describe("checkLayerBoundaryViolations", () => {
	it("returns empty when no layerRules are declared", () => {
		const g = new ArtifactGraph();
		expect(checkLayerBoundaryViolations(g, [])).toEqual([]);
	});

	it("flags an import that crosses a forbidden layer boundary", () => {
		const g = new ArtifactGraph();
		const uiLayer = layerNode("ui");
		const dbLayer = layerNode("db");
		const uiMod = moduleNode("ui-file", "src/ui/a.ts");
		const dbMod = moduleNode("db-file", "src/db/b.ts");
		for (const n of [uiLayer, dbLayer, uiMod, dbMod]) g.addNode(n);
		g.addEdge(edge(uiMod.id, uiLayer.id, "belongs_to_layer"));
		g.addEdge(edge(dbMod.id, dbLayer.id, "belongs_to_layer"));
		g.addEdge(edge(uiMod.id, dbMod.id, "imports"));

		const findings = checkLayerBoundaryViolations(g, [
			{ from: uiLayer.id, cannot_import: [dbLayer.id] },
		]);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("layer_boundary_violation");
		expect(nonNull(findings[0]).affected_files).toEqual(["src/db/b.ts"]);
	});

	it("does not flag an import when no forbidden relationship matches", () => {
		const g = new ArtifactGraph();
		const uiLayer = layerNode("ui");
		const libLayer = layerNode("lib");
		const uiMod = moduleNode("ui-file", "src/ui/a.ts");
		const libMod = moduleNode("lib-file", "src/lib/b.ts");
		for (const n of [uiLayer, libLayer, uiMod, libMod]) g.addNode(n);
		g.addEdge(edge(uiMod.id, uiLayer.id, "belongs_to_layer"));
		g.addEdge(edge(libMod.id, libLayer.id, "belongs_to_layer"));
		g.addEdge(edge(uiMod.id, libMod.id, "imports"));

		const findings = checkLayerBoundaryViolations(g, [
			{ from: uiLayer.id, cannot_import: [makeGlobalRef("layer", "db")] },
		]);
		expect(findings).toEqual([]);
	});

	it("skips a forbidden edge whose endpoints were never registered as graph nodes", () => {
		// Layer membership comes from `belongs_to_layer` edges, which reference
		// module refs by id only -- a ref can appear there without the module
		// ever having been added via `g.addNode`. `checkLayerBoundaryViolations`
		// must not assume `graph.getNode(edge.from/to)` succeeds just because a
		// layer edge exists for that ref.
		const g = new ArtifactGraph();
		const uiLayer = layerNode("ui");
		const dbLayer = layerNode("db");
		g.addNode(uiLayer);
		g.addNode(dbLayer);
		const uiModRef = moduleNode("ui-file", "src/ui/a.ts").id;
		const dbModRef = moduleNode("db-file", "src/db/b.ts").id;
		// uiModRef / dbModRef are deliberately never passed to g.addNode.
		g.addEdge(edge(uiModRef, uiLayer.id, "belongs_to_layer"));
		g.addEdge(edge(dbModRef, dbLayer.id, "belongs_to_layer"));
		g.addEdge(edge(uiModRef, dbModRef, "imports"));

		const findings = checkLayerBoundaryViolations(g, [
			{ from: uiLayer.id, cannot_import: [dbLayer.id] },
		]);
		expect(findings).toEqual([]);
	});

	it("treats a blank layer ref as unclassified instead of matching it against the forbidden map", () => {
		// `belongs_to_layer.to` and `layerRules[].from` are both typed `string`,
		// so an empty string is a fully legal (cast-free) layer ref -- it is
		// falsy, which is exactly what the `!sourceLayer || !targetLayer` guard
		// on line 36 exists to catch. Without that guard, `forbidden.get("")`
		// would still resolve to a real Set (because the rule below also keys
		// on `""`) and the pair would be misreported as a forbidden import.
		const g = new ArtifactGraph();
		const dbLayer = layerNode("db");
		const uiMod = moduleNode("ui-file", "src/ui/a.ts");
		const dbMod = moduleNode("db-file", "src/db/b.ts");
		for (const n of [dbLayer, uiMod, dbMod]) g.addNode(n);
		g.addEdge(edge(uiMod.id, "", "belongs_to_layer"));
		g.addEdge(edge(dbMod.id, dbLayer.id, "belongs_to_layer"));
		g.addEdge(edge(uiMod.id, dbMod.id, "imports"));

		const findings = checkLayerBoundaryViolations(g, [{ from: "", cannot_import: [dbLayer.id] }]);
		expect(findings).toEqual([]);
	});
});
