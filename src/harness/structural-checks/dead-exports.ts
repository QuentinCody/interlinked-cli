// ===========================================
// Dead Export Detection
// ===========================================
// Tier 1: flag exports that no file imports. Skips known entry points
// (index/main/server/worker) to avoid nagging about intentional barrels.

import { basename, extname } from "node:path";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol, StructuralCheckResult } from "../types.js";

/**
 * Builds the result for a file with zero importers in the project graph —
 * skips known entry points, and reports every non-default/wildcard export
 * as dead when the file isn't one.
 */
function buildNoImporterResult(
	filePath: string,
	relPath: string,
	exports: ExportedSymbol[],
	deleteSuffix: string,
): StructuralCheckResult[] {
	// Skip index/barrel files and entry points
	const base = basename(filePath, extname(filePath));
	if (base === "index" || base === "main" || base === "server" || base === "worker") return [];

	const exportNames = exports
		.filter((e) => e.name !== "default" && e.name !== "*")
		.map((e) => e.name);
	if (exportNames.length === 0) return [];

	return [
		{
			check: "dead_exports",
			severity: "info",
			message: `${relPath} exports ${exportNames.length} symbol(s) but has no importers in the project. Exports: \`${exportNames.slice(0, 5).join("`, `")}\`${exportNames.length > 5 ? ` +${exportNames.length - 5} more` : ""}.${deleteSuffix}`,
			file: filePath,
		},
	];
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Detect exports with zero importers in the project graph.
 */
export function checkDeadExports(
	filePath: string,
	relPath: string,
	graph: ProjectGraph,
	deadCodeAction?: "flag" | "delete",
): StructuralCheckResult[] {
	// Exports stay caveated under "delete": the graph cannot see
	// runtime/dynamic consumers, so the instruction is verify-then-delete.
	const deleteSuffix =
		deadCodeAction === "delete"
			? ' Action: dead_code_action is "delete" — verify no runtime/dynamic consumer exists (import analysis cannot see them), then delete the unused export(s).'
			: "";
	const exports = graph.getExports(filePath);
	if (exports.length === 0) return [];

	const importers = graph.getImporters(filePath);
	const importedSymbols = new Set<string>();
	for (const edge of importers) {
		for (const sym of edge.symbols) {
			importedSymbols.add(sym);
		}
		// Namespace/wildcard imports use all exports
		if (edge.symbols.length === 0 && importers.length > 0) return [];
	}

	// If no importers at all, all exports are dead
	if (importers.length === 0) {
		return buildNoImporterResult(filePath, relPath, exports, deleteSuffix);
	}

	// Find exports that no importer references
	const deadExports = exports.filter(
		(e) => e.name !== "default" && e.name !== "*" && !importedSymbols.has(e.name),
	);

	if (deadExports.length === 0) return [];

	const names = deadExports.slice(0, 5).map((e) => e.name);
	return [
		{
			check: "dead_exports",
			severity: "info",
			message: `Unused exports in ${relPath}: \`${names.join("`, `")}\`${deadExports.length > 5 ? ` +${deadExports.length - 5} more` : ""}. No file in the project imports them.${deleteSuffix}`,
			file: filePath,
		},
	];
}
