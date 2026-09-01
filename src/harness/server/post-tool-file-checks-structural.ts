// interlinked-tdd: exempt
// ===========================================
// PostToolUse — structural-checks block helpers
// ===========================================
// Six cohesive sub-steps of the per-file structural pipeline, extracted
// VERBATIM from `post-tool-file-checks.ts` to keep the orchestrator module
// under the line cap. Each holds the logic of one sub-step
// (collect → apply findings → impact/fallback → error-memory → fix-memory →
// deletion-hygiene); `runStructuralChecksForFile` in the main module composes
// them. Leaf cluster: nothing here imports back from the orchestrator.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { STRUCTURAL_CHECK_META } from "../check-metadata.js";
import { checkOrphanedTests } from "../deletion-hygiene.js";
import { resolveDependencyView } from "../dependency-view.js";
import { ErrorHistory } from "../error-history.js";
import {
	formatImpactWarning,
	recordImpactFollowUps,
	runImpactAnalysis,
} from "../impact-analysis.js";
import type { ProjectGraph } from "../project-graph.js";
import { isAcknowledged } from "../session-state.js";
import { formatStructuralWarnings, runStructuralChecks } from "../structural-checks.js";
import { loadFileSuppressions } from "../suppressions.js";
import type {
	CheckResultEntry,
	ExportedSymbol,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
	StructuralCheckResult,
	StructuralChecksConfig,
} from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/**
 * Run the structural checks for one file, then apply JSON-suppression and
 * session-ack filtering. Returns the surviving results. Records "structural"
 * in `checksRan` (matching the original side effect ordering).
 */
export function collectStructuralResults(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	session: SessionTrajectory,
	editedFilePath: string,
	fileGraph: ProjectGraph,
	structuralConfig: StructuralChecksConfig,
	oldExports: ExportedSymbol[],
	oldInterfaceBodies: Map<string, string>,
	checksRan: string[],
): StructuralCheckResult[] {
	const CWD = ctx.cwd;
	const rawStructuralResults = runStructuralChecks(
		checkEvent,
		structuralConfig,
		fileGraph,
		ctx.sessions,
		oldExports,
		oldInterfaceBodies,
	);
	checksRan.push("structural");

	// --- File-level suppression for structural checks ---
	// Only JSON suppressions apply (inline comments don't make sense
	// for cross-file structural checks).
	const structRelPath = relative(CWD, editedFilePath);
	const structFileSup = loadFileSuppressions(join(CWD, ".interlinked"), structRelPath);
	const afterSuppression = rawStructuralResults.filter((r) => !structFileSup.has(r.check));

	// --- Session-ack suppression for structural checks ---
	// If the user already saw a warning for this file+check and let
	// the agent continue, skip re-firing warnings (errors always re-fire).
	return afterSuppression.filter(
		(r) => r.severity === "error" || !isAcknowledged(session, editedFilePath, r.check),
	);
}

/**
 * Collect structural findings into `allCheckResults`, append their warnings,
 * raise the block decision on deterministic actionable findings, and record
 * failed files for recently-failed-here tracking. Mutates `allCheckResults`,
 * `decision`, and `session` in place.
 */
export function applyStructuralFindings(
	structuralResults: StructuralCheckResult[],
	editedFilePath: string,
	event: HarnessEvent,
	session: SessionTrajectory,
	decision: HarnessDecision,
	allCheckResults: CheckResultEntry[],
	log: (msg: string) => void,
): void {
	// Collect structured results for local persistence
	for (const r of structuralResults) {
		allCheckResults.push({
			source: "structural",
			name: r.check,
			severity: r.severity,
			message: r.message,
			file: r.file,
			detail: r.detail,
			affected_files: r.affectedFiles,
			determinism: STRUCTURAL_CHECK_META[r.check]?.determinism ?? "heuristic",
		});
	}

	const structWarnings = formatStructuralWarnings(structuralResults);
	decision.warnings = [...(decision.warnings || []), ...structWarnings];

	// Block only on fully_deterministic findings with error/warning severity.
	// Heuristic/partial findings (blast_radius, test_proximity, etc.) are advisory only.
	const hasDeterministicActionable = structuralResults.some(
		(r) =>
			(r.severity === "error" || r.severity === "warning") &&
			STRUCTURAL_CHECK_META[r.check]?.determinism === "fully_deterministic",
	);
	if (hasDeterministicActionable) {
		decision.decision = "block";
		// Rule id = lead deterministic finding's check name, so block telemetry
		// aggregates by cause instead of landing in the null-id bucket.
		const leadCheck = structuralResults.find(
			(r) =>
				(r.severity === "error" || r.severity === "warning") &&
				STRUCTURAL_CHECK_META[r.check]?.determinism === "fully_deterministic",
		);
		decision.rule_id ??= leadCheck?.check;
		// Bug B1: a PostToolUse block MUST carry a reason (else the hook shows the
		// "no reason was attached" fallback). Surface the structural findings.
		decision.reason ??=
			(decision.warnings ?? []).join("\n") ||
			"[interlinked] PostToolUse structural checks flagged a deterministic issue.";
	}

	log(`Structural issues: ${structuralResults.map((r) => r.check).join(", ")}`);

	// Record failed files for recently-failed-here tracking
	const failedChecks = structuralResults
		.filter((r) => r.severity === "error" || r.severity === "warning")
		.map((r) => r.check);
	if (failedChecks.length > 0) {
		session.failed_files.set(editedFilePath, {
			failure_count: failedChecks.length,
			checks: [...new Set(failedChecks)],
			recorded_at: event.timestamp,
			tool_call_count: session.tool_call_count,
		});
	}
}

