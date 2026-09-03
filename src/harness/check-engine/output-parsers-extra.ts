// interlinked-tdd: exempt
// ===========================================
// Check Engine — Output Parsers (secondary languages + osv-scanner)
// ===========================================
// Pure functions extracted from output-parsers.ts to keep the main file
// under the per-file line cap. Re-exported from output-parsers.ts so all
// existing import sites are unchanged.

import { relative } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import type { AuditResult, CheckResult } from "./types.js";

// -------------------------------------------
// osv-scanner (osv-scanner --format=json)
// -------------------------------------------
// JSON format (simplified):
//   { results: [{ source: {...}, packages: [{
//       package: { name, version, ecosystem },
//       vulnerabilities: [{ id, severity?: [{ type, score }] }],
//       groups: [{ ids: [...], max_severity?: "7.2" }]
//     }] }] }
//
// Severity resolution order:
//   1. groups[].max_severity (numeric CVSS base score) — present in osv-scanner v2
//   2. vulnerabilities[].severity[].score if it's a bare numeric string
//   3. fall back to "low" bucket when no numeric score is available

type OsvPackage = {
	vulnerabilities?: Array<{ id?: string; severity?: Array<{ score?: string }> }>;
	groups?: Array<{ ids?: string[]; max_severity?: string }>;
};

type OsvRoot = { results?: Array<{ packages?: OsvPackage[] }> };

/** Running tally across all osv packages: per-bucket counts + the first 5 ids seen. */
type OsvTally = {
	critical: number;
	high: number;
	moderate: number;
	low: number;
	topIds: string[];
};

/** vuln-id → best numeric CVSS score extractable from that vuln's `severity[]`. */
function buildVulnScoreMap(pkg: OsvPackage): Map<string, number> {
	const vulnScore = new Map<string, number>();
	for (const v of pkg.vulnerabilities ?? []) {
		if (!v.id) continue;
		const score = extractNumericScore(v.severity);
		if (score !== null) vulnScore.set(v.id, score);
	}
	return vulnScore;
}

/**
 * Resolve one group's CVSS score: prefer `max_severity` (osv-scanner v2, covers
 * aliases), else the max numeric score among its member vuln ids. `null` when none.
 */
function resolveGroupScore(
	group: { ids?: string[]; max_severity?: string },
	vulnScore: Map<string, number>,
): number | null {
	let score: number | null = null;
	if (group.max_severity) {
		const n = Number.parseFloat(group.max_severity);
		if (!Number.isNaN(n)) score = n;
	}
	if (score === null) {
		for (const id of group.ids ?? []) {
			const s = vulnScore.get(id);
			if (s !== undefined && (score === null || s > score)) score = s;
		}
	}
	return score;
}

/** Fold one package's groups into the running tally (mutates `tally`). */
function tallyPackage(pkg: OsvPackage, tally: OsvTally): void {
	const vulnScore = buildVulnScoreMap(pkg);
	for (const g of pkg.groups ?? []) {
		const ids = g.ids ?? [];
		const bucket = cvssToBucket(resolveGroupScore(g, vulnScore));
		if (bucket === "critical") tally.critical++;
		else if (bucket === "high") tally.high++;
		else if (bucket === "moderate") tally.moderate++;
		else tally.low++;
		if (tally.topIds.length < 5 && ids[0]) tally.topIds.push(ids[0]);
	}
}

/** Render the `detail` string from a tally's bucket counts + sampled ids. */
function formatOsvDetail(tally: OsvTally): string {
	const counts: string[] = [];
	if (tally.critical) counts.push(`${tally.critical} critical`);
	if (tally.high) counts.push(`${tally.high} high`);
	if (tally.moderate) counts.push(`${tally.moderate} moderate`);
	if (tally.low) counts.push(`${tally.low} low`);
	const joined = counts.join(", ");
	return tally.topIds.length > 0 ? `${joined} — ${tally.topIds.join(", ")}` : joined;
}

export function parseOsvScannerJson(output: string): AuditResult | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	const root = parsed as OsvRoot;
	if (!root || !Array.isArray(root.results)) return null;

	const tally: OsvTally = { critical: 0, high: 0, moderate: 0, low: 0, topIds: [] };
	for (const result of root.results) {
		for (const pkg of result.packages ?? []) {
			tallyPackage(pkg, tally);
		}
	}

	const { critical, high, moderate, low } = tally;
	const total = critical + high + moderate + low;
	if (total === 0) return null;

	return {
		tool: "osv-scanner",
		total,
		critical,
		high,
		moderate,
		low,
		detail: formatOsvDetail(tally),
	};
}

