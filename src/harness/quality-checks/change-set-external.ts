// ===========================================
// ChangeSet external-check batch
// ===========================================
// A PostToolUse request may touch many files (notably Codex apply_patch).
// External tools are project processes, not per-file predicates: starting
// tsc/biome/gitleaks once for every path multiplies memory and can turn one
// request into a queue of identical compilers. This module admits one
// project-scoped engine batch for the whole ChangeSet, then attributes the
// resulting rows back to the files that request actually touched.

import { resolve } from "node:path";
import { getOrCreateEngine } from "../check-engine/index.js";
import type { CheckReport, CheckResult, ToolId } from "../check-engine/types.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import type { QualityCheckConfig } from "../types.js";
import { type EngineFindingRow, formatEngineFindings } from "./finding-delta.js";
import { findProjectRoot } from "./project-root.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./result-types.js";
import {
	candidateChecks,
	type DeferredCheck,
	type ExternalCandidate,
	type NamedExternalCandidate,
	normalizeProjectPath,
	uniquePaths,
} from "./change-set-external-candidates.js";
import { runNamedChecksAdmitted } from "./change-set-external-named.js";

export { MULTI_FILE_NAMED_EXTERNAL_CHECKS } from "./change-set-external-candidates.js";

const MAX_BATCH_TOOL_TIMEOUT_MS = 30_000;
/** Attribution work cap. Project tools still scan one project, but mapping an
 * unbounded generated ChangeSet back to files must not monopolize the daemon. */
const MAX_CHANGESET_EXTERNAL_FILES = 32;
/** Sequential project tools admitted in one request-owned heavy-process lease. */
const MAX_CHANGESET_EXTERNAL_TOOLS = 8;

export interface ChangeSetExternalBatch {
	/** Results attributed to one path. The underlying external batch is lazy,
	 * idempotent, and shared by every call. */
	resultsForFile(filePath: string): Promise<QualityCheckResult[]>;
}

interface ChangeSetExternalBatchOptions {
	readonly paths:readonly string[];
	/** Paths proven created by the request's observed ChangeSet. Only these may
	 * turn a cold-start TypeScript finding into an "introduced" error without a
	 * previous compiler report. */
	readonly newFilePaths?: readonly string[];
	readonly checks: Record<string, QualityCheckConfig>;
	readonly cwd: string;
	readonly outToolMetrics?: ToolBreakdownEntry[];
	readonly outChecksRan?: string[];
}

function unavailableReason(report: CheckReport, toolId: ToolId): string | null {
	const unavailable = report.skipped.find(
		(entry) =>
			entry.check === toolId &&
			(entry.category === "tool_missing" ||
				entry.category === "resource_busy" ||
				entry.category === "timeout" ||
				entry.category === "error"),
	);
	if (unavailable) return unavailable.reason;
	const unavailableFinding = report.results.find(
		(result) => result.tool === toolId && result.ruleId === "tsc-unavailable",
	);
	return unavailableFinding?.message ?? null;
}

function toolRows(report: CheckReport, toolId: ToolId): CheckResult[] {
	return report.results.filter(
		(result) => result.tool === toolId && result.ruleId !== "tsc-unavailable",
	);
}

function engineRows(projectRoot: string, rows: readonly CheckResult[]): EngineFindingRow[] {
	return rows.map((row) => ({
		file: normalizeProjectPath(projectRoot, row.file),
		line: row.line,
		message: row.message,
	}));
}

function pushResult(
	results: Map<string, QualityCheckResult[]>,
	filePath: string,
	result: QualityCheckResult,
): void {
	const rows = results.get(filePath) ?? [];
	rows.push(result);
	results.set(filePath, rows);
}

function rowsForTouchedFile(
	rows: readonly EngineFindingRow[],
	normalizedPath: string,
): EngineFindingRow[] {
	return rows.filter((row) => row.file === normalizedPath);
}

