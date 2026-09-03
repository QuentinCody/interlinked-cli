// ===========================================
// interlinked search — `rg --json` message parsing (boundary)
// ===========================================
// `rg --json` emits one JSON object per line; this command only reads the
// "match" / "context" / "summary" message kinds (others, e.g. "begin"/"end",
// are ignored). Each parser returns null on a shape it doesn't recognize so
// the caller can skip that line rather than reading `undefined`/wrong-typed
// fields through an unchecked cast.

import { relative } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { SearchMatch } from "./search-query.js";

interface RipgrepMatchData {
	path: string;
	lineNumber: number;
	text: string;
	submatchStart: number | undefined;
}

interface RipgrepContextData {
	path: string;
	lineNumber: number;
	text: string;
}

function parseRipgrepPathText(value: unknown): string | null {
	if (!isJsonObject(value)) return null;
	return typeof value.text === "string" ? value.text : null;
}

function parseRipgrepMatch(value: unknown): RipgrepMatchData | null {
	if (!isJsonObject(value)) return null;
	const data = value.data;
	if (!isJsonObject(data)) return null;
	const path = parseRipgrepPathText(data.path);
	if (path === null) return null;
	const lineNumber = data.line_number;
	if (typeof lineNumber !== "number") return null;
	const lines = data.lines;
	if (!isJsonObject(lines) || typeof lines.text !== "string") return null;
	const submatches = data.submatches;
	let submatchStart: number | undefined;
	if (Array.isArray(submatches)) {
		const first: unknown = submatches[0];
		if (isJsonObject(first) && typeof first.start === "number") {
			submatchStart = first.start;
		}
	}
	return { path, lineNumber, text: lines.text, submatchStart };
}

function parseRipgrepContext(value: unknown): RipgrepContextData | null {
	if (!isJsonObject(value)) return null;
	const data = value.data;
	if (!isJsonObject(data)) return null;
	const path = parseRipgrepPathText(data.path);
	if (path === null) return null;
	const lineNumber = data.line_number;
	if (typeof lineNumber !== "number") return null;
	const lines = data.lines;
	if (!isJsonObject(lines) || typeof lines.text !== "string") return null;
	return { path, lineNumber, text: lines.text };
}

/** `summary.data.stats.searches`, or 0 for a missing/malformed field —
 *  matches the original `?? 0` default for an absent stats block. */
function parseRipgrepSearchedFiles(value: unknown): number {
	if (!isJsonObject(value)) return 0;
	const data = value.data;
	if (!isJsonObject(data)) return 0;
	const stats = data.stats;
	if (!isJsonObject(stats)) return 0;
	return typeof stats.searches === "number" ? stats.searches : 0;
}

// SAFETY: @types/node types spawnSync's `stdout` as non-nullable `Buffer`,
// but it is actually `null` when the child fails to spawn (e.g. `rg`
// missing from PATH — `result.error` is set in that case). This helper's
// parameter type is the honest one; callers pass the raw spawnSync result.
export function ripgrepStdoutLines(result: { stdout: Buffer | null }): string[] {
	return result.stdout ? result.stdout.toString("utf-8").split("\n").filter(Boolean) : [];
}

/** Files a `context` line onto the previous match as trailing context, or
 *  queues it as leading context for the next match. */
function fileContextLine(
	matches: SearchMatch[],
	pendingContext: string[],
	ctx: RipgrepContextData,
	dir: string,
	contextWindow: number,
): void {
	const text = ctx.text.replace(/\n$/, "");
	const ctxFile = relative(dir, ctx.path);
	const last = matches[matches.length - 1];
	// Trailing context: same file, line immediately after match (within context window)
	if (
		last &&
		ctxFile === last.file &&
		ctx.lineNumber > last.line &&
		ctx.lineNumber <= last.line + contextWindow
	) {
		if (!last.context_after) last.context_after = [];
		last.context_after.push(text);
		return;
	}
	// Leading context for the next match (different file, or gap > context window)
	pendingContext.push(text);
}

/** Parses one raw `rg --json` line into a JSON object, or null for a line
 *  that fails to parse or isn't an object (ripgrep is expected to emit only
 *  well-formed JSON objects; this tolerates an unexpected line instead of
 *  throwing). */
function parseRipgrepLine(line: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (_) {
		return null;
	}
	return isJsonObject(parsed) ? parsed : null;
}

/** Builds a match record from a `match` line and appends it to `matches`.
 *  Returns the pendingContext array subsequent lines should accumulate into:
 *  a fresh empty array after a successful append (the old array is now
 *  owned by the appended record's `context_before`), or the same array
 *  unchanged if the line didn't parse as a match. */
function appendMatchLine(
	parsed: Record<string, unknown>,
	dir: string,
	matches: SearchMatch[],
	pendingContext: string[],
): string[] {
	const m = parseRipgrepMatch(parsed);
	if (!m) return pendingContext;
	matches.push({
		file: relative(dir, m.path),
		line: m.lineNumber,
		column: m.submatchStart,
		text: m.text.replace(/\n$/, ""),
		context_before: pendingContext.length > 0 ? pendingContext : undefined,
		context_after: [],
	});
	return [];
}

/** Files a `context` line onto `matches`/`pendingContext` (see
 *  `fileContextLine`), or does nothing if the line doesn't parse. */
function appendContextLine(
	parsed: Record<string, unknown>,
	dir: string,
	contextWindow: number,
	matches: SearchMatch[],
	pendingContext: string[],
): void {
	const ctx = parseRipgrepContext(parsed);
	if (!ctx) return;
	fileContextLine(matches, pendingContext, ctx, dir, contextWindow);
}

/** Parses ripgrep `--json` lines into matches + the searched-file count. */
export function processRipgrepLines(
	lines: string[],
	dir: string,
	opts: { context: number },
): { matches: SearchMatch[]; searchedFiles: number } {
	const matches: SearchMatch[] = [];
	let searchedFiles = 0;
	// Accumulate leading context lines that appear before the next match
	let pendingContext: string[] = [];

	for (const line of lines) {
		const parsed = parseRipgrepLine(line);
		if (!parsed) continue;

		if (parsed.type === "match") {
			pendingContext = appendMatchLine(parsed, dir, matches, pendingContext);
		} else if (parsed.type === "context") {
			appendContextLine(parsed, dir, opts.context, matches, pendingContext);
		} else if (parsed.type === "summary") {
			searchedFiles = parseRipgrepSearchedFiles(parsed);
		}
	}
	return { matches, searchedFiles };
}
