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
}

function typescriptDeltaResults(
	editedFile: string,
	name: string,
	severity: QualityCheckConfig["severity"],
	checkCwd: string,
	rows: EngineFindingRow[],
): QualityCheckResult[] {
	const delta = splitIntroducedFindings(checkCwd, name, editedFile, rows);
	const out: QualityCheckResult[] = [];
	if (delta.introduced.length > 0) {
		const formatted = formatEngineFindings(editedFile, delta.introduced);
		out.push({
			name,
			severity,
			message: `${name} found new issues in ${formatted.header}`,
			file: editedFile,
			detail: formatted.detail,
		});
	}
	if (delta.preExisting.length > 0) {
		const formatted = formatEngineFindings(editedFile, delta.preExisting);
		out.push({
			name,
			severity: "warning",
			message: `${name}: ${delta.preExisting.length} pre-existing issue(s) in ${formatted.header} — not introduced by this edit`,
			file: editedFile,
			detail: formatted.detail,
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
	if (unavailable) return deferredExternalCheck(ctx.filePath, name, unavailable.reason);
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
		return typescriptDeltaResults(ctx.filePath, name, check.severity, checkCwd, rows);
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