function extractNumericScore(severity?: Array<{ score?: string }>): number | null {
	if (!severity || severity.length === 0) return null;
	for (const s of severity) {
		if (!s.score) continue;
		// Bare numeric ("7.2"): use directly.
		const n = Number.parseFloat(s.score);
		if (!Number.isNaN(n) && !s.score.startsWith("CVSS")) return n;
		// CVSS vector ("CVSS:3.1/AV:N/..."): we don't compute base score inline —
		// osv-scanner v2 emits groups[].max_severity for that. Skip here.
	}
	return null;
}

// CVSS v3 severity bucketing (matches osv-scanner's severity.CalculateRating).
function cvssToBucket(score: number | null): "critical" | "high" | "moderate" | "low" {
	if (score === null) return "low";
	if (score >= 9.0) return "critical";
	if (score >= 7.0) return "high";
	if (score >= 4.0) return "moderate";
	return "low";
}

// -------------------------------------------
// mypy (mypy --no-error-summary --no-color-output)
// -------------------------------------------
// Format: "file.py:line: error: message  [error-code]"

export function parseMypyOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(
			/^(.+?):(\d+):\s*(error|warning|note):\s*(.+?)(?:\s+\[(.+)\])?\s*$/,
		);
		if (match) {
			const severity = match[3] === "error" ? "error" : "warning";
			if (match[3] === "note") continue; // skip notes
			results.push({
				tool: "mypy",
				severity,
				file: nonNull(match[1]),
				line: Number.parseInt(nonNull(match[2]), 10),
				message: nonNull(match[4]).trim(),
				ruleId: match[5],
			});
		}
	}
	return results;
}

// -------------------------------------------
// ruff (ruff check --output-format=json)
// -------------------------------------------
// JSON format: [{filename, row, column, code, message}]

export function parseRuffJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!Array.isArray(parsed)) return [];
		const results: CheckResult[] = [];
		for (const finding of parsed) {
			// Ruff's JSON carries a `fix` object (with an `applicability` of
			// "safe" | "unsafe" | "display") whenever the rule can auto-correct.
			// Surface that to the agent so it knows a `ruff check --fix` will
			// resolve the finding — detection-only (we never apply it), so this
			// is compatible with the no-autofix-in-pipeline contract.
			const fix = finding.fix;
			const fixHint =
				fix && typeof fix.applicability === "string"
					? ` [${fix.applicability} autofix: \`ruff check --fix\`]`
					: "";
			results.push({
				tool: "ruff",
				severity: "warning",
				file: finding.filename || "",
				line: finding.row || finding.location?.row || 0,
				column: finding.column || finding.location?.column,
				message: `${finding.code}: ${finding.message}${fixHint}`,
				ruleId: finding.code,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// ruff format --check
// -------------------------------------------
// stdout lists every file that would change, one per line, then a count:
//   Would reformat: path/to/file.py
//   1 file would be reformatted
// Each "Would reformat:" line becomes one finding; the trailing count summary
// is ignored. Mirrors parseRustfmtCheckOutput.

export function parseRuffFormatOutput(output: string, projectRoot: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const lineText of output.split("\n")) {
		const m = lineText.match(/^Would reformat:\s*(.+?)\s*$/);
		if (!m) continue;
		results.push({
			tool: "ruff-format",
			severity: "warning",
			file: relative(projectRoot, nonNull(m[1])),
			line: 1,
			message: "not ruff-formatted — run `ruff format`",
		});
	}
	return results;
}

// -------------------------------------------
// Cargo (cargo check/clippy --message-format=json)
// -------------------------------------------
// NDJSON: each line is a JSON object. Filter for reason === "compiler-message".

type CargoSpan = { fileName: string; lineStart: number; columnStart: number | undefined };

function parseCargoSpan(value: unknown): CargoSpan {
	if (!isJsonObject(value)) return { fileName: "", lineStart: 0, columnStart: undefined };
	return {
		fileName: typeof value.file_name === "string" ? value.file_name : "",
		lineStart: typeof value.line_start === "number" ? value.line_start : 0,
		columnStart: typeof value.column_start === "number" ? value.column_start : undefined,
	};
}

type CargoCompilerMessage = {
	level: string | undefined;
	message: string;
	code: string | undefined;
	span: CargoSpan | null;
};

function parseCargoCompilerMessage(value: unknown): CargoCompilerMessage | null {
	if (!isJsonObject(value)) return null;
	const codeField = isJsonObject(value.code) ? value.code : undefined;
	const spans = Array.isArray(value.spans) ? value.spans : [];
	return {
		level: typeof value.level === "string" ? value.level : undefined,
		message: typeof value.message === "string" ? value.message : "",
		code: codeField && typeof codeField.code === "string" ? codeField.code : undefined,
		span: spans.length > 0 ? parseCargoSpan(spans[0]) : null,
	};
}

// NDJSON: one JSON object per line, filtered for reason === "compiler-message".
// A non-JSON line (e.g. "Compiling foo v0.1.0") is expected and skipped, not an error.
function parseCargoLine(line: string): CargoCompilerMessage | null {
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isJsonObject(obj) || obj.reason !== "compiler-message") return null;
	return parseCargoCompilerMessage(obj.message);
}

export function parseCargoJson(
	output: string,
	toolId: "cargo-check" | "cargo-clippy",
): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const msg = parseCargoLine(line);
		if (!msg || !msg.span) continue;
		results.push({
			tool: toolId,
			severity: msg.level === "error" ? "error" : "warning",
			file: msg.span.fileName,
			line: msg.span.lineStart,
			column: msg.span.columnStart,
			message: msg.message,
			ruleId: msg.code,
		});
	}
	return results;
}

