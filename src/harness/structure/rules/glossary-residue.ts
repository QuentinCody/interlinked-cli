// ===========================================
// Rule: Glossary Residue
// ===========================================
// Scan changed files for usage of deprecated glossary terms.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactGraph } from "../artifact-graph.js";
import { isStringArray } from "../schema-validator-helpers.js";
import type { ArtifactNode, StructureFinding } from "../types.js";

// -------------------------------------------
// Build deprecated term -> node mapping
// -------------------------------------------

function buildDeprecatedMap(graph: ArtifactGraph): Map<string, ArtifactNode> {
	const declaredTerms = graph.getNodesByKind("term").filter((t) => t.provenance === "declared");
	const map = new Map<string, ArtifactNode>();

	for (const term of declaredTerms) {
		const deprecated = term.metadata?.deprecated;
		if (!isStringArray(deprecated)) {
			continue;
		}
		for (const dep of deprecated) {
			map.set(dep.toLowerCase(), term);
		}
	}

	return map;
}

// -------------------------------------------
// Scan a single file for deprecated terms
// -------------------------------------------

function scanFileForDeprecated(
	file: string,
	repoRoot: string,
	deprecatedMap: Map<string, ArtifactNode>,
): StructureFinding[] {
	let content: string;
	try {
		content = readFileSync(resolve(repoRoot, file), "utf-8");
	} catch {
		return [];
	}

	const contentLower = content.toLowerCase();
	const findings: StructureFinding[] = [];

	for (const [deprecated, term] of deprecatedMap) {
		if (!contentLower.includes(deprecated)) {
			continue;
		}

		findings.push({
			name: "glossary_residue",
			severity: "info",
			message: `File uses deprecated term "${deprecated}" — use "${term.label}" instead`,
			file,
			determinism: "fully_deterministic",
			provenance: "declared",
			artifact_kind: "term",
			artifact_id: term.id,
			required_updates: [
				{
					file,
					kind: "term",
					reason: `Replace deprecated "${deprecated}" with "${term.label}"`,
				},
			],
			confidence: 1.0,
		});
	}

	return findings;
}

// -------------------------------------------
// Main entry point
// -------------------------------------------

export function checkGlossaryResidue(
	graph: ArtifactGraph,
	changedFiles: string[],
	repoRoot: string,
): StructureFinding[] {
	const deprecatedMap = buildDeprecatedMap(graph);
	if (deprecatedMap.size === 0) {
		return [];
	}

	const findings: StructureFinding[] = [];
	for (const file of changedFiles) {
		findings.push(...scanFileForDeprecated(file, repoRoot, deprecatedMap));
	}
	return findings;
}
