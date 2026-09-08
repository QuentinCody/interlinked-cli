// ===========================================
// New Import Cycle Detection (delta semantics)
// ===========================================
// Tier 2 structural check — the moment-of-introduction sibling of
// checkImportCycles (cycles.ts). That check reports the CURRENT whole-state
// cycle set through a file (pre-existing debt); this one fires only for the
// SPECIFIC edit that closes a cycle which did not exist immediately before
// it — the cheapest point to prevent it (plan 25, lane 5).
//
// Delta mechanics: ProjectGraph.updateFile() has already re-indexed the
// edited file's import edges by the time PostToolUse structural checks run
// (see server/post-tool-file-checks.ts — updateFile() precedes
// runStructuralChecks()), so by the time this check runs the graph no
// longer holds the file's PRE-edit edges. Rather than thread a new
// "oldImports" capture through the orchestrator (mirroring how oldExports/
// oldInterfaceBodies are captured there today), this module keeps its own
// last-seen snapshot of each file's resolved import targets, updated at the
// end of every call, and diffs the new call against it.
//
// A cycle is NEW exactly when its first hop out of the edited file (the
// file's own outgoing edge) targets a module that was absent from the
// previous snapshot. Editing one file cannot change any OTHER file's
// outgoing edges, so a cycle that uses only unchanged edges necessarily
// existed on the previous call too — only a brand-new edge from the edited
// file can newly close a loop.
//
// Consequence: the first time a file is seen this daemon lifetime, there is
// no baseline to diff against, so the check stays silent even if a cycle
// happens to already be present on that first sighting — accusing an edit
// of introducing debt we have no evidence it introduced would be a false
// positive; that whole-state debt is checkImportCycles' (circular_imports)
// job, not this one's.
//
// event.dry_run (see CLAUDE.md "A dry run must not move the gate"):
// `interlinked harness test --write/--edit` runs this same PostToolUse path
// with a synthetic dry_run event so an agent can preview a verdict without
// ever touching disk. The preview finding is still useful and is returned as
// normal, but the snapshot below is cross-call PERSISTED STATE — writing it
// from a hypothetical probe would let a dry run silently "pre-consume" a
// real edit's new edge, so persistence is skipped whenever event.dry_run is
// true. Taking the whole event (rather than a bare positional boolean)
// mirrors checkCoDependencyStaleness's (filePath, relPath, event, graph, ...)
// convention in misc-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import type { HarnessEvent, StructuralCheckResult } from "../types.js";

/** file (relPath) → resolved absolute import targets as of the last real call. */
const previousImportTargets = new Map<string, Set<string>>();

/**
 * Test-only: clear the cross-call snapshot so test files (and daemon
 * restarts, conceptually) start from a clean "no baseline yet" state.
 */
export function __resetNewImportCycleSnapshotForTesting(): void {
	previousImportTargets.clear();
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 2: Detect the edit that CLOSES an import cycle — the moment a new
 * outgoing edge from the edited file gives an already-existing reverse path
 * a way back home. Silent when the cycle (or lack of one) is unchanged from
 * the last time this file was seen, or when this is the first time the file
 * has been seen this daemon lifetime (no baseline to compare against).
 */
export function checkNewImportCycle(
	filePath: string,
	relPath: string,
	event: HarnessEvent,
	graph: Pick<ProjectGraph, "getDependencies" | "findCyclesThrough" | "toRelative">,
): StructuralCheckResult[] {
	const currentTargets = new Set<string>();
	for (const edge of graph.getDependencies(filePath)) {
		// Unresolved specifiers (bare package imports, etc.) carry an empty
		// toFile and can never be part of a project-internal cycle — skip.
		if (edge.toFile) currentTargets.add(edge.toFile);
	}

	const previousTargets = previousImportTargets.get(relPath);
	// A dry-run probe (`interlinked harness test`) must not advance this
	// file's baseline — only a real edit does.
	if (!event.dry_run) {
		previousImportTargets.set(relPath, currentTargets);
	}

	// No baseline yet this daemon lifetime — can't tell new from
	// pre-existing, so stay silent rather than accuse this edit.
	if (!previousTargets) return [];

	const cycles = graph.findCyclesThrough(filePath);
	if (cycles.length === 0) return [];

	// A cycle is new when its first hop out of the edited file is a target
	// that was not there immediately before this edit.
	const newCycles = cycles.filter((cycle) => {
		const firstHop = cycle[1];
		return firstHop !== undefined && !previousTargets.has(firstHop);
	});
	if (newCycles.length === 0) return [];

	const shortest = nonNull(newCycles.sort((a, b) => a.length - b.length)[0]);
	const cyclePath = shortest.map((f) => graph.toRelative(f)).join(" → ");

	return [
		{
			check: "new_import_cycle",
			severity: "warning",
			message: `This edit introduces a new circular dependency through ${relPath} that did not exist before it: ${cyclePath}.`,
			file: filePath,
			affectedFiles: shortest,
		},
	];
}