// -------------------------------------------
// Go build (go build ./...)
// -------------------------------------------
// Format: "file.go:line:col: message" (on stderr)

export function parseGoBuildOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^(.+?\.go):(\d+):(\d+):\s*(.+)$/);
		if (match) {
			results.push({
				tool: "go-build",
				severity: "error",
				file: nonNull(match[1]),
				line: Number.parseInt(nonNull(match[2]), 10),
				column: Number.parseInt(nonNull(match[3]), 10),
				message: nonNull(match[4]).trim(),
			});
		}
	}
	return results;
}

/** Parse `go test` output into per-failing-unit findings, falling back to a
 *  generic whole-run finding when no unit can be isolated — any non-zero exit
 *  still produces a [proven] verdict (never a silent clean). */
export function parseGoTestOutput(output: string, status: number): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const fail = line.match(/^--- FAIL:\s+(\S+)\s+\(([^)]*)\)/);
		if (fail) {
			results.push({
				tool: "go-test",
				severity: "error",
				file: "",
				line: 0,
				message: `FAIL: ${nonNull(fail[1])} (${nonNull(fail[2])})`,
			});
			continue;
		}
		const pkg = line.match(/^FAIL\s+(\S+)\s/);
		if (pkg) {
			results.push({
				tool: "go-test",
				severity: "error",
				file: nonNull(pkg[1]),
				line: 0,
				message: `package ${nonNull(pkg[1])} failed`,
			});
			continue;
		}
		if (/^panic:/.test(line)) {
			results.push({ tool: "go-test", severity: "error", file: "", line: 0, message: line.trim() });
		}
	}
	if (results.length === 0) {
		const tail = output
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.slice(-6)
			.join("\n");
		results.push({
			tool: "go-test",
			severity: "error",
			file: "",
			line: 0,
			message: `go test failed (exit ${status}): ${tail}`,
		});
	}
	return results;
}

// -------------------------------------------
// golangci-lint (golangci-lint run --out-format=json)
// -------------------------------------------
// JSON format: {Issues: [{FromLinter, Text, Pos: {Filename, Line, Column}}]}

type GolangciPos = { filename: string; line: number; column: number | undefined };

function parseGolangciPos(value: unknown): GolangciPos {
	if (!isJsonObject(value)) return { filename: "", line: 0, column: undefined };
	return {
		filename: typeof value.Filename === "string" ? value.Filename : "",
		line: typeof value.Line === "number" ? value.Line : 0,
		column: typeof value.Column === "number" ? value.Column : undefined,
	};
}

type GolangciIssue = { fromLinter: string | undefined; text: string | undefined; pos: GolangciPos };

function parseGolangciIssue(value: unknown): GolangciIssue | null {
	if (!isJsonObject(value)) return null;
	return {
		fromLinter: typeof value.FromLinter === "string" ? value.FromLinter : undefined,
		text: typeof value.Text === "string" ? value.Text : undefined,
		pos: parseGolangciPos(value.Pos),
	};
}

export function parseGolangciLintJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!isJsonObject(parsed)) return [];
		const issues = parsed.Issues;
		if (!Array.isArray(issues)) return [];
		const results: CheckResult[] = [];
		for (const entry of issues) {
			const issue = parseGolangciIssue(entry);
			if (!issue) continue;
			results.push({
				tool: "golangci-lint",
				severity: "warning",
				file: issue.pos.filename,
				line: issue.pos.line,
				column: issue.pos.column,
				message: `${issue.fromLinter}: ${issue.text}`,
				ruleId: issue.fromLinter,
			});
		}
		return results;
	} catch {
		return [];
	}
}

