// ===========================================
// Import Cycle Detection
// ===========================================
// Tier 2 structural check — surfaces circular imports involving the
// edited file so the agent can break the cycle before it causes
// initialization issues at runtime.

import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import type { StructuralCheckResult } from "../types.js";

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 2: Detect circular dependency introduction. Returns the shortest
 * cycle involving `filePath`, formatted as a single warning.
 */
export function checkImportCycles(
	filePath: string,
	relPath: string,
	graph: Pick<ProjectGraph, "findCyclesThrough" | "toRelative">,
): StructuralCheckResult[] {
	const cycles = graph.findCyclesThrough(filePath);
	if (cycles.length === 0) return [];

	// Show the shortest cycle
	const shortest = cycles.sort((a, b) => a.length - b.length)[0];
	const cyclePath = nonNull(shortest).map((f) => graph.toRelative(f)).join(" → ");

	return [
		{
			check: "import_cycles",
			severity: "warning",
			message: `Circular dependency detected involving ${relPath}: ${cyclePath}. Circular imports can cause initialization issues and make the code harder to reason about.`,
			file: filePath,
			affectedFiles: nonNull(shortest),
		},
	];
}
