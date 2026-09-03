// ===========================================
// Docs Extractor — discovers documentation files
// ===========================================

import * as path from "node:path";
import { makeGlobalRef } from "../artifact-graph.js";
import type { DocKind, ExtractorMetadata, ExtractorResult } from "../types.js";
import { createWalkBudget, type WalkBudget } from "./bounded-walk.js";
import { walkAndClassify } from "./walk-classify.js";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst"]);

/** Path segment that classifies a doc as reference material rather than a guide. */
const DOCS_DIR_SEGMENT = "docs";

export const metadata: ExtractorMetadata = {
	name: "docs-extractor",
	supported_patterns: ["*.md", "*.mdx", "*.rst", "README*"],
	output_kinds: ["doc"],
	provenance: "inferred",
	max_determinism: "heuristic",
	version: 1,
};

function classifyDoc(relPath: string, name: string): DocKind {
	if (/^README/i.test(name)) return "readme";
	const parts = relPath.split("/");
	if (parts.some((p) => p.toLowerCase() === DOCS_DIR_SEGMENT)) return "reference";
	return "guide";
}

/** Classify ONE file into its doc node, if it is one. Pure path/name logic (no
 *  fs read), so it is cheap to call per-edited-file in the incremental refresh
 *  as well as per-walked-file in the full extract — the single source of the
 *  doc-node shape for both paths. `_repoRoot` is unused here (paths are already
 *  repo-relative) but kept for a uniform per-file extractor signature. */
export function classifyFile(_repoRoot: string, relPath: string): ExtractorResult {
	const name = path.basename(relPath);
	const ext = path.extname(name);
	if (!DOC_EXTENSIONS.has(ext) && !/^README/i.test(name)) return { nodes: [], edges: [] };
	const localId = relPath.replace(/\//g, "-").replace(/\.[^.]+$/, "");
	return {
		nodes: [
			{
				id: makeGlobalRef("doc", localId),
				kind: "doc",
				label: relPath,
				file: relPath,
				provenance: "inferred",
				determinism_ceiling: "heuristic",
				metadata: { doc_kind: classifyDoc(relPath, name) },
			},
		],
		edges: [],
	};
}

export function extract(repoRoot: string, budget: WalkBudget = createWalkBudget()): ExtractorResult {
	return walkAndClassify(repoRoot, { classify: classifyFile, budget, extractorName: metadata.name });
}
