// ===========================================
// ESLint `--format json` parser
// ===========================================
// ESLint 10 removed the `unix` formatter from core (2026-09-01 finding: the
// old `--format unix` invocation exits 2 with "install eslint-formatter-unix"
// and the generic eslint row silently reported nothing). JSON is the only
// stable machine-readable formatter that needs no extra package, so both the
// generic `eslint` row and the typed inert-code row (`tseslint-types`) parse
// through here. Split from output-parsers.ts for the file line cap.

import type { CheckResult } from "./types.js";

/** One eslint JSON-formatter message — only the fields we read. */
interface EslintJsonMessage {
	ruleId?: string | null;
	severity?: number;
	message?: string;
	line?: number;
	column?: number;
}

function isEslintJsonMessage(v: unknown): v is EslintJsonMessage {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One per-file result entry: `{ filePath, messages }`. */
function fileEntry(v: unknown): { filePath: string; messages: unknown[] } | null {
	if (typeof v !== "object" || v === null) return null;
	const { filePath, messages } = v as { filePath?: unknown; messages?: unknown };
	if (typeof filePath !== "string" || !Array.isArray(messages)) return null;
	return { filePath, messages };
}

/** Converts one file entry's valid messages to `CheckResult`s. */
function collectEntryResults(entry: { filePath: string; messages: unknown[] }, tool: CheckResult["tool"]): CheckResult[] {
	const out: CheckResult[] = [];
	for (const m of entry.messages) {
		if (!isEslintJsonMessage(m) || typeof m.message !== "string") continue;
		out.push({
			tool,
			severity: m.severity === 2 ? "error" : "warning",
			file: entry.filePath,
			line: typeof m.line === "number" ? m.line : 0,
			column: typeof m.column === "number" ? m.column : 0,
			message: m.ruleId ? `${m.message} [${m.ruleId}]` : m.message,
			ruleId: m.ruleId ?? undefined,
		});
	}
	return out;
}

/** Walks the parsed eslint array, converting each valid message to a `CheckResult`. */
function processParsed(parsed: unknown[], tool: CheckResult["tool"]): CheckResult[] {
	const results: CheckResult[] = [];
	for (const raw of parsed) {
		const entry = fileEntry(raw);
		if (!entry) continue;
		results.push(...collectEntryResults(entry, tool));
	}
	return results;
}

/**
 * Parse eslint's built-in `--format json` output. `tool` lets the typed
 * inert-code row attribute its findings separately from the generic lint row.
 * Severity 2 (rule level "error") → "error"; anything else → "warning".
 * Tolerates a non-JSON preamble (npx banners) before the array; malformed
 * input yields [] — an unparseable run is reported by the runner's exit code,
 * never as fake findings.
 */
export function parseEslintJson(output: string, tool: CheckResult["tool"] = "eslint"): CheckResult[] {
	const start = output.indexOf("[");
	if (start < 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(start));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return processParsed(parsed, tool);
}
