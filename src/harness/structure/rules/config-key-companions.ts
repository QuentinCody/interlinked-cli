// ===========================================
// Rule: Config Key Companions
// ===========================================
// When a config_key node's file is in changedFiles, check that
// its declared companion docs, tests, and examples exist.

import type { ArtifactGraph } from "../artifact-graph.js";
import { checkCompanionUpdates } from "./companion-updates.js";
import type { StructureFinding } from "../types.js";

export function checkConfigKeyCompanions(
	graph: ArtifactGraph,
	changedFiles: string[],
): StructureFinding[] {
	return checkCompanionUpdates(graph, changedFiles, "config_key");
}