/**
 * Run impact analysis (fast, graph-only) when enabled, surfacing its warnings
 * and blocking on critical impact; otherwise fall back to recording pending
 * completions from export-surface findings. Mutates `decision` and `session`.
 */
export function runImpactOrFallback(
	ctx: ServerRuntime,
	editedFilePath: string,
	fileGraph: ProjectGraph,
	structuralConfig: StructuralChecksConfig,
	oldExports: ExportedSymbol[],
	structuralResults: StructuralCheckResult[],
	session: SessionTrajectory,
	decision: HarnessDecision,
	log: (msg: string) => void,
): void {
	// --- Impact analysis (fast, graph-only, no subprocesses) ---
	if (structuralConfig.impact_analysis && editedFilePath) {
		const newExportsForImpact = fileGraph.getExports(editedFilePath);
		// Dependency facts come through the seam: a fresh Supermodel
		// `.graph` shard when present, the internal graph otherwise.
		const depView = resolveDependencyView(editedFilePath, ctx.cwd, fileGraph);
		const impactResult = runImpactAnalysis(
			editedFilePath,
			depView,
			fileGraph,
			oldExports,
			newExportsForImpact,
			structuralResults,
			{ highThreshold: structuralConfig.impact_high_threshold },
		);

		// Record follow-ups in session state (replaces inline pending_completions)
		recordImpactFollowUps(impactResult, session);

		// Format warnings
		const impactWarnings = formatImpactWarning(impactResult, fileGraph);
		if (impactWarnings.length > 0) {
			decision.warnings = [...(decision.warnings || []), ...impactWarnings];
		}

		// Critical impact blocks so the agent reads the warning
		if (impactResult.severity === "critical") {
			decision.decision = "block";
			decision.rule_id ??= "impact-critical";
			// Bug B1: a PostToolUse block MUST carry a reason.
			decision.reason ??=
				(decision.warnings ?? []).join("\n") ||
				`[interlinked] Critical cross-file impact: ${impactResult.dependentCount} dependent(s), ${impactResult.breakingFiles.length} breaking file(s).`;
		}

		log(
			`Impact analysis: ${impactResult.severity} (${impactResult.dependentCount} dependents, ${impactResult.breakingFiles.length} breaking)`,
		);
	} else {
		// Fallback: record pending completions without full impact analysis
		const exportResults = structuralResults.filter(
			(r) =>
				r.check === "export_surface" && r.affectedFiles && r.affectedFiles.length > 0,
		);
		for (const result of exportResults) {
			session.pending_completions.set(editedFilePath, {
				source_file: editedFilePath,
				affected_files: result.affectedFiles!,
				resolved_files: new Set(),
				recorded_at_tool_call: session.tool_call_count,
				description: result.message,
			});
		}
	}
}

/**
 * Record each error/warning structural finding in the cross-session error
 * history, deriving the edit's line number from `old_string` when readable.
 */
