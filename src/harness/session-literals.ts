// ===========================================
// Sequence-detector input population
// ===========================================
// Populates `session.recent_line_edits`, `session.literal_occurrences` from
// successful Write / Edit / MultiEdit events so the §3.21 add-then-revert
// and §3.18 magic-literal-cross-file detectors have non-empty input.
// Best-effort: bounded ring buffer + per-edit literal cap so a runaway
// agent can't blow the trajectory's memory footprint. The detectors read
// these maps directly.
//
// Lifted out of session-state.ts to keep that file under the per-file line
// cap. The helpers SessionTracker.recordEvent drives (recordRecentLineEdit,
// recordLiteralOccurrences, isSequenceWriteOperation, isPostToolUseEvent) plus
// the pinned-rule-set extractNonTrivialLiterals are re-exported from
// session-state.ts so existing importers keep working unchanged.

import { createHash } from "node:crypto";
import { isJsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

/** Per-file ring buffer ceiling for `recent_line_edits`. The §3.21
 *  detector only needs enough history to detect non-consecutive re-appearance
 *  of a content hash; 20 entries comfortably covers a thrashing loop. */
const RECENT_LINE_EDITS_PER_FILE_CAP = 20;

/** Max distinct literals extracted from a single edit. Bounds the work the
 *  literal scanner does per-event so a one-shot blob-write can't pin the
 *  CPU or memory-balloon the session trajectory. */
const LITERAL_OCCURRENCES_PER_EDIT_CAP = 50;

/** Lower-edge of the boring-number range. -1, 0, 1, 2, ... 256 — the
 *  range every codebase uses for status flags / array sizes / bit shifts;
 *  excluding them keeps the cross-file detector targeting *meaningful*
 *  literals. Matches the spec literal range. */
const TRIVIAL_NUMBER_LO = -1;
const TRIVIAL_NUMBER_HI = 256;

/** HTTP status-code window. 100..599 are response codes spread across
 *  effectively every web codebase; treating them as magic constants
 *  would drown the detector. */
const HTTP_STATUS_LO = 100;
const HTTP_STATUS_HI = 599;

/** True for post-tool-use events across the supported runners (Claude Code
 *  "PostToolUse"/"PostToolUseFailure", Gemini CLI "AfterTool"). The §3.21
 *  add-then-revert population gate uses this to skip PreToolUse Edit events,
 *  which represent INTENDED edits that may be blocked and never land on disk.
 *  Mirrors `isPostToolUse` in server-tool-helpers.ts; kept local so
 *  session-state has no dependency on the server module. */
export function isPostToolUseEvent(event: HarnessEvent): boolean {
	return (
		event.hook_event === "PostToolUse" ||
		event.hook_event === "AfterTool" ||
		event.hook_event === "PostToolUseFailure"
	);
}

/** Tools whose successful invocation produces a content chunk we feed to
 *  the §3.21 / §3.18 sequence detectors. Superset of `isWriteOperation`
 *  because that one excludes MultiEdit (no `file_path`/`content` pair on
 *  the top-level input) but the sequence-input scanner *does* unpack the
 *  per-edit `new_string`. Read-only — every other tool short-circuits. */
export function isSequenceWriteOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Write",
		"Edit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"MultiEdit",
		"NotebookEdit",
	].includes(toolName);
}

/** Extract every content chunk this event introduced. Write → one chunk
 *  from `tool_input.content`; Edit → `tool_input.new_string`; MultiEdit →
 *  one chunk per `tool_input.edits[i].new_string`. Returns [] when none of
 *  the recognized fields is present, so the call site can iterate without
 *  guard logic. */
export function extractWriteChunks(event: HarnessEvent): string[] {
	const input = event.tool_input ?? {};
	const chunks: string[] = [];
	const content = input.content;
	if (typeof content === "string") chunks.push(content);
	const newString = input.new_string;
	if (typeof newString === "string") chunks.push(newString);
	const edits = input.edits;
	if (Array.isArray(edits)) {
		for (const e of edits) {
			if (isJsonObject(e)) {
				const ns = e.new_string;
				if (typeof ns === "string") chunks.push(ns);
			}
		}
	}
	return chunks;
}

