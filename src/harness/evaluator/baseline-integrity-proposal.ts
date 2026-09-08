// Proposed-content reconstruction for the baseline-integrity gate.
//
// Extracted from baseline-integrity-gate.ts (line-cap): given the on-disk
// baseline text and a Write/Edit/MultiEdit tool input, produce the text the
// edit WOULD leave on disk, or null when the edit cannot be reconstructed
// (the gate then fails open).

import { readOptionalToolString } from "./tool-input-values.js";
import { reconstructEditContent } from "./config-loosening-gate.js";
import { isJsonObject } from "../../lib/json-types.js";

function applyEditList(before: string, edits: unknown[]): string | null {
	let cur: string | null = before;
	for (const e of edits) {
		if (cur === null) break;
		if (isJsonObject(e) && typeof e.old_string === "string" && typeof e.new_string === "string") {
			cur = reconstructEditContent(cur, e.old_string, e.new_string);
		}
	}
	return cur;
}

/**
 * Public API — returns the post-edit file text, or null when the tool input
 * carries neither full content nor a reconstructable edit.
 */
export function reconstructProposedBaseline(before: string, toolInput: Record<string, unknown>): string | null {

	const content = readOptionalToolString(toolInput.content);
	if (typeof content === "string") return content;
	if (Array.isArray(toolInput.edits)) return applyEditList(before, toolInput.edits);
	const oldString = readOptionalToolString(toolInput.old_string);
	const newString = readOptionalToolString(toolInput.new_string);
	if (typeof oldString === "string" && typeof newString === "string") {
		return reconstructEditContent(before, oldString, newString);
	}
	return null;
}