export async function recordStructuralErrorMemory(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	event: HarnessEvent,
	session: SessionTrajectory,
	editedFilePath: string,
	fileGraph: ProjectGraph,
	structuralResults: StructuralCheckResult[],
): Promise<void> {
	const relPath = fileGraph.toRelative(editedFilePath);
	const fileRole = fileGraph.classifyModule(editedFilePath);
	const currentExports = fileGraph.getExports(editedFilePath).map((e) => e.name);
	const dependentCount = fileGraph.getDependents(editedFilePath).length;
	const dependencyCount = fileGraph.getDependencies(editedFilePath).length;

	for (const result of structuralResults) {
		if (result.severity === "error" || result.severity === "warning") {
			const editOldString = checkEvent.tool_input?.old_string as string | undefined;
			const editNewString = checkEvent.tool_input?.new_string as string | undefined;
			const editContent = checkEvent.tool_input?.content as string | undefined;
			const diffContext = ErrorHistory.buildErrorContext({
				file: relPath,
				fileRole,
				dependentCount,
				dependencyCount,
				exports: currentExports,
				result,
				...(editOldString !== undefined ? { oldString: editOldString } : {}),
				...(editNewString !== undefined ? { newString: editNewString } : {}),
				...(editContent !== undefined ? { content: editContent } : {}),
			});
			// Estimate line number from old_string position
			let lineStart: number | undefined;
			const oldStr = checkEvent.tool_input?.old_string as string | undefined;
			if (oldStr) {
				try {
					const content = readFileSync(editedFilePath, "utf-8");
					const idx = content.indexOf(oldStr);
					if (idx >= 0) lineStart = content.slice(0, idx).split("\n").length;
				} catch (e) {
					void e;
				}
			}

			await ctx.errorHistory.recordError(
				event.session_id,
				session.agent_name,
				relPath,
				fileRole,
				result,
				diffContext,
				{
					...(lineStart !== undefined ? { line_start: lineStart } : {}),
					co_edited_files: [...session.files_written]
						.map((f) => fileGraph.toRelative(f))
						.filter((f) => f !== relPath),
					pre_error_sequence: [...session.tool_sequence],
				},
			);
		}
	}
}

/** Record a fix in the cross-session error history on a clean structural pass. */
export function recordStructuralFixMemory(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	editedFilePath: string,
	fileGraph: ProjectGraph,
): void {
	const relPath = fileGraph.toRelative(editedFilePath);
	const queryOldString = checkEvent.tool_input?.old_string as string | undefined;
	const queryNewString = checkEvent.tool_input?.new_string as string | undefined;
	const queryContent = checkEvent.tool_input?.content as string | undefined;
	const fixContext = ErrorHistory.buildQueryContext({
		file: relPath,
		fileRole: fileGraph.classifyModule(editedFilePath),
		dependentCount: fileGraph.getDependents(editedFilePath).length,
		dependencyCount: fileGraph.getDependencies(editedFilePath).length,
		exports: fileGraph.getExports(editedFilePath).map((e) => e.name),
		...(queryOldString !== undefined ? { oldString: queryOldString } : {}),
		...(queryNewString !== undefined ? { newString: queryNewString } : {}),
		...(queryContent !== undefined ? { content: queryContent } : {}),
	});
	ctx.errorHistory.recordFix(relPath, fixContext);
}

/**
 * Deletion hygiene (Layer 3): when exports are removed, check whether the
 * co-located test files still reference them. Mutates `allCheckResults` and
 * `decision` in place.
 */
export function runDeletionHygiene(
	editedFilePath: string,
	session: SessionTrajectory,
	oldExports: ExportedSymbol[],
	newExports: ExportedSymbol[],
	CWD: string,
	decision: HarnessDecision,
	allCheckResults: CheckResultEntry[],
): void {
	const newExportNames = new Set(newExports.map((e) => e.name));
	const removedSymbols = oldExports
		.filter((e) => !newExportNames.has(e.name))
		.map((e) => e.name);

	if (removedSymbols.length === 0) return;

	// Resolve co-located test files (same pattern as checkTestFileExists)
	const extMatch = editedFilePath.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/);
	if (!extMatch) return;

	const base = editedFilePath.slice(0, -extMatch[0].length);
	const testCandidates = [
		`${base}.test${extMatch[0]}`,
		`${base}.spec${extMatch[0]}`,
		join(dirname(editedFilePath), "__tests__", `${basename(base)}.test${extMatch[0]}`),
		join(dirname(editedFilePath), "__tests__", `${basename(base)}.spec${extMatch[0]}`),
	];
	for (const testFile of testCandidates) {
		if (!existsSync(testFile)) continue;
		try {
			const testContent = readFileSync(testFile, "utf-8");
			const wasEdited = session.files_written.has(testFile);
			const orphanFindings = checkOrphanedTests(
				removedSymbols,
				relative(CWD, testFile),
				testContent,
				wasEdited,
			);
			for (const f of orphanFindings) {
				allCheckResults.push({
					source: "suggestion",
					name: f.check,
					severity: "warning",
					message: f.message,
					file: testFile,
					determinism: "heuristic",
				});
			}
			if (orphanFindings.length > 0) {
				decision.warnings = [
					...(decision.warnings || []),
					...orphanFindings.map((f) => `[deletion-hygiene:${f.check}] ${f.message}`),
				];
			}
		} catch (e) {
			void e;
		}
	}
}