function attributeTypeScriptRows(
	resultMap: Map<string, QualityCheckResult[]>,
	projectRoot: string,
	paths: readonly string[],
	candidate: ExternalCandidate,
	rows: readonly CheckResult[],
	newFilePaths: readonly string[],
): void {
	const normalizedPaths = paths.map((path) => normalizeProjectPath(projectRoot, path));
	const normalizedNewFiles = new Set(
		newFilePaths.map((path) => normalizeProjectPath(projectRoot, path)),
	);
	const normalizedRows = engineRows(projectRoot, rows);
	for (let index = 0; index < paths.length; index += 1) {
		const filePath = paths[index];
		const normalizedPath = normalizedPaths[index];
		if (!filePath || !normalizedPath) continue;
		const attributed = rowsForTouchedFile(normalizedRows, normalizedPath);
		if (attributed.length === 0) continue;
		const formatted = formatEngineFindings(normalizedPath, attributed);
		if (normalizedNewFiles.has(normalizedPath)) {
			pushResult(resultMap, filePath, {
				name: candidate.name,
				severity: candidate.check.severity,
				message: `${candidate.name} found issues in newly-created ${formatted.header}`,
				file: filePath,
				detail: formatted.detail,
			});
		} else {
			// A previous daemon run is not this request's pre-edit diagnostic
			// baseline. Treating it as one can turn old project debt into a false
			// "introduced" block. PreToolUse's overlay owns exact introduction;
			// this on-disk batch is a backstop and warns for existing files.
			pushResult(resultMap, filePath, {
				name: candidate.name,
				severity: "warning",
				message: `${candidate.name} found issue(s) in ${formatted.header}, but no per-file pre-edit compiler baseline exists — not classified as introduced`,
				file: filePath,
				detail: formatted.detail,
			});
		}
	}
}

function attributeOrdinaryRows(
	resultMap: Map<string, QualityCheckResult[]>,
	projectRoot: string,
	paths: readonly string[],
	candidate: ExternalCandidate,
	rows: readonly CheckResult[],
): void {
	const normalizedRows = engineRows(projectRoot, rows);
	for (const filePath of paths) {
		const normalizedPath = normalizeProjectPath(projectRoot, filePath);
		const attributed = rowsForTouchedFile(normalizedRows, normalizedPath);
		if (attributed.length === 0) continue;
		const formatted = formatEngineFindings(normalizedPath, attributed);
		pushResult(resultMap, filePath, {
			name: candidate.name,
			severity: candidate.check.severity,
			message: `${candidate.name} found issues in ${formatted.header}`,
			file: filePath,
			detail: formatted.detail,
		});
	}
}

function aggregateDeferral(
	resultMap: Map<string, QualityCheckResult[]>,
	primaryPath: string,
	fileCount: number,
	deferred: readonly DeferredCheck[],
): void {
	if (deferred.length === 0) return;
	const labels = [...new Set(deferred.map((entry) => entry.name))];
	const reasons = [
		...new Set(deferred.map((entry) => `${entry.name}: ${entry.reason}`)),
	];
	pushResult(resultMap, primaryPath, {
		name: "external_check_deferred",
		severity: "warning",
		message: `External checks deferred for ${fileCount} changed files (${labels.join(", ")})`,
		file: primaryPath,
		detail: `No check verdict was produced: ${reasons.join("; ")}`,
	});
}

function applyEngineReport(
	options: ChangeSetExternalBatchOptions,
	resultMap: Map<string, QualityCheckResult[]>,
	projectRoot: string,
	projectPaths: readonly string[],
	candidates: readonly ExternalCandidate[],
	report: CheckReport,
	deferred: DeferredCheck[],
): void {
	for (const metric of report.metrics) {
		options.outToolMetrics?.push({
			tool: metric.tool,
			ms: metric.elapsedMs,
			finding_count: metric.findingCount,
		});
	}
	const toolsRun = new Set(report.toolsRun.map((tool) => tool.id));
	for (const candidate of candidates) {
		const unavailable = unavailableReason(report, candidate.toolId);
		if (unavailable) {
			deferred.push({ name: candidate.name, reason: unavailable });
			continue;
		}
		if (!toolsRun.has(candidate.toolId)) {
			deferred.push({
				name: candidate.name,
				reason: "the engine returned no completed-tool verdict",
			});
			continue;
		}
		options.outChecksRan?.push(candidate.name);
		const rows = toolRows(report, candidate.toolId);
		if (candidate.toolId === "tsc") {
			attributeTypeScriptRows(
				resultMap,
				projectRoot,
				projectPaths,
				candidate,
				rows,
				options.newFilePaths ?? [],
			);
		} else {
			attributeOrdinaryRows(resultMap, projectRoot, projectPaths, candidate, rows);
		}
	}
}

