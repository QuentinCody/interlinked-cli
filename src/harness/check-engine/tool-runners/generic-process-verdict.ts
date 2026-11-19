import { isJsonObject } from "../../../lib/json-types.js";
import { parseSemgrepJson } from "../output-parsers-semgrep.js";
import { parseGitleaksJson } from "../output-parsers.js";
import type { RunProcessResult } from "../spawn-async.js";
import { PartialToolReportError } from "../tool-errors.js";
import type { CheckResult } from "../types.js";
import { requireFileProcessVerdict } from "./file-process-verdict.js";

function validGitleaksRow(row: unknown): boolean {
	return isJsonObject(row) && typeof row.File === "string" && row.File.length > 0
		&& typeof row.RuleID === "string" && row.RuleID.length > 0
		&& typeof row.StartLine === "number" && Number.isSafeInteger(row.StartLine) && row.StartLine >= 0
		&& (row.Description === undefined || typeof row.Description === "string");
}

export function parseCompleteGitleaksReport(output: string): CheckResult[] {
	let data: unknown;
	try { data = JSON.parse(output.trim()); }
	catch (error) { throw new PartialToolReportError("Gitleaks report is malformed; no complete security verdict", [], { cause: error }); }
	if (!Array.isArray(data)) throw new PartialToolReportError("Gitleaks report must be an array; no complete security verdict", []);
	const valid = data.filter(validGitleaksRow);
	const results = parseGitleaksJson(JSON.stringify(valid));
	if (valid.length !== data.length) throw new PartialToolReportError("Gitleaks report contains invalid rows; no complete security verdict", results);
	return results;
}

/** Validate the fields projected into diagnostics. Native optional metadata,
 * end positions and traces can vary independently of these required fields. */
function validSemgrepRow(row: unknown): boolean {
	if (!isJsonObject(row) || typeof row.check_id !== "string" || row.check_id.length === 0
		|| typeof row.path !== "string" || row.path.length === 0) return false;
	const start = row.start;
	return isJsonObject(start) && typeof start.line === "number" && Number.isSafeInteger(start.line) && start.line >= 1
		&& (start.col === undefined || (typeof start.col === "number" && Number.isSafeInteger(start.col) && start.col >= 1))
		&& isJsonObject(row.extra) && typeof row.extra.message === "string";
}

/** Preserve valid positives and every cause that makes the scan incomplete. */
export function parseCompleteSemgrepReport(output: string, projectRoot: string): CheckResult[] {
	let data: unknown;
	try { data = JSON.parse(output.trim()); }
	catch (error) { throw new PartialToolReportError("Semgrep report is malformed; no complete scan verdict", [], { cause: error }); }
	if (!isJsonObject(data) || !Array.isArray(data.results)) {
		throw new PartialToolReportError("Semgrep report lacks results; no complete scan verdict", []);
	}
	const valid = data.results.filter(validSemgrepRow);
	const results = parseSemgrepJson(JSON.stringify({ results: valid }), projectRoot);
	const incomplete: string[] = [];
	if (valid.length !== data.results.length) incomplete.push(`${data.results.length - valid.length} invalid result rows`);
	if (data.errors !== undefined && !Array.isArray(data.errors)) {
		incomplete.push("errors field is malformed");
	} else if (Array.isArray(data.errors) && data.errors.length > 0) {
		const errors = data.errors.map(error => isJsonObject(error) && typeof error.message === "string" ? error.message : JSON.stringify(error));
		incomplete.push(`reported incomplete scopes: ${errors.join("; ")}`);
	}
	if (incomplete.length) throw new PartialToolReportError(`Semgrep ${incomplete.join("; ")}; no complete scan verdict`, results);
	return results;
}

export function requireGenericProcessVerdict(tool: string, result: RunProcessResult, results: CheckResult[]): void {
	try { requireFileProcessVerdict(tool, result, results.length); }
	catch (error) {
		throw new PartialToolReportError(error instanceof Error ? error.message : String(error), results, { cause: error });
	}
}
