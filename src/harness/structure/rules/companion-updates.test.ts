import { expect, it } from "vitest";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import { checkCompanionUpdates } from "./companion-updates.js";

it("retains provenance from untouched companions only", () => {
	const graph = new ArtifactGraph();
	const id = makeGlobalRef("env_key", "PORT");
	graph.addNode({ id, kind: "env_key", label: "PORT", file: "env.ts",
		provenance: "declared", determinism_ceiling: "fully_deterministic" });
	for (const [file, provenance] of [["guide.md", "declared"], ["sample.md", "extracted"]] as const) {
		const doc = makeGlobalRef("doc", file);
		graph.addNode({ id: doc, kind: "doc", label: file, file, provenance, determinism_ceiling: "fully_deterministic" });
		graph.addEdge({ id: makeEdgeId(id, doc), from: id, to: doc, kind: "documents", provenance: "declared", confidence: 1 });
	}
	expect(checkCompanionUpdates(graph, ["env.ts", "sample.md"], "env_key")).toMatchObject([{
		name: "env_key_companion_untouched", affected_files: ["guide.md"], confidence: 1, determinism: "fully_deterministic",
	}]);
});
