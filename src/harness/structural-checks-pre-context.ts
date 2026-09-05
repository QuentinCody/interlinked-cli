// interlinked-tdd: exempt
// ===========================================
// Structural Checks — PreToolUse context block helpers
// ===========================================
// Single-responsibility extractions of the former inline blocks inside
// getPreToolUseContext. Each helper reads the shared PreToolContext and returns
// the warning lines for one concern — same gate, same wording, same order — so
// the public behavior of getPreToolUseContext stays byte-identical while its
// orchestrator (structural-checks.ts) remains a thin sequence of push(...) calls.

import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { findPropagationTargets, formatPropagationWarnings } from "./change-propagation.js";
import { resolveDependencyView } from "./dependency-view.js";
import { checkFollowUpViolation } from "./impact-analysis.js";
import type { ProjectGraph } from "./project-graph.js";
import { harnessNow } from "./replay/harness-clock.js";
import { isAdvisorySpecCompletion } from "./spec/drift-confidence.js";
import type { RouteMap } from "./route-map.js";
import type { SessionTracker } from "./session-state.js";
import { findTestFileForSource } from "./structural-checks/export-surface.js";
import { isReadOperation, isWriteOperation } from "./structural-checks/helpers.js";
import type {
	HarnessEvent,
	SessionTrajectory,
	StructuralChecksConfig,
} from "./types.js";

/**
 * Shared, pre-resolved inputs every PreToolUse context block reads. Built once
 * by getPreToolUseContext after its guard clauses pass, then threaded into each
 * single-responsibility block helper below. Keeping these resolved values in one
 * record lets each block stay a small pure function (cyclomatic well under cap)
 * while the orchestrator remains a thin sequence of `push(...block(...))` calls.
 */
export interface PreToolContext {
	event: HarnessEvent;
	config: StructuralChecksConfig;
	graph: ProjectGraph;
	sessions: SessionTracker;
	toolName: string;
	filePath: string;
	relPath: string;
	ext: string;
}

/**
 * Recently-failed-here: warn when touching a file with unresolved failures from
 * earlier this session. Byte-identical to the inline block it replaces.
 */
export function preCheckRecentlyFailed(
	ctx: PreToolContext,
	session: SessionTrajectory | undefined,
): string[] {
	const { config, relPath, filePath, toolName } = ctx;
	if (
		!config.recently_failed ||
		!session ||
		!(isWriteOperation(toolName) || isReadOperation(toolName))
	) {
		return [];
	}
	const failedEntry = session.failed_files.get(filePath);
	if (!failedEntry) return [];
	const ago = session.tool_call_count - failedEntry.tool_call_count;
	return [
		`[interlinked:recently-failed] ${relPath} had ${failedEntry.failure_count} check failure(s) (${failedEntry.checks.join(", ")}) ${ago} tool call(s) ago. They may still be unresolved.`,
	];
}

/**
 * Test-first nudge: before editing a (non-test) source file, surface whether a
 * test file exists and has been run this session.
 */
export function preCheckTestFirst(
	ctx: PreToolContext,
	session: SessionTrajectory | undefined,
): string[] {
	const { config, relPath, filePath, toolName, ext, graph } = ctx;
	if (!(config.test_first && isWriteOperation(toolName) && session)) return [];

	const isSourceExt = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext);
	const isTest = /\.(test|spec)\.[^.]+$/.test(filePath) || filePath.includes("__tests__");
	if (!(isSourceExt && !isTest)) return [];

	const testFile = findTestFileForSource(filePath);
	if (!testFile) {
		return [
			`[interlinked:test-first] No test file found for ${relPath}. Write tests before modifying the implementation.`,
		];
	}
	if (!session.test_runs.has(testFile)) {
		return [
			`[interlinked:test-first] Tests at ${graph.toRelative(testFile)} haven't been run this session. Run them first to establish a green baseline before editing.`,
		];
	}
	return [];
}

