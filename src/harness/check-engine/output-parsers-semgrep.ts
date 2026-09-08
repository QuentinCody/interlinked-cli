// Pure Semgrep JSON decoding, shared through the public output-parsers barrel.
import { relative } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import type { CheckResult } from "./types.js";

// -------------------------------------------
// Semgrep (semgrep scan --json)
// -------------------------------------------
// JSON format: { results: [{ path, start: { line, col }, check_id, extra: { message } }] }

interface SemgrepFinding {
	checkId: string | undefined;
	path: string | undefined;
	line: number | undefined;
	col: number | undefined;
	message: string | undefined;
}

function parseSemgrepFinding(value: unknown): SemgrepFinding | null {
	if (!isJsonObject(value)) return null;
	const start = isJsonObject(value.start) ? value.start : undefined;
	const extra = isJsonObject(value.extra) ? value.extra : undefined;
	return {
		checkId: typeof value.check_id === "string" ? value.check_id : undefined,
		path: typeof value.path === "string" ? value.path : undefined,
		line: start && typeof start.line === "number" ? start.line : undefined,
		col: start && typeof start.col === "number" ? start.col : undefined,
		message: extra && typeof extra.message === "string" ? extra.message : undefined,
	};
}

function pushSemgrepFinding(entry: unknown, projectRoot: string, results: CheckResult[]): void {
	const finding = parseSemgrepFinding(entry);
	if (!finding) return;
	results.push({
		tool: "semgrep",
		severity: "warning",
		file: relative(projectRoot, finding.path || ""),
		line: finding.line || 0,
		column: finding.col,
		message: `${finding.checkId || "unknown"}: ${finding.message || ""}`.trim(),
		ruleId: finding.checkId,
	});
}

export function parseSemgrepJson(output: string, projectRoot: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!isJsonObject(parsed)) return [];
		const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
		const results: CheckResult[] = [];
		for (const entry of rawResults) pushSemgrepFinding(entry, projectRoot, results);
		return results;
	} catch {
		return [];
	}
}
