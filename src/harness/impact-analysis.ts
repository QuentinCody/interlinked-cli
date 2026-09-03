// ===========================================
// Impact Analysis — PostToolUse blast radius & follow-up tracking
// ===========================================
// Runs after structural checks (no subprocesses). Provides severity
// classification, test impact, and follow-up enforcement.
//
// The dependency-aware facts — module role and dependent count — come
// through a `DependencyView` (plan-08 §3b): the internal regex graph by
// default, or a Supermodel `.graph` shard when a fresh one is present.
// `ProjectGraph` is still passed for path formatting (`toRelative`) and
// test-file discovery, which are not dependency-graph queries and stay
// off the seam.

import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { DependencyView } from "./dependency-view.js";
import type { ProjectGraph } from "./project-graph.js";
import type {
	ExportedSymbol,
	ImpactAnalysisResult,
	ImpactSeverity,
	ModuleRole,
	PendingCompletion,
	SessionTrajectory,
	StructuralCheckResult,
} from "./types.js";

// ===========================================
// Core analysis
// ===========================================

interface ImpactAnalysisConfig {
	/** Dependent count threshold for "high" severity (default: 4) */
	highThreshold: number;
}

/**
 * Analyze the impact of a file edit.
 * Must be called AFTER structural checks have run and the graph has been updated.
 *
 * `view` supplies the dependency-aware facts (module role, dependent
 * count) — the internal regex graph or a fresh Supermodel shard, per
 * `resolveDependencyView`. `graph` is retained for `toRelative` path
 * formatting and test-file discovery, neither of which is a seam query.
 */
export function runImpactAnalysis(
	filePath: string,
	view: DependencyView,
	graph: ProjectGraph,
	oldExports: ExportedSymbol[],
	newExports: ExportedSymbol[],
	structuralResults: StructuralCheckResult[],
	config: ImpactAnalysisConfig,
): ImpactAnalysisResult {
	const moduleRole = view.classifyModule(filePath);
	const dependents = view.getDependents(filePath);
	const dependentCount = dependents.length;

	// Detect export surface change
	const oldNames = new Set(oldExports.map((e) => e.name));
	const newNames = new Set(newExports.map((e) => e.name));
	const removedExports = [...oldNames].filter((n) => !newNames.has(n));
	const exportSurfaceChanged = removedExports.length > 0 || oldNames.size !== newNames.size;

	// Extract breaking files from structural results
	const breakingFiles = collectBreakingFiles(structuralResults);

	// Find test files covering this module
	const testFiles = findTestFiles(filePath, view, graph);

	// Follow-up files = breaking files + interface change affected files
	const followUpFiles = [...breakingFiles];
	for (const result of structuralResults) {
		if (result.check === "interface_change_impact" && result.affectedFiles) {
			for (const f of result.affectedFiles) {
				if (!followUpFiles.includes(f)) followUpFiles.push(f);
			}
		}
	}

	// Classify severity
	const severity = classifySeverity(
		moduleRole,
		dependentCount,
		exportSurfaceChanged,
		breakingFiles.length,
		config.highThreshold,
	);

	const relPath = graph.toRelative(filePath);
	const summary = buildSummary(relPath, severity, moduleRole, dependentCount, breakingFiles);

	return {
		file: filePath,
		severity,
		moduleRole,
		dependentCount,
		breakingFiles,
		testFiles,
		followUpFiles,
		exportSurfaceChanged,
		summary,
	};
}

/**
 * Collect deduplicated affected files from `export_surface` structural results.
 */
function collectBreakingFiles(structuralResults: StructuralCheckResult[]): string[] {
	const breakingFiles: string[] = [];
	for (const result of structuralResults) {
		if (
			result.check === "export_surface" &&
			result.affectedFiles &&
			result.affectedFiles.length > 0
		) {
			for (const f of result.affectedFiles) {
				if (!breakingFiles.includes(f)) breakingFiles.push(f);
			}
		}
	}
	return breakingFiles;
}

// ===========================================
// Severity classification
// ===========================================

function classifySeverity(
	moduleRole: ModuleRole,
	dependentCount: number,
	exportSurfaceChanged: boolean,
	breakingFileCount: number,
	highThreshold: number,
): ImpactSeverity {
	// Critical: hub module with breaking changes
	if ((moduleRole === "hub" || moduleRole === "root") && breakingFileCount > 0) {
		return "critical";
	}

	// High: many dependents with export changes
	if (exportSurfaceChanged && dependentCount >= highThreshold) {
		return "high";
	}

	// Medium: some dependents with export changes, or breaking files exist
	if (breakingFileCount > 0 || (exportSurfaceChanged && dependentCount > 0)) {
		return "medium";
	}

	// Low: leaf file or internal-only change
	return "low";
}

// ===========================================
// Test file discovery
// ===========================================

const TEST_PATTERNS = [".test", ".spec", "_test"];

/**
 * Discover test files for a source file. Dependent-test discovery uses the
 * `DependencyView` (so a Supermodel shard's dependents feed it too);
 * `graph` supplies `toRelative` for display paths.
 */
