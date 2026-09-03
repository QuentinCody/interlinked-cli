// ===========================================
// Check Engine — Output Parsers
// ===========================================
// Pure functions: raw tool output string → CheckResult[].
// Extracted from verify.ts and evaluator.ts so both can reuse them.

import { relative } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import type { AuditResult, CheckResult } from "./types.js";

// -------------------------------------------
// TypeScript (tsc --noEmit --pretty false)
// -------------------------------------------
// Format: "path/file.ts(line,col): error TS1234: message"

export function parseTscOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		// File-level errors: "file(line,col): error TSxxxx: message"
		const fileMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)/);
		if (fileMatch) {
			const [, file, lineNo, col, code, msg] = fileMatch;
			if (file === undefined || lineNo === undefined || col === undefined || code === undefined) {
				continue;
			}
			results.push({
				tool: "tsc",
				severity: "error",
				file,
				line: Number.parseInt(lineNo, 10),
				column: Number.parseInt(col, 10),
				message: `${code}: ${msg ?? ""}`,
				ruleId: code,
			});
			continue;
		}
		// Project-level errors: "error TSxxxx: message" (no file reference)
		// e.g. "error TS2688: Cannot find type definition file for 'node'."
		const projectMatch = line.match(/^error\s+(TS\d+):\s*(.+)/);
		if (projectMatch) {
			const [, code, msg] = projectMatch;
			if (code === undefined) continue;
			results.push({
				tool: "tsc",
				severity: "error",
				file: "tsconfig.json",
				line: 0,
				message: `${code}: ${msg ?? ""}`,
				ruleId: code,
			});
		}
	}
	return results;
}

// -------------------------------------------
// Biome (biome check)
// -------------------------------------------
// Format: "path/file.ts:line:col <category> ━━━..." — implementation lives in
// output-parsers-biome.ts (line-cap extraction, round 6: the parse/syntax
// diagnostic family joined the pattern there).

export { parseBiomeOutput } from "./output-parsers-biome.js";

// -------------------------------------------
// ESLint (eslint --format unix)
// -------------------------------------------
// Format: "path/file.ts:line:col: message [rule]"

export function parseEslintOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^(.+?):(\d+):(\d+):\s+(.+)/);
		if (match) {
			const [, file, lineNo, col, rawMsg] = match;
			if (file === undefined || lineNo === undefined || col === undefined || rawMsg === undefined) {
				continue;
			}
			const msg = rawMsg.trim();
			const ruleMatch = msg.match(/\[(.+)\]$/);
			results.push({
				tool: "eslint",
				severity: "warning",
				file,
				line: Number.parseInt(lineNo, 10),
				column: Number.parseInt(col, 10),
				message: msg,
				ruleId: ruleMatch?.[1],
			});
		}
	}
	return results;
}

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

// -------------------------------------------
// Gitleaks (gitleaks detect --json)
// -------------------------------------------
// JSON format: [{ File, StartLine, RuleID, Description }]

