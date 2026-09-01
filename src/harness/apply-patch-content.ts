// ===========================================
// apply_patch content reconstruction (V4A, conservative)
// ===========================================
// Codex / Copilot `apply_patch` payloads carry one or more file sections in the
// V4A diff format. Path extraction already lives in `server-tool-helpers.ts`;
// this module reconstructs the POST-edit CONTENT of each section so PreToolUse
// checks (the cyclomatic gate, CRAP) can analyse what the patch will produce —
// not just which files it touches.
//
// CONSERVATIVE BY DESIGN: every reconstruction returns `null` the moment it
// cannot apply a section with certainty (unknown line prefix, context not found,
// ambiguous position). The cyclomatic gate is a no-override block, so a misparse
// must degrade to fail-open (allow), never to a false block.
//
// V4A shape:
//   *** Begin Patch
//   *** Add File: path           +lines...           (whole new file)
//   *** Update File: path        @@ optional header   then  / - / + lines
//   *** Move to: newpath         (retargets the most recent section)
//   *** Delete File: path        (no body)
//   *** End Patch

import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";

type ApplyPatchOp = "add" | "update"| "delete";

export interface ApplyPatchSection {
	/** Final destination path (after an `*** Move to:` retarget, if any). */
	path: string;
	op: ApplyPatchOp;
	/** Raw body lines between this header and the next directive. */
	body: string[];
	/** The ORIGINAL path when an `*** Move to:` retargeted this section — the source
	 *  file to read the before-content from AND to remove from the overlay (finding
	 *  2026-06: it was overwritten by the destination, so the move's hunks reconstructed
	 *  against the wrong contents and the source was left present in the overlay).
	 *  Absent when the section was not moved. */
	fromPath?: string;
}

const HEADER_RE = /^\*\*\* (Update|Add|Delete) File:\s+(.+)$/;
const MOVE_RE = /^\*\*\* Move to:\s+(.+)$/;

/** True when a payload looks like a V4A apply_patch (has at least one file
 *  section or the Begin Patch sentinel). Used to disambiguate apply_patch from
 *  a plain Write `content` payload, which carries no `*** ` directives. */
export function looksLikeApplyPatch(raw: string): boolean {
	return /^\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/m.test(raw);
}

/**
 * The raw apply_patch payload across the runner-specific keys (Codex `command`,
 * Copilot `patch`, plus `_raw_patch` / `content` fallbacks), or "" when none is
 * present. Single source of the key precedence shared by every PreToolUse content
 * reconstructor (the complexity gate and the coverage gate) so they can never
 * drift on which field carries the patch.
 */
export function extractApplyPatchRaw(toolInput: JsonObject): string {
	return (
		(typeof toolInput.command === "string" && toolInput.command) ||
		(typeof toolInput.patch === "string" && toolInput.patch) ||
		(typeof toolInput._raw_patch === "string" && toolInput._raw_patch) ||
		(typeof toolInput.content === "string" && toolInput.content) ||
		""
	);
}

/** Parse a raw apply_patch payload into per-file sections, in source order,
 *  resolving `*** Move to:` retargets. */
export function parseApplyPatchSections(raw: string): ApplyPatchSection[] {
	const sections: ApplyPatchSection[] = [];
	let current: ApplyPatchSection | null = null;
	for (const line of raw.split("\n")) {
		const header = HEADER_RE.exec(line);
		if (header) {
			current = {
				op: nonNull(header[1]).toLowerCase() as ApplyPatchOp,
				path: nonNull(header[2]).trim(),
				body: [],
			};
			sections.push(current);
			continue;
		}
		const move = MOVE_RE.exec(line);
		if (move && current) {
			const dest = nonNull(move[1]).trim();
			// Remember the source path (to read before-content from + remove from the
			// overlay) before retargeting to the destination. Only when it differs.
			if (dest !== current.path) current.fromPath = current.path;
			current.path = dest;
			continue;
		}
		// Any other `*** ` line is a directive (Begin/End Patch) — not body.
		if (line.startsWith("*** ")) continue;
		if (current) current.body.push(line);
	}
	return sections;
}