/** Push one ring-buffer entry for the file. content_hash is sha256 over the
 *  raw chunk; `range.end` is the chunk's line-count (the spec's
 *  simplification: Write/Edit don't expose precise line ranges, so we treat
 *  each edit as touching its full new content). Drops the oldest entry on
 *  overflow so the buffer stays bounded.
 *
 *  No-op suppression: if the new chunk hashes identically to the file's
 *  immediately-preceding recorded chunk, the edit re-applied content the file
 *  already held — not a state transition. Skipping it keeps the §3.21
 *  add-then-revert detector's history a sequence of *distinct* states, so the
 *  detector counts only genuine A→B→A oscillation rather than consecutive
 *  re-applies of the same content (idempotent writes, no-op edits). An
 *  A→B→A pattern is unaffected: the trailing A differs from the preceding B. */
export function recordRecentLineEdit(
	session: SessionTrajectory,
	filePath: string,
	chunk: string,
): void {
	if (!session.recent_line_edits) session.recent_line_edits = new Map();
	const lines = chunk.split("\n").length;
	const contentHash = createHash("sha256").update(chunk).digest("hex");
	const existing = session.recent_line_edits.get(filePath);
	if (existing) {
		// Drop a re-apply of the exact same content as the last recorded edit.
		const last = existing[existing.length - 1];
		if (last && last.content_hash === contentHash) return;
		existing.push({ range: { start: 0, end: lines }, content_hash: contentHash, at_step: session.tool_call_count });
		while (existing.length > RECENT_LINE_EDITS_PER_FILE_CAP) {
			existing.shift();
		}
	} else {
		session.recent_line_edits.set(filePath, [
			{ range: { start: 0, end: lines }, content_hash: contentHash, at_step: session.tool_call_count },
		]);
	}
}

/** Scan the chunk for non-trivial literals and add this file's path to
 *  each literal's occurrence set. Per-event count is capped to keep a
 *  large generated blob from creating thousands of map entries. */
export function recordLiteralOccurrences(
	session: SessionTrajectory,
	filePath: string,
	chunk: string,
): void {
	if (!session.literal_occurrences) session.literal_occurrences = new Map();
	let count = 0;
	for (const literal of extractNonTrivialLiterals(chunk)) {
		if (count >= LITERAL_OCCURRENCES_PER_EDIT_CAP) break;
		const hash = createHash("sha256").update(literal).digest("hex");
		const existing = session.literal_occurrences.get(hash);
		if (existing) {
			existing.add(filePath);
		} else {
			session.literal_occurrences.set(hash, new Set([filePath]));
		}
		count++;
	}
}

/** Yield every literal worth tracking. String literals ≥8 chars (skips
 *  short tokens like punctuation strings) and integer literals outside
 *  the boring -1..256 range AND outside the HTTP status 100..599 window.
 *  Pure, dependency-free — exported only for the dedicated unit tests
 *  that pin the rule set. */
export function extractNonTrivialLiterals(chunk: string): string[] {
	const out: string[] = [];
	// String literals: capture the delimiter, then anything that isn't a
	// matching delimiter or newline. 8..200 char body bounds.
	const stringRe = /(["'`])((?:(?!\1)[^\n]){8,200})\1/g;
	let m: RegExpExecArray | null;
	m = stringRe.exec(chunk);
	while (m !== null) {
		// The matched quoted-string pattern always captures its body in group 2.
		out.push(nonNull(m[2]));
		m = stringRe.exec(chunk);
	}
	// Integer literals (3+ digits) outside the boring and HTTP-status ranges.
	const numberRe = /\b(\d{3,})\b/g;
	let n: RegExpExecArray | null;
	n = numberRe.exec(chunk);
	while (n !== null) {
		const raw = nonNull(n[1]);
		const value = Number.parseInt(raw, 10);
		const trivial = value >= TRIVIAL_NUMBER_LO && value <= TRIVIAL_NUMBER_HI;
		const httpStatus = value >= HTTP_STATUS_LO && value <= HTTP_STATUS_HI;
		if (!trivial && !httpStatus) out.push(raw);
		n = numberRe.exec(chunk);
	}
	return out;
}