/**
 * Blast radius: warn when editing a high-connectivity file. Dependency facts
 * come through the DependencyView seam (Supermodel `.graph` shard when present,
 * internal import graph otherwise); the wording adds a provenance clause only on
 * the Supermodel path.
 */
export function preCheckBlastRadius(ctx: PreToolContext): string[] {
	const { config, relPath, filePath, toolName, event, graph } = ctx;
	if (!(config.blast_radius && isWriteOperation(toolName))) return [];

	const view = resolveDependencyView(filePath, event.cwd ?? process.cwd(), graph);
	const dependents = view.getDependents(filePath);
	if (dependents.length < config.blast_radius_threshold) return [];

	const role = view.classifyModule(filePath);
	const roleLabel = role === "hub" ? " (hub module)" : "";
	const depList = dependents
		.slice(0, 5)
		.map((d) => graph.toRelative(d))
		.join(", ");
	const more = dependents.length > 5 ? ` and ${dependents.length - 5} more` : "";
	const provenance =
		view.source === "supermodel"
			? " Changes to exports will have wide impact (per Supermodel `.graph` shard)."
			: " Changes to exports will have wide impact.";
	return [
		`[interlinked:blast-radius] ${relPath}${roleLabel} is imported by ${dependents.length} files (${depList}${more}).${provenance}`,
	];
}

/**
 * Stale read: warn when reading a file another agent modified within the
 * staleness window. One warning is enough, so the first match wins.
 */
export function preCheckStaleRead(ctx: PreToolContext): string[] {
	const { config, relPath, filePath, toolName, event, sessions } = ctx;
	if (!(config.stale_read_warning && isReadOperation(toolName))) return [];

	const agentName = event.agent_name || "";
	const stalenessMs = config.staleness_window_s * 1000;
	const now = harnessNow();

	for (const sess of sessions.getAll()) {
		if (sess.agent_name === agentName) continue;
		const writeTime = sess.file_write_times.get(filePath);
		if (writeTime && now - new Date(writeTime).getTime() < stalenessMs) {
			const ago = Math.round((now - new Date(writeTime).getTime()) / 1000);
			return [
				`[interlinked:stale-read] ${relPath} was modified by ${sess.agent_name} ${ago}s ago. Contents may differ from what you previously read.`,
			];
		}
	}
	return [];
}

/**
 * True when any session OTHER than `session` has a recorded write for `filePath`
 * — used by the redundant-reread check to decide whether the file changed since
 * the agent last read it.
 */
function fileWrittenByOtherSession(
	sessions: SessionTracker,
	session: SessionTrajectory,
	filePath: string,
): boolean {
	for (const sess of sessions.getAll()) {
		if (sess === session) continue;
		if (sess.file_write_times.has(filePath)) return true;
	}
	return false;
}

/**
 * Redundant re-read: warn when re-reading a file already read this session and
 * unmodified since (by this or any other session).
 */
export function preCheckRedundantReread(
	ctx: PreToolContext,
	session: SessionTrajectory | undefined,
): string[] {
	const { config, relPath, filePath, toolName, sessions } = ctx;
	if (!(config.redundant_reread && isReadOperation(toolName) && session)) return [];

	const lastReadAt = session.file_read_at.get(filePath);
	if (lastReadAt === undefined) return [];

	const toolCallsAgo = session.tool_call_count - lastReadAt;
	const modifiedSince =
		session.files_written.has(filePath) ||
		fileWrittenByOtherSession(sessions, session, filePath);
	if (!modifiedSince && toolCallsAgo > 0) {
		return [
			`[interlinked:redundant-reread] You read ${relPath} ${toolCallsAgo} tool call(s) ago and it hasn't changed. Consider using the content from your earlier read.`,
		];
	}
	return [];
}

/**
 * Route context: inject handler/route info when editing API files. Reads the
 * richer Endpoint shape and projects it to the same human-readable string the V0
 * getRouteContext returned.
 */
