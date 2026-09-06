import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { ArtifactGraph, makeEdgeId, makeGlobalRef } from "../artifact-graph.js";
import type { ArtifactNode } from "../types.js";
import { checkConfigKeyCompanions } from "./config-key-companions.js";

describe("checkConfigKeyCompanions", () => {
	function cfgNode(label: string, file: string): ArtifactNode {
		return {
			id: makeGlobalRef("config_key", label),
			kind: "config_key",
			label,
			file,
			provenance: "declared",
			determinism_ceiling: "fully_deterministic",
		};
	}

	function docNode(label: string, file: string): ArtifactNode {
		return {
			id: makeGlobalRef("doc", label),
			kind: "doc",
			label,
			file,
			provenance: "declared",
			determinism_ceiling: "fully_deterministic",
		};
	}

	function addConfigKeyWithDoc(g: ArtifactGraph, cfg: ArtifactNode, doc: ArtifactNode): void {
		g.addNode(cfg);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(cfg.id, doc.id),
			kind: "documents",
			from: cfg.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});
	}

	it("returns empty without companions", () => {
		const g = new ArtifactGraph();
		g.addNode(cfgNode("server.url", "src/config.ts"));
		expect(checkConfigKeyCompanions(g, ["src/config.ts"])).toEqual([]);
	});

	it("flags untouched companions", () => {
		const g = new ArtifactGraph();
		const cfg = cfgNode("server.url", "src/config.ts");
		const doc: ArtifactNode = {
			id: makeGlobalRef("doc", "readme"),
			kind: "doc",
			label: "README",
			file: "README.md",
			provenance: "declared",
			determinism_ceiling: "fully_deterministic",
		};
		g.addNode(cfg);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(cfg.id, doc.id),
			kind: "documents",
			from: cfg.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		const findings = checkConfigKeyCompanions(g, ["src/config.ts"]);
		expect(findings).toHaveLength(1);
		expect(nonNull(findings[0]).name).toBe("config_key_companion_untouched");
		expect(nonNull(findings[0]).artifact_kind).toBe("config_key");
		expect(nonNull(findings[0]).determinism).toBe("fully_deterministic");
	});

	it("returns empty when every companion is in changedFiles", () => {
		const g = new ArtifactGraph();
		const cfg = cfgNode("server.url", "src/config.ts");
		const doc: ArtifactNode = {
			id: makeGlobalRef("doc", "readme"),
			kind: "doc",
			label: "README",
			file: "README.md",
			provenance: "declared",
			determinism_ceiling: "fully_deterministic",
		};
		g.addNode(cfg);
		g.addNode(doc);
		g.addEdge({
			id: makeEdgeId(cfg.id, doc.id),
			kind: "documents",
			from: cfg.id,
			to: doc.id,
			provenance: "declared",
			confidence: 1,
		});

		expect(checkConfigKeyCompanions(g, ["src/config.ts", "README.md"])).toEqual([]);
	});

	it("skips a config key whose own file is not in changedFiles", () => {
		const g = new ArtifactGraph();
		addConfigKeyWithDoc(
			g,
			cfgNode("server.url", "src/changed.ts"),
			docNode("changed-doc", "docs/changed.md"),
		);
		addConfigKeyWithDoc(
			g,
			cfgNode("server.timeout", "src/untouched.ts"),
			docNode("untouched-doc", "docs/untouched.md"),
		);

		const findings = checkConfigKeyCompanions(g, ["src/changed.ts"]);

		expect(findings.map((f) => f.file)).toEqual(["src/changed.ts"]);
		expect(nonNull(findings[0]).affected_files).toEqual(["docs/changed.md"]);
	});
});
