import { isAbsolute, relative } from "node:path";
import { isJsonObject } from "../../../lib/json-types.js";
import { PartialToolReportError } from "../tool-errors.js";
import type { CheckResult } from "../types.js";

function codeLocation(value: unknown, projectRoot: string): Pick<CheckResult, "file" | "line" | "column"> | null {
	const location = isJsonObject(value) ? value : null;
	const start = location && isJsonObject(location.start) ? location.start : null;
	if (!location || typeof location.path !== "string" || !start
		|| typeof start.line !== "number" || !Number.isSafeInteger(start.line) || start.line <= 0
		|| typeof start.column !== "number" || !Number.isSafeInteger(start.column) || start.column <= 0) return null;
	return { file: isAbsolute(location.path) ? relative(projectRoot, location.path) : location.path, line: start.line, column: start.column };
}

function codeDiagnostic(value: unknown, projectRoot: string): CheckResult | null {
	if (!isJsonObject(value)) return null;
	const location = codeLocation(value.location, projectRoot);
	if (!location || typeof value.category !== "string" || !/^(lint\/|assist\/|syntax|suppressions|format$|parse$)/.test(value.category)
		|| typeof value.message !== "string" || typeof value.severity !== "string"
		|| !["error", "warning", "information", "hint", "fatal"].includes(value.severity)) return null;
	return { tool: "biome", severity: value.severity === "error" || value.severity === "fatal" ? "error" : "warning",
		...location, message: value.message, ruleId: value.category };
}

function summaryCount(summary: Record<string, unknown>, name: string, results: CheckResult[]): number {
	const count = summary[name];
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
		throw new PartialToolReportError(`Biome ${name} coverage count is unavailable; no complete verdict`, results);
	}
	return count;
}

function unavailableScope(value: unknown): string {
	const location = isJsonObject(value) && isJsonObject(value.location) ? value.location : null;
	const path = typeof location?.path === "string" ? location.path : "<project>";
	return `Biome diagnostic scope ${path} was unavailable or unsupported`;
}

/** Native machine counters expose omitted diagnostics and incomplete file scopes. */
export function parseCompleteBiomeReport(output: string, projectRoot: string): CheckResult[] {
	let data: unknown;
	try { data = JSON.parse(output); }
	catch (error) { throw new PartialToolReportError("Biome JSON report is malformed; no complete verdict", [], { cause: error }); }
	if (!isJsonObject(data) || !Array.isArray(data.diagnostics)) {
		throw new PartialToolReportError("Biome JSON report lacks diagnostics; no complete verdict", []);
	}
	const results: CheckResult[] = [];
	const incomplete: string[] = [];
	for (const value of data.diagnostics) {
		const result = codeDiagnostic(value, projectRoot);
		if (result) results.push(result);
		else incomplete.push(unavailableScope(value));
	}
	if (!isJsonObject(data.summary)) throw new PartialToolReportError("Biome summary is unavailable; no complete verdict", results);
	const summary = data.summary;
	const count = (name: string) => summaryCount(summary, name, results);
	const omitted = count("diagnosticsNotPrinted"), skipped = count("skipped");
	const declared = count("errors") + count("warnings") + count("infos");
	if (omitted > 0) incomplete.push(`Biome omitted ${omitted} diagnostics`);
	if (skipped > 0) incomplete.push(`Biome skipped ${skipped} files`);
	if (declared !== data.diagnostics.length) incomplete.push("Biome diagnostic counts differ from the captured report");
	if (incomplete.length > 0) throw new PartialToolReportError(`${incomplete.join("; ")}; no complete verdict`, results);
	return results;
}