export function preCheckRouteContext(
	ctx: PreToolContext,
	routeMap: RouteMap | undefined,
): string[] {
	const { config, toolName, filePath } = ctx;
	if (
		!(
			config.route_context &&
			routeMap &&
			(isWriteOperation(toolName) || isReadOperation(toolName))
		)
	) {
		return [];
	}

	const endpoints = routeMap.extractEndpointsForFile(filePath);
	if (endpoints.length === 0) return [];

	const MCP_TOOL_METHOD = "TOOL";
	const ANY_METHOD = "ALL";
	const descriptions = endpoints.map((e) => {
		if (e.method === MCP_TOOL_METHOD) return `${MCP_TOOL_METHOD} ${e.path}`;
		if (e.method === ANY_METHOD) return e.path;
		return `${e.method} ${e.path}`;
	});
	const unique = [...new Set(descriptions)];
	const summary = `This file handles: ${unique.join(", ")}. Changes may affect API consumers.`;
	return [`[interlinked:route-context] ${summary}`];
}

/**
 * Sibling awareness: list existing files when creating a NEW file in a populated
 * directory.
 */
export function preCheckSiblingAwareness(ctx: PreToolContext): string[] {
	const { config, filePath, toolName, graph } = ctx;
	if (!(config.sibling_awareness && isWriteOperation(toolName) && !existsSync(filePath))) {
		return [];
	}

	const siblings = graph.getSiblingFiles(filePath);
	if (siblings.length === 0) return [];

	const dir = graph.toRelative(dirname(filePath));
	const names = siblings
		.slice(0, 8)
		.map((s) => basename(s))
		.join(", ");
	const more = siblings.length > 8 ? ` and ${siblings.length - 8} more` : "";
	return [
		`[interlinked:sibling-awareness] Directory ${dir}/ already contains: ${names}${more}. Consider whether this new file duplicates existing functionality.`,
	];
}

/**
 * Completion tracking: remind about pending follow-through once it has been
 * outstanding past the reminder threshold.
 */
export function preCheckCompletionTracking(
	ctx: PreToolContext,
	session: SessionTrajectory | undefined,
): string[] {
	const { config, graph } = ctx;
	if (!(config.completion_tracking && session)) return [];

	const warnings: string[] = [];
	for (const [sourceFile, completion] of session.pending_completions) {
		if (isAdvisorySpecCompletion(sourceFile)) continue;
		const remaining = completion.affected_files.filter((f) => !completion.resolved_files.has(f));
		if (remaining.length === 0) continue;
		const toolCallsSince = session.tool_call_count - completion.recorded_at_tool_call;
		if (toolCallsSince >= config.completion_reminder_threshold) {
			const fileList = remaining
				.slice(0, 4)
				.map((f) => graph.toRelative(f))
				.join(", ");
			const more = remaining.length > 4 ? ` and ${remaining.length - 4} more` : "";
			warnings.push(
				`[interlinked:completion-tracking] ${completion.description} (${toolCallsSince} tool calls ago). Still needs updating: ${fileList}${more}`,
			);
		}
	}
	return warnings;
}

/**
 * Follow-up violation: warn if editing an unrelated file while export follow-ups
 * remain outstanding.
 */
export function preCheckFollowUpViolation(
	ctx: PreToolContext,
	session: SessionTrajectory | undefined,
): string[] {
	const { config, filePath, toolName } = ctx;
	if (!(config.impact_analysis && isWriteOperation(toolName) && filePath && session)) return [];

	const violation = checkFollowUpViolation(filePath, session);
	if (!violation) return [];
	return [`[interlinked:follow-up-required] ${violation}`];
}

/**
 * Change propagation: when editing a file, remind about docs/schemas/tests/
 * configs that may need to move with it. Unconditional on writes (no config gate).
 */
export function preCheckChangePropagation(ctx: PreToolContext): string[] {
	const { filePath, toolName, event } = ctx;
	if (!(isWriteOperation(toolName) && filePath)) return [];

	const cwd = event.cwd || process.cwd();
	const propagationTargets = findPropagationTargets(filePath, cwd);
	return formatPropagationWarnings(propagationTargets, cwd);
}
