// ===========================================
// Rule: Public Symbol Companions
// ===========================================
// When a public symbol's file is in changedFiles, check that
// its declared companion docs, tests, and examples exist.

import type { ArtifactGraph } from "../artifact-graph.js";
import { checkCompanionUpdates } from "./companion-updates.js";
import type { StructureFinding } from "../types.js";

export function checkPublicSymbolCompanions(
	graph: ArtifactGraph,
	changedFiles: string[],
): StructureFinding[] {
	return checkCompanionUpdates(graph, changedFiles, "public_symbol");
}
