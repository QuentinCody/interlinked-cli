// ===========================================
// Simplification review — explicit coverage receipt
// ===========================================

import { existsSync } from "node:fs";
import { extname, join, relative } from "node:path";
import type {
	SimplificationCoverageExclusion,
	SimplificationCoverageReceipt,
	SimplificationFinding,
	SimplificationScopeReceipt,
	SimplificationSourceCoverage,
} from "../lib/simplification-types.js";
import { LOCAL_SIMPLIFICATION_EXTENSIONS } from "./simplify-detectors.js";

function normalizedRel(cwd: string, path: string): string {
	return relative(cwd, path).replace(/\\/g, "/");
}

function selectedPaths(
	cwd: string,
	discovered: string[],
	scope: SimplificationScopeReceipt,
): string[] {
	return scope.selected_paths ?? discovered.map((path) => normalizedRel(cwd, path));
}

function isSupported(cwd: string, path: string): boolean {
	return existsSync(join(cwd, path))
		&& LOCAL_SIMPLIFICATION_EXTENSIONS.has(extname(path).toLowerCase());
}

function isUnsupportedExisting(cwd: string, path: string): boolean {
	return existsSync(join(cwd, path))
		&& !LOCAL_SIMPLIFICATION_EXTENSIONS.has(extname(path).toLowerCase());
}

function exclusion(rule: string, paths: string[]): SimplificationCoverageExclusion {
	return { rule, count: paths.length, sample: paths.slice(0, 10) };
}

function overallStatus(
	sources: SimplificationSourceCoverage[],
	missing: string[],
	unsupported: string[],
	unanalyzed: string[],
): SimplificationCoverageReceipt["status"] {
	if (sources.length > 0 && sources.every((source) => source.status === "unavailable")) {
		return "unavailable";
	}
	if (
		missing.length > 0
		|| unsupported.length > 0
		|| unanalyzed.length > 0
		|| sources.some((source) => source.status !== "checked")
	) {
		return "partial";
	}
	return "complete";
}

function sourceOwnsFinding(source: string, findingSource: string): boolean {
	if (source === "deadcode.reachability-and-categorization") {
		return findingSource.startsWith("deadcode.") || findingSource.startsWith("mutation.");
	}
	if (source === "opportunity.advisory-patterns") {
		return findingSource.startsWith("opportunity.") || findingSource.startsWith("metrics.");
	}
	return findingSource === source || findingSource.startsWith(`${source}.`);
}

function scopedSources(
	sources: SimplificationSourceCoverage[],
	findings: SimplificationFinding[],
	selected: readonly string[],
): SimplificationSourceCoverage[] {
	const selectedSet = new Set(selected);
	return sources.map((source) => {
		const analyzedPaths = source.analyzed_paths.filter((path) => selectedSet.has(path));
		return {
			...source,
			files_considered: analyzedPaths.length,
			analyzed_paths: analyzedPaths,
			findings_emitted: findings.filter((finding) =>
				sourceOwnsFinding(source.source, finding.source),
			).length,
		};
	});
}

interface CoverageReceiptOptions {
	cwd: string;
	discovered: string[];
	scope: SimplificationScopeReceipt;
	sources: SimplificationSourceCoverage[];
	findings: SimplificationFinding[];
}

export function buildSimplificationCoverage(
	options: CoverageReceiptOptions,
): SimplificationCoverageReceipt {
	const discoveredRel = options.discovered.map((path) => normalizedRel(options.cwd, path));
	const selected = selectedPaths(options.cwd, options.discovered, options.scope);
	const missing = selected.filter((path) => !existsSync(join(options.cwd, path))).sort();
	const supported = selected.filter((path) => isSupported(options.cwd, path));
	const unsupported = selected.filter((path) => isUnsupportedExisting(options.cwd, path));
	const sources = scopedSources(options.sources, options.findings, selected);
	const analyzedPathSet = new Set(sources.flatMap((source) => source.analyzed_paths));
	const analyzed = supported.filter((path) => analyzedPathSet.has(path));
	const unanalyzed = supported.filter((path) => !analyzedPathSet.has(path));
	const unsupportedExtensions = [
		...new Set(unsupported.map((path) => extname(path) || "<none>")),
	].sort();
	return {
		status: overallStatus(sources, missing, unsupported, unanalyzed),
		discovered_files: discoveredRel.length,
		selected_files: selected.length,
		analyzed_files: analyzed.length,
		excluded_files: selected.length - analyzed.length,
		missing_paths: missing,
		included_paths: [
			"**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
			"src/**/* for dead-code reachability",
		],
		excluded_paths: [
				exclusion("unsupported local simplification language", unsupported),
				exclusion("selected path is deleted or unreadable", missing),
				exclusion("supported path was not inspected by a local detector", unanalyzed),
		].filter((group) => group.count > 0),
		languages: [
			{
				language: "javascript/typescript",
				extensions: [...LOCAL_SIMPLIFICATION_EXTENSIONS].sort(),
				status: "checked",
				files: supported.length,
				reason: null,
			},
			{
				language: "other",
				extensions: unsupportedExtensions,
				status: unsupported.length > 0 ? "skipped" : "checked",
				files: unsupported.length,
				reason: unsupported.length > 0
					? "No local simplification detector is registered for these extensions."
					: null,
			},
		],
		sources,
		limitations: [
			"Static reachability cannot prove runtime-loaded, reflected, framework-wired, or public API code is unused.",
			"Local detectors currently cover JavaScript and TypeScript; stdlib/native replacements and the safety of every shrink candidate require semantic review.",
			"No candidate patch, typecheck, test, security check, or mutation run was executed by this read-only command.",
			"Analyzed-file counts include only selected paths named in at least one detector's exact read receipt.",
			"Estimated impacts may overlap and must not be summed; validated impact remains null until a patch is independently checked.",
		],
	};
}