// knip (knip --reporter json) — moved here from output-parsers.ts (line-cap extraction).
type KnipNamedEntry = { name: string; line: number };
function parseKnipNamedEntry(value: unknown): KnipNamedEntry | null {
	if (!isJsonObject(value) || typeof value.name !== "string") return null;
	return { name: value.name, line: typeof value.line === "number" ? value.line : 0 };
}
function parseKnipUnlistedDepName(value: unknown): string | null {
	if (typeof value === "string") return value;
	return isJsonObject(value) && typeof value.name === "string" ? value.name : null;
}
type KnipIssue = { file: string; exports: KnipNamedEntry[]; types: KnipNamedEntry[]; unlisted: string[] };
function parseKnipIssue(value: unknown): KnipIssue | null {
	if (!isJsonObject(value)) return null;
	const exports = Array.isArray(value.exports) ? value.exports : [];
	const types = Array.isArray(value.types) ? value.types : [];
	const unlisted = Array.isArray(value.unlisted) ? value.unlisted : [];
	return {
		file: typeof value.file === "string" ? value.file : "",
		exports: exports.map(parseKnipNamedEntry).filter((e): e is KnipNamedEntry => e !== null),
		types: types.map(parseKnipNamedEntry).filter((e): e is KnipNamedEntry => e !== null),
		unlisted: unlisted.map(parseKnipUnlistedDepName).filter((e): e is string => e !== null),
	};
}
function pushKnipIssueFindings(issue: KnipIssue, results: CheckResult[]): void {
	for (const exp of issue.exports) results.push({ tool: "knip", severity: "warning", file: issue.file, line: exp.line, message: `unused export: ${exp.name}`, ruleId: "unused-export" });
	for (const t of issue.types) results.push({ tool: "knip", severity: "warning", file: issue.file, line: t.line, message: `unused type export: ${t.name}`, ruleId: "unused-type" });
	for (const dep of issue.unlisted) results.push({ tool: "knip", severity: "warning", file: issue.file, line: 0, message: `unlisted dependency: ${dep}`, ruleId: "unlisted-dep" });
}

export function parseKnipJson(output: string): CheckResult[] {
	try {
		const parsed = JSON.parse(output);
		if (!isJsonObject(parsed)) return [];
		const results: CheckResult[] = [];
		const files = Array.isArray(parsed.files) ? parsed.files : [];
		for (const file of files) {
			if (typeof file !== "string") continue;
			results.push({ tool: "knip", severity: "warning", file, line: 0, message: "unused file — not imported by any other module", ruleId: "unused-file" });
		}
		const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
		for (const entry of issues) {
			const issue = parseKnipIssue(entry);
			if (issue) pushKnipIssueFindings(issue, results);
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// GCC / Clang (gcc -fsyntax-only -Wall)
// -------------------------------------------
// Format: "file.c:line:col: error: message" or "file.c:line:col: warning: message [-Wflag]"

export function parseGccOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(
			/^(.+?\.[chm](?:pp|xx|c|m)?):(\d+):(\d+):\s*(error|warning|fatal error):\s*(.+)/,
		);
		if (match) {
			const severity = nonNull(match[4]).includes("error") ? "error" : "warning";
			const msg = nonNull(match[5]).trim();
			const ruleMatch = msg.match(/\[(-W[\w-]+)\]\s*$/);
			results.push({
				tool: "c-compile",
				severity,
				file: nonNull(match[1]),
				line: Number.parseInt(nonNull(match[2]), 10),
				column: Number.parseInt(nonNull(match[3]), 10),
				message: ruleMatch ? msg.replace(ruleMatch[0], "").trim() : msg,
				ruleId: ruleMatch?.[1],
			});
		}
	}
	return results;
}

// -------------------------------------------
// clang-tidy (clang-tidy --quiet)
// -------------------------------------------
// Format: "file.c:line:col: warning: message [check-name]"

export function parseClangTidyOutput(output: string): CheckResult[] {
	const results: CheckResult[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(
			/^(.+?):(\d+):(\d+):\s*(warning|error|note):\s*(.+?)\s*\[(.+?)\]\s*$/,
		);
		if (match) {
			if (match[4] === "note") continue;
			results.push({
				tool: "clang-tidy",
				severity: match[4] === "error" ? "error" : "warning",
				file: nonNull(match[1]),
				line: Number.parseInt(nonNull(match[2]), 10),
				column: Number.parseInt(nonNull(match[3]), 10),
				message: nonNull(match[5]).trim(),
				ruleId: match[6],
			});
		}
	}
	return results;
}
