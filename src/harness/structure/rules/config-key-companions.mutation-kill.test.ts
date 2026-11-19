import { describe, expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode } from "../types.js";
import { checkConfigKeyCompanions } from "./config-key-companions.js";

function build(keyProvenance: "declared" | "inferred", docProvenance: "declared" | "inferred"): ArtifactGraph {
	const g = new ArtifactGraph();
	const cfg: ArtifactNode = { id: makeGlobalRef("config_key", "a.b"), kind: "config_key", label: "a.b", file: "src/config.ts", provenance: keyProvenance, determinism_ceiling: "fully_deterministic" };
	const doc: ArtifactNode = { id: makeGlobalRef("doc", "readme"), kind: "doc", label: "README", file: "README.md", provenance: docProvenance, determinism_ceiling: "fully_deterministic" };
	g.addNode(cfg);
	g.addNode(doc);
	g.addEdge({ id: makeEdgeId(cfg.id, doc.id), kind: "documents", from: cfg.id, to: doc.id, provenance: "declared", confidence: 1 });
	return g;
}

// Census fault: the config key's own provenance was no longer part of `allDeclared`
// (docs/reviews/kill-proof-census-e2e-structure.md #18).
describe("checkConfigKeyCompanions — determinism follows the key's own provenance", () => {
	// test-contract: invariant — an inferred config key with a declared companion is partially deterministic at confidence 0.8, never fully deterministic
	it("tags an inferred key partially_deterministic even when every companion is declared", () => {
		const [finding] = checkConfigKeyCompanions(build("inferred", "declared"), ["src/config.ts"]);
		expect(finding?.determinism).toBe("partially_deterministic");
		expect(finding?.confidence).toBe(0.8);
		expect(finding?.provenance).toBe("inferred");
	});
	// test-contract: invariant — a declared key with a declared companion stays fully deterministic at confidence 1
	it("tags a declared key with declared companions fully_deterministic", () => {
		const [finding] = checkConfigKeyCompanions(build("declared", "declared"), ["src/config.ts"]);
		expect(finding?.determinism).toBe("fully_deterministic");
		expect(finding?.confidence).toBe(1);
	});
});