export function parseGitleaksJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!Array.isArray(parsed)) return [];
		const results: CheckResult[] = [];
		for (const finding of parsed) {
			results.push({
				tool: "gitleaks",
				severity: "error",
				file: finding.File || "",
				line: finding.StartLine || 0,
				message: `${finding.RuleID || "secret"}: ${finding.Description || "secret detected"}`,
				ruleId: finding.RuleID,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// npm audit (npm audit --json)
// -------------------------------------------
// JSON format: { metadata: { vulnerabilities: { critical, high, moderate, low } } }

interface NpmAuditVulnerabilities {
	critical: number;
	high: number;
	moderate: number;
	low: number;
}

function parseNpmAuditVulnerabilities(value: unknown): NpmAuditVulnerabilities | null {
	if (!isJsonObject(value)) return null;
	const metadata = value.metadata;
	if (!isJsonObject(metadata)) return null;
	const v = metadata.vulnerabilities;
	if (!isJsonObject(v)) return null;
	return {
		critical: typeof v.critical === "number" ? v.critical : 0,
		high: typeof v.high === "number" ? v.high : 0,
		moderate: typeof v.moderate === "number" ? v.moderate : 0,
		low: typeof v.low === "number" ? v.low : 0,
	};
}

export function parseNpmAuditJson(output: string): AuditResult | null {
	try {
		const parsed = JSON.parse(output);
		const v = parseNpmAuditVulnerabilities(parsed);
		if (!v) return null;
		const total = v.critical + v.high + v.moderate + v.low;
		if (total === 0) return null;

		const counts: string[] = [];
		if (v.critical) counts.push(`${v.critical} critical`);
		if (v.high) counts.push(`${v.high} high`);
		if (v.moderate) counts.push(`${v.moderate} moderate`);
		if (v.low) counts.push(`${v.low} low`);

		return {
			tool: "npm audit",
			total,
			critical: v.critical,
			high: v.high,
			moderate: v.moderate,
			low: v.low,
			detail: counts.join(", "),
		};
	} catch {
		return null;
	}
}

// -------------------------------------------
// docs:check (node scripts/check-docs.mjs)
// -------------------------------------------
// Format (one block per drift, lines are NOT JSON):
//   [docs:fail] /abs/path/to/file: <marker> drift
//     expected: 106
//     actual:   105
//   ...
//   N doc-accuracy failure(s). Run 'npm run docs:build' to ...
//
// Each `[docs:fail]` line becomes one CheckResult. The following
// `expected:` / `actual:` lines are folded into the message so the
// drift is visible in summary output. The trailing summary line is
// ignored — it's a count, not a finding.

export function parseDocsCheckOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const header = nonNull(lines[i]).match(/^\[docs:fail\]\s+(.+?):\s*(.+)$/);
		if (!header) continue;
		const file = nonNull(header[1]);
		let message = nonNull(header[2]);
		// Fold expected/actual lines into the message when present.
		const exp = lines[i + 1]?.match(/^\s*expected:\s*(.+)$/);
		const act = lines[i + 2]?.match(/^\s*actual:\s*(.+)$/);
		if (exp && act) {
			message = `${message} (expected ${nonNull(exp[1]).trim()}, actual ${nonNull(act[1]).trim()})`;
		}
		results.push({
			tool: "docs-check",
			severity: "error",
			file,
			line: 0,
			message,
		});
	}
	return results;
}

// -------------------------------------------
// Secondary-language parsers + osv-scanner
// -------------------------------------------
// Implementations live in output-parsers-extra.ts (line-cap extraction).
// Re-exported here so all existing import sites stay unchanged.

export {
	parseCargoJson,
	parseClangTidyOutput,
	parseGccOutput,
	parseGoBuildOutput,
	parseGoTestOutput,
	parseGolangciLintJson,
	parseKnipJson,
	parseMypyOutput,
	parseOsvScannerJson,
	parseRuffFormatOutput,
	parseRuffJson,
} from "./output-parsers-extra.js";

// -------------------------------------------
// oxlint (oxlint --format=json)
// -------------------------------------------
// JSON format: { diagnostics: [{ message, code, severity, filename, labels: [{ span: { line, column } }] }] }

interface OxlintDiagnostic {
	message: string;
	code: string | undefined;
	severity: string | undefined;
	filename: string;
	line: number;
	column: number | undefined;
}

function parseOxlintDiagnostic(value: unknown): OxlintDiagnostic | null {
	if (!isJsonObject(value)) return null;
	const labels = Array.isArray(value.labels) ? value.labels : [];
	const firstLabel = labels[0];
	const label = isJsonObject(firstLabel) ? firstLabel : undefined;
	const span = label && isJsonObject(label.span) ? label.span : undefined;
	return {
		message: typeof value.message === "string" ? value.message : "",
		code: typeof value.code === "string" ? value.code : undefined,
		severity: typeof value.severity === "string" ? value.severity : undefined,
		filename: typeof value.filename === "string" ? value.filename : "",
		line: span && typeof span.line === "number" ? span.line : 0,
		column: span && typeof span.column === "number" ? span.column : undefined,
	};
}

function pushOxlintDiagnostic(entry: unknown, results: CheckResult[]): void {
	const d = parseOxlintDiagnostic(entry);
	if (!d) return;
	results.push({
		tool: "oxlint",
		severity: d.severity === "error" ? "error" : "warning",
		file: d.filename,
		line: d.line,
		column: d.column,
		message: d.message,
		ruleId: d.code,
	});
}

export function parseOxlintJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!isJsonObject(parsed)) return [];
		const diagnostics = parsed.diagnostics;
		if (!Array.isArray(diagnostics)) return [];
		const results: CheckResult[] = [];
		for (const entry of diagnostics) pushOxlintDiagnostic(entry, results);
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// knip (knip --reporter json)
// -------------------------------------------
// Implementation moved to output-parsers-extra.ts (line-cap extraction) and
// re-exported above alongside the other secondary parsers.

