// ===========================================
// Module Extractor — discovers source modules by language extension
// ===========================================

import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { ExtractorMetadata, ExtractorResult } from "../types.js";
import { createWalkBudget, type WalkBudget } from "./bounded-walk.js";
import { walkAndClassify } from "./walk-classify.js";

const EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".rs",
	".go",
	".java",
	".c",
	".cpp",
	".h",
]);

export const metadata: ExtractorMetadata = {
	name: "module-extractor",
	supported_patterns: [...EXTENSIONS].map((e) => `*${e}`),
	output_kinds: ["module"],
	provenance: "extracted",
	max_determinism: "partially_deterministic",
	version: 1,
};

/** Classify ONE file into its module node, if its extension is a source one.
 *  Pure path logic (no fs read) — the single source of the module-node shape for
 *  both the full walk and the per-edited-file incremental refresh. `_repoRoot` is
 *  unused (paths are repo-relative) but kept for a uniform per-file signature. */
export function classifyFile(_repoRoot: string, relPath: string): ExtractorResult {
	if (!EXTENSIONS.has(path.extname(relPath))) return { nodes: [], edges: [] };
	const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
	return {
		nodes: [
			{
				id: makeGlobalRef("module", localId),
				kind: "module",
				label: relPath,
				file: relPath,
				provenance: "extracted",
				determinism_ceiling: "partially_deterministic",
			},
		],
		edges: [],
	};
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	return walkAndClassify(repoRoot, { classify: classifyFile, budget, extractorName: metadata.name });
}