function findTestFiles(
	filePath: string,
	view: DependencyView,
	graph: ProjectGraph,
): string[] {
	const testFiles: string[] = [];
	const ext = extname(filePath);
	const base = basename(filePath, ext);
	const dir = dirname(filePath);

	// 1. Co-located test files (same directory)
	for (const pattern of TEST_PATTERNS) {
		const candidate = join(dir, `${base}${pattern}${ext}`);
		if (existsSync(candidate)) {
			testFiles.push(graph.toRelative(candidate));
		}
	}

	// __tests__ directory
	const testsDir = join(dir, "__tests__");
	for (const pattern of TEST_PATTERNS) {
		const candidate = join(testsDir, `${base}${pattern}${ext}`);
		if (existsSync(candidate)) {
			testFiles.push(graph.toRelative(candidate));
		}
	}

	// 2. Dependents that are test files (1-hop only, bounded)
	const dependents = view.getDependents(filePath);
	let checked = 0;
	for (const dep of dependents) {
		if (checked >= 50) break;
		checked++;
		const depBase = basename(dep);
		if (TEST_PATTERNS.some((p) => depBase.includes(p))) {
			const relDep = graph.toRelative(dep);
			if (!testFiles.includes(relDep)) {
				testFiles.push(relDep);
			}
		}
	}

	return testFiles;
}

// ===========================================
// Follow-up tracking
// ===========================================

/**
 * Record pending follow-ups in session state for affected files.
 * Merges with existing completions for the same source file.
 */
export function recordImpactFollowUps(
	result: ImpactAnalysisResult,
	session: SessionTrajectory,
): void {
	if (result.followUpFiles.length === 0) return;

	const existing = session.pending_completions.get(result.file);
	if (existing) {
		// Merge: add newly discovered affected files
		for (const f of result.followUpFiles) {
			if (!existing.affected_files.includes(f)) {
				existing.affected_files.push(f);
			}
		}
		existing.description = result.summary;
	} else {
		const completion: PendingCompletion = {
			source_file: result.file,
			affected_files: [...result.followUpFiles],
			resolved_files: new Set(),
			recorded_at_tool_call: session.tool_call_count,
			description: result.summary,
		};
		session.pending_completions.set(result.file, completion);
	}
}

/**
 * Check if the agent is writing to an unrelated file while follow-ups remain.
 * Returns a warning string, or null if no violation.
 */
export function checkFollowUpViolation(
	targetFilePath: string,
	session: SessionTrajectory,
): string | null {
	const unresolvedSources: Array<{ source: string; remaining: string[] }> = [];

	for (const [, completion] of session.pending_completions) {
		const remaining = completion.affected_files.filter(
			(f) => !completion.resolved_files.has(f),
		);
		if (remaining.length === 0) continue;

		// If the target file IS one of the affected files, no violation
		if (
			remaining.includes(targetFilePath) ||
			completion.affected_files.includes(targetFilePath) ||
			completion.source_file === targetFilePath
		) {
			return null;
		}

		unresolvedSources.push({
			source: completion.source_file,
			remaining,
		});
	}

	if (unresolvedSources.length === 0) return null;

	const parts = unresolvedSources.map((u) => {
		const fileList = u.remaining.slice(0, 3).join(", ");
		const more = u.remaining.length > 3 ? ` (+${u.remaining.length - 3} more)` : "";
		return `${u.source} → ${fileList}${more}`;
	});

	return `Unresolved follow-ups from export changes: ${parts.join("; ")}. Update affected files before moving to unrelated work.`;
}

// ===========================================
// Warning formatting
// ===========================================

/**
 * Format impact analysis result into warning strings for the agent.
 * Returns empty array for low severity (don't spam).
 */
export function formatImpactWarning(result: ImpactAnalysisResult, graph: ProjectGraph): string[] {
	if (result.severity === "low") return [];

	const warnings: string[] = [];
	const prefix = "[interlinked:impact_analysis]";

	if (result.severity === "medium") {
		const testInfo =
			result.testFiles.length > 0
				? ` ${result.testFiles.length} test file(s) may need updating.`
				: "";
		warnings.push(`${prefix} ${result.summary}${testInfo}`);
		return warnings;
	}

	// High or critical — multi-line detail
	warnings.push(`${prefix} ${result.summary}`);

	if (result.breakingFiles.length > 0) {
		const files = result.breakingFiles
			.slice(0, 5)
			.map((f) => graph.toRelative(f))
			.join(", ");
		const more =
			result.breakingFiles.length > 5 ? ` (+${result.breakingFiles.length - 5} more)` : "";
		warnings.push(`${prefix} Breaking imports in: ${files}${more}`);
	}

	if (result.testFiles.length > 0) {
		warnings.push(`${prefix} Test files to verify: ${result.testFiles.slice(0, 3).join(", ")}`);
	}

	if (result.followUpFiles.length > 0) {
		warnings.push(
			`${prefix} Update these files before moving on: ${result.followUpFiles
				.slice(0, 5)
				.map((f) => graph.toRelative(f))
				.join(", ")}`,
		);
	}

	return warnings;
}

// ===========================================
// Summary builder
// ===========================================

function buildSummary(
	relPath: string,
	severity: ImpactSeverity,
	moduleRole: ModuleRole,
	dependentCount: number,
	breakingFiles: string[],
): string {
	const label = severity.toUpperCase();

	if (severity === "low") {
		return `${label}: ${relPath} is a ${moduleRole} file with ${dependentCount} dependents. Internal-only change.`;
	}

	if (severity === "medium") {
		const breakMsg =
			breakingFiles.length > 0
				? `${breakingFiles.length} file(s) may break.`
				: `${dependentCount} dependent(s).`;
		return `${label}: ${relPath} (${moduleRole}) export surface changed. ${breakMsg}`;
	}

	const breakMsg =
		breakingFiles.length > 0
			? `Breaks ${breakingFiles.length} file(s).`
			: `${dependentCount} dependents affected.`;
	return `${label}: ${relPath} is a ${moduleRole} module with ${dependentCount} dependents. ${breakMsg}`;
}
