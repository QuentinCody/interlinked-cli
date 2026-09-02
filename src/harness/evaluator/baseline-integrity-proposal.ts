// Proposed-content reconstruction for the baseline-integrity gate.
//
// Extracted from baseline-integrity-gate.ts (line-cap): given the on-disk
// baseline text and a Write/Edit/MultiEdit tool input, produce the text the
// edit WOULD leave on disk, or null when the edit cannot be reconstructed
// (the gate then fails open).

import { reconstructEditContent } from "./config-loosening-gate.js";

type EditPair = { old_string?: string; new_string?: string };

function applyEditList(before: string, edits: unknown[]): string | null {
	let cur: string | null = before;
	// SAFETY: the element shape is unvalidated tool input; every member is re-checked
	// with `typeof` below, so a non-conforming entry is skipped rather than trusted.
	for (const e of edits as EditPair[]) {
		if (cur === null) break;
		if (typeof e.old_string === "string" && typeof e.new_string === "string") {
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
	// SAFETY: these three reads narrow unvalidated tool input; each value is
	// re-checked with `typeof … === "string"` before use, so a wrong runtime type
	// falls through to the null (fail-open) path instead of being trusted.
	const content = toolInput.content as string | undefined;
	if (typeof content === "string") return content;
	if (Array.isArray(toolInput.edits)) return applyEditList(before, toolInput.edits);
	const oldString = toolInput.old_string as string | undefined;
	const newString = toolInput.new_string as string | undefined;
	if (typeof oldString === "string" && typeof newString === "string") {
		return reconstructEditContent(before, oldString, newString);
	}
	return null;
}