/**
 * Reconstruct the post-edit content of one section against its before-content
 * (ignored for "add"). Returns `null` when the section cannot be applied with
 * certainty — the caller must fail open in that case.
 */
export function reconstructAfterContent(
	section: ApplyPatchSection,
	before: string,
): string | null {
	if (section.op === "delete") return "";
	if (section.op === "add") return reconstructAdd(section.body);
	return applyUpdateHunks(before, section.body);
}

/** "Add File" body is all `+`-prefixed additions (blank lines tolerated). */
function reconstructAdd(body: string[]): string | null {
	const out: string[] = [];
	for (const line of body) {
		if (line.startsWith("+")) out.push(line.slice(1));
		else if (line.trim() === "") out.push("");
		else return null; // a non-addition line in an Add section → bail
	}
	return out.join("\n");
}

/** Apply "Update File" hunks to before-content via context matching. */
function applyUpdateHunks(before: string, body: string[]): string | null {
	const beforeLines = before.split("\n");
	const hunks = splitHunks(body);
	if (hunks.length === 0) return null; // nothing to apply confidently

	let cursor = 0; // consumed prefix of beforeLines
	const result: string[] = [];
	for (const hunk of hunks) {
		const blocks = hunkBlocks(hunk);
		if (!blocks) return null; // unknown prefix in the hunk → bail
		const { oldBlock, newBlock } = blocks;
		if (oldBlock.length === 0) return null; // pure insertion, no context → ambiguous position
		const at = indexOfBlock(beforeLines, oldBlock, cursor);
		if (at < 0) return null; // context not found at/after the cursor → bail
		for (let i = cursor; i < at; i++) result.push(nonNull(beforeLines[i]));
		for (const line of newBlock) result.push(line);
		cursor = at + oldBlock.length;
	}
	for (let i = cursor; i < beforeLines.length; i++) result.push(nonNull(beforeLines[i]));
	return result.join("\n");
}

/** Split a body into hunks on `@@` markers (lines before the first `@@` form an
 *  implicit hunk). */
function splitHunks(body: string[]): string[][] {
	const hunks: string[][] = [];
	let cur: string[] = [];
	for (const line of body) {
		if (line.startsWith("@@")) {
			if (cur.length > 0) hunks.push(cur);
			cur = [];
			continue;
		}
		cur.push(line);
	}
	if (cur.length > 0) hunks.push(cur);
	return hunks;
}

/** Build the old/new line blocks for one hunk, or null on an unknown prefix.
 *  ` ` = context (both), `-` = removed (old only), `+` = added (new only). */
function hunkBlocks(hunk: string[]): { oldBlock: string[]; newBlock: string[] } | null {
	const oldBlock: string[] = [];
	const newBlock: string[] = [];
	for (const line of hunk) {
		if (line.startsWith("-")) oldBlock.push(line.slice(1));
		else if (line.startsWith("+")) newBlock.push(line.slice(1));
		else if (line.startsWith(" ")) {
			oldBlock.push(line.slice(1));
			newBlock.push(line.slice(1));
		} else if (line === "") {
			// A bare blank line is context (the format's leading space on an
			// empty line is often dropped by editors / transports).
			oldBlock.push("");
			newBlock.push("");
		} else {
			return null; // unknown prefix → cannot apply confidently
		}
	}
	return { oldBlock, newBlock };
}

/** First index ≥ `from` where `block` matches consecutively, or -1. */
function indexOfBlock(haystack: string[], block: string[], from: number): number {
	for (let i = from; i + block.length <= haystack.length; i++) {
		let ok = true;
		for (let j = 0; j < block.length; j++) {
			if (haystack[i + j] !== block[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return i;
	}
	return -1;
}
