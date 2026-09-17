// ===========================================
// Line-count + text projection for Write/Edit/MultiEdit tool inputs
// ===========================================
// Extracted from pre-checks.ts (which sits near the per-file line cap —
// fittingly, the cap it enforces). Projects a file's post-edit line count
// AND full post-edit text from a PreToolUse tool input, before anything is
// written to disk. Consumed by `checkLargeFileLineCountWrite`, whose
// comment-only-growth exemption needs the before/after TEXTS (not just
// counts) to compare effective code lines via `countCodeLines`.

import { existsSync, readFileSync } from "node:fs";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { countLines } from "./large-file-policy.js";

interface LineCountProjection {
	/** File line count before the edit (0 for a brand-new file). */
	before: number;
	/** Projected line count after the edit. */
	after: number;
	/** Content used for the cappable-file predicate: the new content for a
	 *  fresh Write, or the current file for an Edit/MultiEdit. */
	content: string;
	/** Full file text before the edit ("" for a brand-new file). */
	beforeText: string;
	/** Projected full text after the edit — best-effort sequential
	 *  application for MultiEdit. Null only when it cannot be derived (the
	 *  comment-only-growth exemption then simply does not apply). */
	afterText: string | null;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

/** First-occurrence replacement WITHOUT `String.replace` so `$&`/`$1` in the
 *  replacement stay literal — Edit tool semantics, not regex substitution.
 *  PRECONDITION: `oldStr` occurs in `text` — both callers check
 *  `countOccurrences(...) > 0` on the same text first, so `indexOf` cannot
 *  return -1 here. */
function replaceFirst(text: string, oldStr: string, newStr: string): string {
	const idx = text.indexOf(oldStr);
	return text.slice(0, idx) + newStr + text.slice(idx + oldStr.length);
}

/** Read the current file: 0 lines / empty text for a not-yet-existing file,
 *  null when the file exists but can't be read (caller then fails open). */
function readCurrentFile(filePath: string): { lines: number; text: string } | null {
	try {
		if (!existsSync(filePath)) return { lines: 0, text: "" };
		const text = readFileSync(filePath, "utf-8");
		return { lines: countLines(text), text };
	} catch {
		return null;
	}
}

/** Projection for the Write shape (full new content provided). */
function projectWrite(toolInput: JsonObject, filePath: string): LineCountProjection | null {
	if (typeof toolInput.content !== "string") return null;
	const current = readCurrentFile(filePath);
	if (!current) return null;
	return {
		before: current.lines,
		after: countLines(toolInput.content),
		content: toolInput.content,
		beforeText: current.text,
		afterText: toolInput.content,
	};
}

/** Projection for the Edit shape (a single old/new replacement). */
function projectEdit(toolInput: JsonObject, filePath: string): LineCountProjection | null {
	if (typeof toolInput.old_string !== "string" || typeof toolInput.new_string !== "string") {
		return null;
	}
	const current = readCurrentFile(filePath);
	if (!current || current.lines === 0) return null; // Edit needs an existing file
	const found = countOccurrences(current.text, toolInput.old_string);
	if (found === 0) return null; // old_string absent — the tool itself will error
	const occurrences = toolInput.replace_all === true ? found : 1;
	const lineDelta =
		(countLines(toolInput.new_string) - countLines(toolInput.old_string)) * occurrences;
	const afterText =
		toolInput.replace_all === true
			? current.text.split(toolInput.old_string).join(toolInput.new_string)
			: replaceFirst(current.text, toolInput.old_string, toolInput.new_string);
	return {
		before: current.lines,
		after: current.lines + lineDelta,
		content: current.text,
		beforeText: current.text,
		afterText,
	};
}

/** Apply one MultiEdit step to the running text; invalid steps are unmeasured. */
function applyMultiEditStep(
	raw: unknown,
	afterText: string,
): string | null {
	if (!isJsonObject(raw)) return null;
	const edit = raw;
	if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
		return null;
	}
	const found = countOccurrences(afterText, edit.old_string);
    if (found === 0) return null;
	const nextAfterText =
		edit.replace_all === true
			? afterText.split(edit.old_string).join(edit.new_string)
			: replaceFirst(afterText, edit.old_string, edit.new_string);
	return nextAfterText;
}

/** Count the actual sequentially projected MultiEdit result. */
function projectMultiEdit(toolInput: JsonObject, filePath: string): LineCountProjection | null {
	if (!Array.isArray(toolInput.edits)) return null;
	const current = readCurrentFile(filePath);
	if (!current || current.lines === 0) return null;
	let afterText = current.text;
	for (const raw of toolInput.edits) {
		const step = applyMultiEditStep(raw, afterText);
		if (step === null) return null;
		afterText = step;
	}
	return {
		before: current.lines,
		after: countLines(afterText),
		content: current.text,
		beforeText: current.text,
		afterText,
	};
}

/**
 * Project a file's line count and full text after a Write/Edit/MultiEdit.
 * Returns null for tool shapes that can't be projected precisely
 * (apply_patch, NotebookEdit) or when the current file can't be read —
 * callers fail open.
 */
export function projectLineCount(
	toolInput: JsonObject,
	filePath: string,
): LineCountProjection | null {
	return (
		projectWrite(toolInput, filePath) ??
		projectEdit(toolInput, filePath) ??
		projectMultiEdit(toolInput, filePath)
	);
}
