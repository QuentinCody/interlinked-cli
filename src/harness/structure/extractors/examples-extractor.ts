// ===========================================
// Examples Extractor — discovers example/demo files
// ===========================================

import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ExtractorMetadata, ExtractorResult } from "../types.js";
import { createWalkBudget, type WalkBudget } from "./bounded-walk.js";
import { walkAndClassify } from "./walk-classify.js";

const EXAMPLE_DIRS = new Set(["examples", "sample", "samples", "demo"]);

export const metadata: ExtractorMetadata = {
	name: "examples-extractor",
	supported_patterns: ["examples/**", "sample/**", "samples/**", "demo/**"],
	output_kinds: ["example"],
	provenance: "inferred",
	max_determinism: "heuristic",
	version: 1,
};

/** A file is an "example" iff one of its directory segments is in EXAMPLE_DIRS
 *  (examples/sample/samples/demo). Pure path logic — the single source of the
 *  example-node shape for the full walk and the per-edited-file refresh. */
export function classifyFile(_repoRoot: string, relPath: string): ExtractorResult {
	const dir = path.dirname(relPath);
	if (dir === "." || !dir.split("/").some((seg) => EXAMPLE_DIRS.has(seg))) {
		return { nodes: [], edges: [] };
	}
	const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
	return {
		nodes: [
			{
				id: makeGlobalRef("example", localId),
				kind: "example",
				label: relPath,
				file: relPath,
				provenance: "inferred",
				determinism_ceiling: "heuristic",
			},
		],
		edges: [],
	};
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	return walkAndClassify(repoRoot, { classify: classifyFile, budget, extractorName: metadata.name });
}