// -------------------------------------------
// ShellCheck (shellcheck --format=json1)
// -------------------------------------------
// JSON1 format: { comments: [{ file, line, column, level, code, message }] }

// Return type is inferred (not a named interface) to keep this file under
// its line cap — see output-parsers-extra.ts for the named-type convention.
function parseShellcheckComment(value: unknown) {
	if (!isJsonObject(value)) return null;
	const code =
		typeof value.code === "number" || typeof value.code === "string" ? value.code : undefined;
	return {
		level: typeof value.level === "string" ? value.level : undefined,
		file: typeof value.file === "string" ? value.file : "",
		line: typeof value.line === "number" ? value.line : 0,
		column: typeof value.column === "number" ? value.column : undefined,
		message: typeof value.message === "string" ? value.message : "",
		code,
	};
}

export function parseShellcheckJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!isJsonObject(parsed)) return [];
		const comments = parsed.comments;
		if (!Array.isArray(comments)) return [];
		const results: CheckResult[] = [];
		for (const entry of comments) {
			const c = parseShellcheckComment(entry);
			if (!c) continue;
			if (c.level === "style" || c.level === "info") continue;
			results.push({
				tool: "shellcheck",
				severity: c.level === "error" ? "error" : "warning",
				file: c.file,
				line: c.line,
				column: c.column,
				message: c.message,
				ruleId: c.code ? `SC${c.code}` : undefined,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// actionlint (actionlint <file>)
// -------------------------------------------
// Format: "file:line:col: message [rule-name]"

export function parseActionlintOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^(.+?):(\d+):(\d+):\s*(.+?)(?:\s+\[(.+?)\])?\s*$/);
		if (match) {
			results.push({
				tool: "actionlint",
				severity: "warning",
				file: nonNull(match[1]),
				line: Number.parseInt(nonNull(match[2]), 10),
				column: Number.parseInt(nonNull(match[3]), 10),
				message: nonNull(match[4]).trim(),
				ruleId: match[5],
			});
		}
	}
	return results;
}

// -------------------------------------------
// Hadolint (hadolint --format json)
// -------------------------------------------
// JSON format: [{ line, code, message, level, file }]

export function parseHadolintJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!Array.isArray(parsed)) return [];
		const results: CheckResult[] = [];
		for (const finding of parsed) {
			const level = finding.level as string;
			results.push({
				tool: "hadolint",
				severity: level === "error" ? "error" : "warning",
				file: finding.file || "",
				line: finding.line || 0,
				message: `${finding.code || ""}: ${finding.message || ""}`.trim(),
				ruleId: finding.code,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// Taplo (taplo check <file>)
// -------------------------------------------
// Stderr format: "error: ... at line:col" or "error[rule]: message\n  --> file:line:col"

export function parseTaploOutput(output: string, filePath?: string): CheckResult[] {
	const results: CheckResult[] = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// Format: "error[rule]: message" followed by "  --> file:line:col"
		const errorMatch = nonNull(line).match(/^error(?:\[(.+?)\])?:\s*(.+)/);
		if (errorMatch) {
			let file = filePath || "";
			let lineNum = 0;
			let col: number | undefined;
			// Check next line for location
			const nextLine = lines[i + 1] || "";
			const locMatch = nextLine.match(/^\s*-->\s*(.+?):(\d+):(\d+)/);
			if (locMatch) {
				file = nonNull(locMatch[1]);
				lineNum = Number.parseInt(nonNull(locMatch[2]), 10);
				col = Number.parseInt(nonNull(locMatch[3]), 10);
				i++; // skip the location line
			}
			results.push({
				tool: "taplo",
				severity: "error",
				file,
				line: lineNum,
				column: col,
				message: nonNull(errorMatch[2]).trim(),
				ruleId: errorMatch[1],
			});
		}
	}
	return results;
}

/**
 * Filter CheckResult[] to only results matching a specific file.
 * Used when a project-wide tool (tsc) runs but we only want one file's results.
 */
export function filterResultsToFile(results: CheckResult[], filePath: string): CheckResult[] {
	return results.filter((r) => r.file === filePath || r.file.endsWith(filePath));
}
