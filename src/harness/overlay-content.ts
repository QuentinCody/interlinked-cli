// ===========================================
// Overlay Content Resolution
// ===========================================
// Resolves the PROPOSED FULL FILE CONTENT for a write/edit tool call, so
// downstream content-quality checks (biome diff-overlay, tsc diff-overlay,
// pre_block registry) see the file as it WOULD be after the edit lands —
// not just the replacement snippet.
//
// Running checks on just `new_string` produces false-positive "undefined
// symbol" / "unused variable" errors for every out-of-hunk reference,
// because the snippet has no imports, no surrounding function context,
// and no type definitions. This module fixes that by computing the
// post-patch full content.

import { existsSync, readFileSync } from "node:fs";
import type { JsonObject } from "../lib/json-types.js";

interface MultiEditEntry {
	old_string?: string;
	new_string?: string;
	replace_all?: boolean;
}

/** Apply one old-to-new replacement the way the Edit tool does: LITERALLY.
 *  String.replace with a string replacement interprets dollar-patterns
 *  (dollar-ampersand, dollar-backquote, dollar-quote, dollar-digit) inside
 *  the replacement text, so a new_string containing one made every overlay
 *  gate validate content that DIFFERS from what the edit actually lands —
 *  measured 2026-07-24: a JSDoc with a backticked dollar sign spliced the
 *  entire pre-match file into the overlay temp, which then "failed to
 *  parse" and false-blocked the edit. A function replacer disables the
 *  interpretation; split/join gives replace_all the same literal semantics.
 *  Shared by every proposed-content builder (this module, the supply-chain
 *  manifest path, the tsgo edit simulation) so the semantics can't drift. */
export function applyLiteralReplacement(
	haystack: string,
	oldS: string,
	newS: string,
	replaceAll: boolean,
): string {
	if (replaceAll) return haystack.split(oldS).join(newS);
	return haystack.replace(oldS, () => newS);
}

/**
 * Compute the proposed full file content for a file-write tool call.
 *
 * Semantics by tool:
 *   Write       → `tool_input.content` is already the full file.
 *   Edit        → `tool_input.new_string` is just the replacement snippet;
 *                 splice it into the current disk content at `old_string`.
 *   MultiEdit   → apply `edits` array in sequence.
 *
 * When the splice can't succeed (file missing, old_string not found), we
 * fall back to the raw `new_string` — downstream checks may over-flag, but
 * that's strictly better than skipping checks entirely.
 */
/** Read the current disk content as the splice base. Missing file or a read
 *  error both fall through to an empty base — no base content means we'll
 *  only have the new_string, which is the best we can do for a new-file
 *  Edit. */
function readBaseContent(filePath: string): string {
	try {
		if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
	} catch (_err) {
		void 0; /* intentional: fall through to empty base */
	}
	return "";
}

/** Apply one MultiEdit array entry onto `current`, in place semantics via
 *  return value. Skips malformed entries and no-op entries whose old_string
 *  isn't present, exactly as the orchestrator's inline loop body did. */
function applyMultiEditEntry(current: string, e: unknown): string {
	if (!e || typeof e !== "object") return current;
	const entry = e as MultiEditEntry;
	const oldStr = entry.old_string ?? "";
	const newStr = entry.new_string ?? "";
	if (oldStr && current.includes(oldStr)) {
		return applyLiteralReplacement(current, oldStr, newStr, entry.replace_all === true);
	}
	return current;
}

/** MultiEdit: apply the `edits` array in sequence onto `base`. */
function applyMultiEditSequence(base: string, edits: unknown[]): string {
	let current = base;
	for (const e of edits) {
		current = applyMultiEditEntry(current, e);
	}
	return current;
}

/** Edit tool: splice `old_string` → `new_string` into `base`. Falls back to
 *  the raw new_string (or base, if there's no new_string either) when the
 *  splice can't succeed. */
function applySingleEdit(base: string, toolInput: JsonObject): string {
	const oldString = typeof toolInput.old_string === "string" ? toolInput.old_string : "";
	const newString = typeof toolInput.new_string === "string" ? toolInput.new_string : "";
	if (oldString && base.includes(oldString)) {
		return applyLiteralReplacement(base, oldString, newString, toolInput.replace_all === true);
	}
	return newString || base;
}

export function resolveProposedContent(filePath: string, toolInput: JsonObject): string {
	// Write tool: `content` is the full file.
	if (typeof toolInput.content === "string") return toolInput.content;

	const base = readBaseContent(filePath);

	// MultiEdit: apply the `edits` array in sequence.
	const edits = toolInput.edits;
	if (Array.isArray(edits)) {
		return applyMultiEditSequence(base, edits);
	}

	return applySingleEdit(base, toolInput);
}
