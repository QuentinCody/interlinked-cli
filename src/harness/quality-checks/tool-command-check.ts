// Unified command-backed external check execution for one edited file.

import { resolve } from "node:path";
import { configNameToToolId, getOrCreateEngine } from "../check-engine/index.js";
import type { QualityCheckConfig } from "../types.js";
import {
	type EngineFindingRow,
	formatEngineFindings,
	splitIntroducedFindings,
} from "./finding-delta.js";
import { findProjectRoot } from "./project-root.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./result-types.js";

interface CommandCheckContext {
	filePath: string;
	cwd: string;
	tscFilterFile: string | undefined;
	outToolMetrics: ToolBreakdownEntry[] | undefined;
    editedFiles?: readonly string[];
}

function typescriptDeltaResults(
	editedFile: string,
	name: string,
	severity: QualityCheckConfig["severity"],
	checkCwd: string,
	rows: EngineFindingRow[],
    editedFiles?: readonly string[],
): QualityCheckResult[] {
	const delta = splitIntroducedFindings(checkCwd, name, editedFiles ?? editedFile, rows);
	const out: QualityCheckResult[] = [];
	if (delta.introduced.length > 0) {
		const formatted = formatEngineFindings(editedFile, delta.introduced);
		out.push({
			name,
			severity,
			message: `${name} found newly observed issues in ${formatted.header}`,
			novelty: "newly-observed",
			findingCount: delta.introduced.length,
			file: editedFile,
			detail: formatted.detail,
            diagnosticKeys: delta.introduced.map(row => `${row.file}\0${row.message.trim().replace(/\s+/g, " ")}`),
		});
	}
	if (delta.preExisting.length > 0) {
		const formatted = formatEngineFindings(editedFile, delta.preExisting);
		out.push({
			name,
			severity: "warning",
			message: `${name}: ${delta.preExisting.length} pre-existing issue(s) in ${formatted.header}`,
			novelty: "pre-existing",
			findingCount: delta.preExisting.length,
			file: editedFile,
			detail: formatted.detail,
            diagnosticKeys: delta.preExisting.map(row => `${row.file}\0${row.message.trim().replace(/\s+/g, " ")}`),
		});
	}
	return out;
}

export function deferredExternalCheck(
	filePath: string,
	checkName: string,
	reason: string,
): QualityCheckResult[] {
	return [
		{
			name: "external_check_deferred",
			severity: "warning",
			message: `External check deferred for ${filePath} (${checkName})`,
			file: filePath,
			detail: `No check verdict was produced: ${reason}`,
		},
	];
}

/**
 * A project without the tool's config file (no `tsconfig.json`, no `biome.json`, …) is a project the check does NOT APPLY
 * to — not an operational deferral. A deferral means "retry when capacity returns"; a missing config never returns, and
 * treating it as a deferral left a pending compiler batch that no edit and no retry could complete (2026-09-25: a `.mjs`
 * fixture under its own `package.json` kept blocking Stop for the whole session). The finding stays visible as a warning.
 */
function skippedToolResult(filePath: string, checkName: string, reason: string): QualityCheckResult[] {
	return reason.startsWith("no config file found") ? notApplicableCheck(filePath, checkName, reason) : deferredExternalCheck(filePath, checkName, reason);
}
function notApplicableCheck(filePath: string, checkName: string, reason: string): QualityCheckResult[] {
	return [
		{
			name: "external_check_not_applicable",
			severity: "warning",
			message: `${checkName} does not apply to ${filePath}: ${reason}; add the config to the file's project to enable it`,
			file: filePath,
			detail: `NOT APPLICABLE (not a deferral): ${reason}`,
		},
	];
}
/** Delegate one command-backed check to the unified out-of-process engine. */
export async function runCommandCheck(
	ctx: CommandCheckContext,
	name: string,
	check: QualityCheckConfig,
): Promise<QualityCheckResult[] | null> {
	const toolId = configNameToToolId(name);
	if (!toolId || toolId === "dep-audit") return null;

	const checkCwd = findProjectRoot(ctx.filePath, ctx.cwd) || ctx.cwd;
	const engine = getOrCreateEngine(checkCwd);
	const filterToFile = ctx.tscFilterFile ? true : name !== "typescript";
	const targetFile =
		ctx.tscFilterFile && name === "typescript"
			? resolve(checkCwd, ctx.tscFilterFile)
			: ctx.filePath;

	let engineReport: Awaited<ReturnType<typeof engine.runChecksAsync>>;
	try {
		engineReport = await engine.runChecksAsync(
			{ projectRoot: checkCwd, mode: "file", targetFile, filterToFile },
			{ tools: [toolId], timeoutMs: check.timeout_ms },
		);
	} catch (error) {
		return deferredExternalCheck(
			ctx.filePath,
			name,
			error instanceof Error ? error.message : "external check failed",
		);
	}

	for (const metric of engineReport.metrics) {
		ctx.outToolMetrics?.push({
			tool: metric.tool,
			ms: metric.elapsedMs,
			finding_count: metric.findingCount,
		});
	}

	const unavailable = engineReport.skipped.find(
		(entry) =>
			entry.check === toolId &&
			(entry.category === "tool_missing" ||
				entry.category === "resource_busy" ||
				entry.category === "timeout" ||
				entry.category === "error"),
	);
	if (unavailable) return skippedToolResult(ctx.filePath, name, unavailable.reason);
	const unavailableFinding = engineReport.results.find(
		(result) => result.ruleId === "tsc-unavailable",
	);
	if (unavailableFinding) {
		return deferredExternalCheck(ctx.filePath, name, unavailableFinding.message);
	}

	const rows: EngineFindingRow[] = engineReport.results.map((result) => ({
		file: result.file,
		line: result.line,
		message: result.message,
	}));
	if (name === "typescript") {
		return typescriptDeltaResults(ctx.filePath, name, check.severity, checkCwd, rows, ctx.editedFiles);
	}
	if (rows.length === 0) return [];
	const formatted = formatEngineFindings(ctx.filePath, rows);
	return [
		{
			name,
			severity: check.severity,
			message: `${name} found issues in ${formatted.header}`,
			file: ctx.filePath,
			detail: formatted.detail,
		},
	];
}
