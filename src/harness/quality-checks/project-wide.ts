// ===========================================
// Project-Wide Checks — cross-file sweep
// ===========================================
// Runs tsc/biome in project mode to catch cross-file issues that
// per-file PostToolUse checks miss: type errors in callers after
// signature changes, biome cross-file lint rules, etc.

import { getOrCreateEngine } from "../check-engine/index.js";
import type { CheckResult, ToolId } from "../check-engine/types.js";
import type { ProjectWideCheckConfig } from "../types.js";

interface QualityCheckResult {
	name: string;
	severity: "error" | "warning";
	message: string;
	file?: string;
	detail?: string;
}

/**
 * Public API — consumed by quality-checks.runProjectWideChecks and server.ts.
 *
 * Tracks per-session state for debounced project-wide sweeps.
 */
/** Tracks which files a project-wide sweep has already reported findings for. */
export class ProjectWideSweepState {
	/** Number of file edits since last project-wide sweep. */
	editsSinceLastSweep = 0;
	/** Files already checked per-file in PostToolUse (dedup against project-wide). */
	readonly checkedFiles = new Set<string>();
	/** Dedup key set: "tool:file:line:msg" strings already reported this session. */
	readonly reportedFindings = new Set<string>();

	/** Record a file edit, returns true if a sweep should fire based on interval. */
	recordEdit(config: Pick<ProjectWideCheckConfig, "edit_interval">): boolean {
		this.editsSinceLastSweep++;
		return this.editsSinceLastSweep >= config.edit_interval;
	}

	/** Mark a file as already checked by per-file PostToolUse. */
	recordFileChecked(filePath: string): void {
		this.checkedFiles.add(filePath);
	}

	/** Reset counter after a sweep completes. */
	resetCounter(): void {
		this.editsSinceLastSweep = 0;
	}

	/** Build a dedup key for a finding. */
	static findingKey(tool: ToolId, r: CheckResult): string {
		return `${tool}:${r.file}:${r.line}:${r.message.slice(0, 80)}`;
	}
}

/** Public API — consumed by server.ts. Result from a project-wide sweep. */
export interface ProjectWideSweepResult {
	findings: QualityCheckResult[];
	toolsRun: ToolId[];
	/** Reasons requested tools produced no verdict. Non-empty means this sweep
	 * must retry and must never be logged as clean. */
	deferredReasons?: string[];
	elapsedMs: number;
}

/**
 * Public API — consumed by server.ts.
 *
 * Run project-wide checks (tsc, biome, etc.) in project mode.
 * Deduplicates against findings already reported by per-file checks.
 *
 * Synchronous variant retained for back-compat. New callers should prefer
 * `runProjectWideChecksAsync` so the 30s sweep does not block the daemon's
 * event loop and starve concurrent PostToolUse connections.
 */
export function runProjectWideChecks(
	config: ProjectWideCheckConfig,
	sweepState: ProjectWideSweepState,
	cwd: string,
): ProjectWideSweepResult {
	const start = Date.now();
	const engine = getOrCreateEngine(cwd);
	const report = engine.runChecks(
		{ projectRoot: cwd, mode: "project" },
		{ tools: config.tools, timeoutMs: config.timeout_ms },
	);
	return buildSweepResult(report, sweepState, config, start);
}

/**
 * Async variant. Uses `engine.runChecksAsync` so the project-wide sweep
 * yields the event loop while tsc/biome subprocesses run, letting other
 * socket connections be serviced concurrently. Behavior identical to
 * `runProjectWideChecks`.
 */
export async function runProjectWideChecksAsync(
	config: ProjectWideCheckConfig,
	sweepState: ProjectWideSweepState,
	cwd: string,
): Promise<ProjectWideSweepResult> {
	const start = Date.now();
	const engine = getOrCreateEngine(cwd);
	const report = await engine.runChecksAsync(
		{ projectRoot: cwd, mode: "project" },
		{ tools: config.tools, timeoutMs: config.timeout_ms },
	);
	return buildSweepResult(report, sweepState, config, start);
}

function buildSweepResult(
	report: import("../check-engine/types.js").CheckReport,
	sweepState: ProjectWideSweepState,
	config: ProjectWideCheckConfig,
	start: number,
): ProjectWideSweepResult {
	const deferredSkips = report.skipped.filter(
		(entry) =>
			entry.category === "resource_busy" ||
			entry.category === "tool_missing" ||
			entry.category === "timeout" ||
			entry.category === "error",
	);
	const unavailableResults = report.results.filter(
		(result) => result.ruleId === "tsc-unavailable",
	);
	const deferredToolIds = new Set<string>([
		...deferredSkips.map((entry) => entry.check),
		...unavailableResults.map((result) => result.tool),
	]);
	const deferredReasons = [
		...deferredSkips.map((entry) => `${entry.check}: ${entry.reason}`),
		...unavailableResults.map((result) => `${result.tool}: ${result.message}`),
	];
	const toolsRun: ToolId[] = [];
	const findings: QualityCheckResult[] = [];
	for (const tool of report.toolsRun) {
		if (!deferredToolIds.has(tool.id)) toolsRun.push(tool.id);
	}
	for (const r of report.results) {
		if (r.ruleId === "tsc-unavailable") continue;
		const key = ProjectWideSweepState.findingKey(r.tool, r);
		if (sweepState.reportedFindings.has(key)) continue;
		sweepState.reportedFindings.add(key);
		findings.push({
			name: `${r.tool}_project_wide`,
			severity: config.severity,
			message: `[cross-file] ${r.file}(${r.line}): ${r.message}`,
			file: r.file,
		});
		if (findings.length >= config.max_findings) break;
	}
	if (deferredReasons.length === 0) sweepState.resetCounter();
	return { findings, toolsRun, deferredReasons, elapsedMs: Date.now() - start };
}