async function runEngineAdmitted(
	options: ChangeSetExternalBatchOptions,
	resultMap: Map<string, QualityCheckResult[]>,
	projectRoot: string,
	projectPaths: readonly string[],
	candidates: readonly ExternalCandidate[],
	deferred: DeferredCheck[],
): Promise<void> {
	if (candidates.length === 0) return;
	try {
		const timeoutMs = Math.min(
			MAX_BATCH_TOOL_TIMEOUT_MS,
			Math.max(...candidates.map((candidate) => candidate.check.timeout_ms)),
		);
		const report = await getOrCreateEngine(projectRoot).runChecksAsync(
			{ projectRoot, mode: "project" },
			{
				tools: candidates.map((candidate) => candidate.toolId),
				timeoutMs,
				admissionAlreadyHeld: true,
			},
		);
		applyEngineReport(
			options,
			resultMap,
			projectRoot,
			projectPaths,
			candidates,
			report,
			deferred,
		);
	} catch (error) {
		const reason = String(error);
		for (const candidate of candidates) deferred.push({ name: candidate.name, reason });
	}
}

async function runBatch(
	options: ChangeSetExternalBatchOptions,
	paths: readonly string[],
): Promise<Map<string, QualityCheckResult[]>> {
	const resultMap = new Map(paths.map((path) => [path, []]));
	const primaryPath = paths[0];
	if (!primaryPath) return resultMap;
	if (paths.length > MAX_CHANGESET_EXTERNAL_FILES) {
		aggregateDeferral(resultMap, primaryPath, paths.length, [
			{
				name: "external checks",
				reason: `ChangeSet has ${paths.length} files (cap ${MAX_CHANGESET_EXTERNAL_FILES})`,
			},
		]);
		return resultMap;
	}
	const projectRoot = findProjectRoot(primaryPath, options.cwd) || options.cwd;
	const canonicalRoot = resolve(projectRoot);
	const projectPaths = paths.filter((path) => {
		const pathRoot = findProjectRoot(path, options.cwd) || options.cwd;
		return resolve(pathRoot) === canonicalRoot;
	});
	const { candidates, deferred, affectedTests, dependencyAudit } = candidateChecks({
		...options,
		paths: projectPaths,
	});
	if (projectPaths.length !== paths.length) {
		deferred.push({
			name: "cross-project external checks",
			reason: "one ChangeSet spans multiple project roots; only one heavy-process lease may run",
		});
	}
	const namedCandidates = [affectedTests, dependencyAudit].filter(
		(candidate): candidate is NamedExternalCandidate => candidate !== undefined,
	);
	const workCount = candidates.length + namedCandidates.length;
	if (workCount > MAX_CHANGESET_EXTERNAL_TOOLS) {
		for (const candidate of [...candidates, ...namedCandidates]) {
			deferred.push({
				name: candidate.name,
				reason: `${workCount} project tools requested (cap ${MAX_CHANGESET_EXTERNAL_TOOLS})`,
			});
		}
		aggregateDeferral(resultMap, primaryPath, paths.length, deferred);
		return resultMap;
	}
	if (workCount === 0) {
		aggregateDeferral(resultMap, primaryPath, paths.length, deferred);
		return resultMap;
	}

	const release = tryAcquireProjectHeavyProcessLease(projectRoot);
	if (!release) {
		for (const candidate of [...candidates, ...namedCandidates]) {
			deferred.push({
				name: candidate.name,
				reason: "external-tool capacity is busy",
			});
		}
		aggregateDeferral(resultMap, primaryPath, paths.length, deferred);
		return resultMap;
	}
	try {
		await runEngineAdmitted(
			options,
			resultMap,
			projectRoot,
			projectPaths,
			candidates,
			deferred,
		);
		await runNamedChecksAdmitted(
			options,
			resultMap,
			projectRoot,
			projectPaths,
			affectedTests,
			dependencyAudit,
			deferred,
		);
	} finally {
		release();
	}
	aggregateDeferral(resultMap, primaryPath, paths.length, deferred);
	return resultMap;
}

/** Create one lazy request-owned external batch. The closure memoizes the
 * promise itself, so concurrent or sequential per-file consumers can never
 * start a second compiler/linter process for the same ChangeSet. */
export function createChangeSetExternalBatch(
	options: ChangeSetExternalBatchOptions,
): ChangeSetExternalBatch {
	const paths = uniquePaths(options.paths);
	let batch: Promise<Map<string, QualityCheckResult[]>> | undefined;
	return {
		async resultsForFile(filePath: string): Promise<QualityCheckResult[]> {
			batch ??= runBatch(options, paths);
			const results = await batch;
			return results.get(filePath) ?? [];
		},
	};
}
