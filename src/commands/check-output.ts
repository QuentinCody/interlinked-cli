// interlinked-tdd: exempt
// ===========================================
// Check Command — output / summary formatting
// ===========================================
// Presentation helpers for `checkCommand`: JSON payload, single-check (`--only`)
// text output, and the full human-readable summary. Extracted so the
// orchestrator stays a thin dispatcher.

import type { CheckReport } from "../harness/check-engine/index.js";
import type { JsonObject } from "../lib/json-types.js";

export interface StructuralCheckResult {
	name: string;
	files: Set<string>;
	/** Extra keys written beside `count` and `files` in `--json` output (the Python scan's evidence). */
	details?: JsonObject;
}

// Builds + writes the combined JSON payload (structural counts + engine
// findings) to stdout.
export function emitJsonOutput(
	results: StructuralCheckResult[],
	engineReport: CheckReport | null,
): void {
	const jsonData: JsonObject = {};
	for (const r of results) {
		jsonData[r.name] = { count: r.files.size, files: [...r.files].sort(), ...(r.details ?? {}) };
	}
	if (engineReport) {
		for (const tool of engineReport.toolsRun) {
			const toolResults = engineReport.results.filter((r) => r.tool === tool.id);
			jsonData[tool.id] = {
				count: toolResults.length,
				findings: toolResults.map((r) => ({
					file: r.file,
					line: r.line,
					severity: r.severity,
					message: r.message,
					ruleId: r.ruleId,
				})),
			};
		}
	}
	process.stdout.write(`${JSON.stringify(jsonData, null, 2)}\n`);
}

// Writes the single-check (`--only`) text output for a structural check:
// flagged files to stdout, the count to stderr.
export function emitStructuralOnly(results: StructuralCheckResult[], onlyCheck: string): void {
	const result = results.find((r) => r.name === onlyCheck);
	if (result && result.files.size > 0) {
		for (const f of [...result.files].sort()) {
			process.stdout.write(`${f}\n`);
		}
		process.stderr.write(`\n${result.files.size} files\n`);
	} else {
		process.stderr.write("0 files\n");
	}
}

// Writes the single-check (`--only`) text output for an engine tool: findings
// (sorted by file) to stdout, the count to stderr.
export function emitEngineOnly(engineReport: CheckReport, onlyCheck: string): void {
	const toolResults = engineReport.results.filter((r) => r.tool === onlyCheck);
	if (toolResults.length > 0) {
		for (const r of toolResults.sort((a, b) => a.file.localeCompare(b.file))) {
			process.stdout.write(`${r.file}:${r.line}: ${r.message}\n`);
		}
		process.stderr.write(`\n${toolResults.length} findings\n`);
	} else {
		process.stderr.write("0 findings\n");
	}
}

const SEVERITY_CHECK_ERRORS = new Set(["broken-imports", "cycles", "dead-imports", "secrets"]);

// Builds the colored icon + count fragment for one structural-summary row.
function structuralRowMarks(size: number, isError: boolean): { icon: string; count: string } {
	if (size === 0) {
		return { icon: "\x1b[32m✓\x1b[0m", count: "\x1b[32m0\x1b[0m" };
	}
	const icon = isError ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m";
	const count = isError ? `\x1b[31m${size}\x1b[0m` : `\x1b[33m${size}\x1b[0m`;
	return { icon, count };
}

// Writes the structural-checks section of the full summary. Accumulates flagged
// files into `allFlagged`; returns whether any error-severity check fired.
function emitStructuralSummary(results: StructuralCheckResult[], allFlagged: Set<string>): boolean {
	if (results.length === 0) return false;
	let hasErrors = false;
	process.stderr.write("  Structural checks:\n\n");
	for (const r of results) {
		const isError = SEVERITY_CHECK_ERRORS.has(r.name);
		if (isError && r.files.size > 0) hasErrors = true;
		const { icon, count } = structuralRowMarks(r.files.size, isError);
		const severity = isError ? "error" : "info";
		process.stderr.write(`  ${icon} ${r.name} [${severity}]: ${count} files\n`);
		for (const f of r.files) allFlagged.add(f);
	}
	return hasErrors;
}

// Writes one engine-tool row of the full summary. Accumulates flagged files
// into `allFlagged`; returns whether this tool reported any error-severity
// finding.
function emitEngineToolRow(
	tool: CheckReport["toolsRun"][number],
	engineReport: CheckReport,
	allFlagged: Set<string>,
): boolean {
	const toolResults = engineReport.results.filter((r) => r.tool === tool.id);
	const errorCount = toolResults.filter((r) => r.severity === "error").length;
	const total = toolResults.length;
	const version = tool.version || "?";

	if (total === 0) {
		process.stderr.write(
			`  \x1b[32m✓\x1b[0m ${tool.id} [${version}]: \x1b[32m0\x1b[0m findings\n`,
		);
		return false;
	}
	const icon = errorCount > 0 ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m";
	const countStr = errorCount > 0 ? `\x1b[31m${total}\x1b[0m` : `\x1b[33m${total}\x1b[0m`;
	const warnCount = total - errorCount;
	process.stderr.write(
		`  ${icon} ${tool.id} [${version}]: ${countStr} findings (${errorCount} errors, ${warnCount} warnings)\n`,
	);
	for (const r of toolResults) allFlagged.add(r.file);
	return errorCount > 0;
}

// Writes the external-tool-checks section of the full summary. Accumulates
// flagged files into `allFlagged`; returns whether any tool reported errors.
function emitEngineSummary(engineReport: CheckReport, allFlagged: Set<string>): boolean {
	let hasErrors = false;
	process.stderr.write("\n  External tool checks:\n\n");
	for (const tool of engineReport.toolsRun) {
		if (emitEngineToolRow(tool, engineReport, allFlagged)) hasErrors = true;
	}
	for (const tool of engineReport.toolsSkipped.filter((t) => !t.available)) {
		process.stderr.write(`  \x1b[2m- ${tool.id}: ${tool.reason || "skipped"}\x1b[0m\n`);
	}
	process.stderr.write(
		`\x1b[2m  completed in ${(engineReport.elapsedMs / 1000).toFixed(1)}s\x1b[0m\n`,
	);
	return hasErrors;
}

// Writes the full (no-filter) summary: header, structural section, engine
// section, totals, and the process exit code on error.
export function emitFullSummary(
	results: StructuralCheckResult[],
	engineReport: CheckReport | null,
	fileCount: number,
): void {
	const allFlagged = new Set<string>();
	let hasErrors = false;
	process.stderr.write(`\n  Interlinked project check (${fileCount} files indexed)\n\n`);

	if (emitStructuralSummary(results, allFlagged)) hasErrors = true;
	if (engineReport && emitEngineSummary(engineReport, allFlagged)) hasErrors = true;

	process.stderr.write(`\n  total unique: ${allFlagged.size} / ${fileCount} files\n\n`);

	if (hasErrors) {
		process.exitCode = 1;
	}
}
