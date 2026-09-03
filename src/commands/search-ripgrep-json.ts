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
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (_) {
			/* intentional: ripgrep emits only well-formed JSON; skip on unexpected line */
			continue;
		}
		if (!isJsonObject(parsed)) continue;

		if (parsed.type === "match") {
			const m = parseRipgrepMatch(parsed);
			if (!m) continue;
			matches.push({
				file: relative(dir, m.path),
				line: m.lineNumber,
				column: m.submatchStart,
				text: m.text.replace(/\n$/, ""),
				context_before: pendingContext.length > 0 ? pendingContext : undefined,
				context_after: [],
			});
			pendingContext = [];
		} else if (parsed.type === "context") {
			const ctx = parseRipgrepContext(parsed);
			if (!ctx) continue;
			fileContextLine(matches, pendingContext, ctx, dir, opts.context);
		} else if (parsed.type === "summary") {
			searchedFiles = parseRipgrepSearchedFiles(parsed);
		}
	}
	return { matches, searchedFiles };
}
