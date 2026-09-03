// ===========================================
// Derive edited line numbers from a PostToolUse event
// ===========================================
// Used by post-tool-file-checks.ts to feed
// `checkPersistentWarningEscalation`'s diff-aware proximity gate
// (refinement 2026-05): only escalate persistent findings the agent's
// current edit could have addressed. Without line-range data the
// escalation amplifies stale FPs in regions the edit never touched.
//
// Pure: no I/O, no globals. Returns a Set<number> of 1-indexed line
// numbers in the POST-edit file content. Returns `undefined` when no
// edited lines can be derived (tool isn't an edit shape, or inputs are
// missing); callers fail-open in that case so the gate doesn't suppress
// real persistence nags when line data is unavailable.

import type { JsonObject } from "../../lib/json-types.js";

const TOOL_WRITE = "Write" as const;
const TOOL_EDIT = "Edit" as const;
const TOOL_MULTI_EDIT = "MultiEdit" as const;
const NEWLINE_CHARCODE = 0x0a; // '\n'

/**
 * Derive the set of 1-indexed line numbers in `postEditContent` that the
 * tool's invocation modified.
 *
 *   - `Write` → every line in the new file (whole-file rewrite)
 *   - `Edit` → the lines spanned by `tool_input.new_string` in the post-
 *     edit content (empty Set if not located)
 *   - `MultiEdit` → union of each edit's `new_string` line range, or
 *     `undefined` if no edit was decodable
 *   - other tool names → `undefined` (no line info derivable)
 */
export function deriveEditedLineNumbers(
	toolName: string | undefined,
	toolInput: JsonObject | undefined,
	postEditContent: string | undefined,
): Set<number> | undefined {
	if (!toolInput || typeof postEditContent !== "string" || !toolName) return undefined;

	if (toolName === TOOL_WRITE) {
		return allLineNumbers(postEditContent);
	}
	if (toolName === TOOL_EDIT) {
		const newString = readString(toolInput, "new_string");
		if (newString === undefined) return undefined;
		return linesContainingNeedle(postEditContent, newString);
	}
	if (toolName === TOOL_MULTI_EDIT) {
		return editedLinesForMultiEdit(toolInput, postEditContent);
	}
	return undefined;
}

/**
 * Union of each `MultiEdit` edit's `new_string` line range in
 * `postEditContent`, or `undefined` if `toolInput.edits` isn't a decodable
 * array or no edit was located.
 */
function editedLinesForMultiEdit(toolInput: JsonObject, postEditContent: string): Set<number> | undefined {
	const editsRaw = (toolInput as { edits?: unknown }).edits;
	if (!Array.isArray(editsRaw)) return undefined;
	const all = new Set<number>();
	for (const edit of editsRaw) {
		if (typeof edit !== "object" || edit === null) continue;
		const newString = readString(edit as JsonObject, "new_string");
		if (newString === undefined) continue;
		for (const line of linesContainingNeedle(postEditContent, newString)) {
			all.add(line);
		}
	}
	return all.size > 0 ? all : undefined;
}

function allLineNumbers(content: string): Set<number> {
	const total = content.split("\n").length;
	const out = new Set<number>();
	for (let i = 1; i <= total; i++) out.add(i);
	return out;
}

/**
 * 1-indexed line numbers in `content` that the substring `needle`
 * spans (inclusive of both ends). Empty Set when `needle` isn't
 * present.
 */
function linesContainingNeedle(content: string, needle: string): Set<number> {
	const out = new Set<number>();
	if (!needle) return out;
	const idx = content.indexOf(needle);
	if (idx < 0) return out;
	const before = content.slice(0, idx);
	const startLine = countNewlines(before) + 1;
	const newlinesInNeedle = countNewlines(needle);
	for (let l = startLine; l <= startLine + newlinesInNeedle; l++) out.add(l);
	return out;
}

function countNewlines(s: string): number {
	let count = 0;
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) === NEWLINE_CHARCODE) count++;
	}
	return count;
}

function readString(obj: JsonObject, key: string): string | undefined {
	const value = obj[key];
	return typeof value === "string" ? value : undefined;
}
