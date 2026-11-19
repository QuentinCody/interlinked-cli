import { describe, expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import { getImplicitConfig } from "../structure-loader.js";
import type { ArtifactEdge, ArtifactNode, StructureConfig } from "../types.js";
import { evaluateStructureRules } from "./index.js";

function config(): StructureConfig {
	return {
		...getImplicitConfig(),
		builtins: {
			public_symbol_companions: true,
			public_symbol_test_case: false,
			env_key_companions: false,
			config_key_companions: false,
			layer_boundary_violations: true,
			package_boundary_violations: false,
			glossary_residue: false,
		},
	};
}
function node(kind: ArtifactNode["kind"], id: string, file: string, provenance: ArtifactNode["provenance"], metadata?: Record<string, unknown>): ArtifactNode {
	return { id: makeGlobalRef(kind, id), kind, label: id, file, provenance, determinism_ceiling: "fully_deterministic", ...(metadata ? { metadata } : {}) };
}
function edge(from: string, to: string, kind: ArtifactEdge["kind"]): ArtifactEdge {
	return { id: makeEdgeId(from, to), kind, from, to, provenance: "declared", confidence: 1 };
}

describe("evaluateStructureRules — mutation-directed", () => {
	// test-contract: invariant — fully deterministic findings sort before partially deterministic ones, regardless of rule order
	it("sorts a fully_deterministic finding ahead of an earlier-emitted partially_deterministic one", () => {
		const g = new ArtifactGraph();
		// Extracted symbol -> partially_deterministic companion finding (emitted first).
		const sym = node("public_symbol", "foo", "src/foo.ts", "extracted");
		const doc = node("doc", "foo", "docs/foo.md", "declared");
		for (const n of [sym, doc]) g.addNode(n);
		g.addEdge(edge(sym.id, doc.id, "documents"));
		// Layer violation -> fully_deterministic finding (emitted later).
		const db = node("layer", "db", ".", "declared");
		const ui = node("layer", "ui", ".", "declared", { cannot_import: [db.id] });
		const uiMod = node("module", "ui-file", "src/ui/a.ts", "declared"), dbMod = node("module", "db-file", "src/db/b.ts", "declared");
		for (const n of [ui, db, uiMod, dbMod]) g.addNode(n);
		g.addEdge(edge(uiMod.id, ui.id, "belongs_to_layer"));
		g.addEdge(edge(dbMod.id, db.id, "belongs_to_layer"));
		g.addEdge(edge(uiMod.id, dbMod.id, "imports"));
		const findings = evaluateStructureRules(g, config(), ["src/foo.ts"]);
		expect(findings.map((f) => f.name)).toEqual(["layer_boundary_violation", "public_symbol_companion_untouched"]);
		expect(findings.map((f) => f.determinism)).toEqual(["fully_deterministic", "partially_deterministic"]);
	});
});
