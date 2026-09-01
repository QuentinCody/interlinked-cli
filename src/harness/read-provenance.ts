// ===========================================
// Read-view provenance — LG-3/LG-4 (docs/design/edit-contract-hardening.md)
// ===========================================
//
// omp's SnapshotStore reduced to what a hook layer can know. On every
// PostToolUse Read (and successful write) we record the file's content state
// — full sha256 plus 32-bit per-line hashes — WITHOUT retaining the text
// (the daemon's RSS budget is why the trigram index died; a text cache is
// not coming back). At PreToolUse write time:
//
//   stale-read  (warn)    — live hash ≠ the hash this session last displayed
//                           ⇒ the file drifted (formatter / git / human /
//                           untracked agent); the warning names where the
//                           divergence begins and shows CURRENT content there.
//   blind-edit  (measure) — the edit's anchor lies outside every line range
//                           this session ever displayed for the file.
//
// Fail-open discipline: no recorded view (Bash cat/sed reads, prior-session
// carry-over, >2MB files) ⇒ no check — omp's `seenLines === undefined` rule.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { nonNull } from "../lib/non-null.js";
import { isPostToolUseEvent } from "./session-literals.js";
import { isReadOperation, isWriteOperation } from "./structural-checks/helpers.js";
import type { EditMechanics, FileView, HarnessEvent, SessionTrajectory } from "./types.js";

const NEWLINE_CODE = 10;

/** Views are skipped for files past this size — provenance fails open. */
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
/** Steps between a doom block and a successful write that count as a rescue. */
const RESCUE_STEP_WINDOW = 2;
/** Context lines shown on each side of the first drifted line. */
const STALE_CONTEXT_LINES = 2;

/** FNV-1a 32-bit — cheap per-line fingerprint for drift localization. */
export function fnv1a32(line: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < line.length; i++) {
		hash ^= line.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function sha256Hex(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function toLineHashes(content: string): Uint32Array {
	const lines = content.split("\n");
	const hashes = new Uint32Array(lines.length);
	for (let i = 0; i < lines.length; i++) hashes[i] = fnv1a32(nonNull(lines[i]));
	return hashes;
}

export function ensureEditMechanics(session: SessionTrajectory): EditMechanics {
	if (!session.edit_mechanics) {
		session.edit_mechanics = {
			doomed: 0,
			rescued: 0,
			stale_reads: 0,
			blind_edits: 0,
			stale_warned: new Set(),
		};
	}
	return session.edit_mechanics;
}

function resolveEventPath(event: HarnessEvent, filePath: string): string {
	const cwd = event.cwd ?? process.cwd();
	return isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
}

/** Read a viewable file's content, or null (missing / oversized / unreadable). */
function readViewable(absPath: string): string | null {
	try {
		if (!existsSync(absPath)) return null;
		if (statSync(absPath).size > MAX_VIEW_BYTES) return null;
		return readFileSync(absPath, "utf-8");
	} catch {
		return null;
	}
}

/** The Read tool's displayed range from offset/limit, or null = whole file. */
function readRange(toolInput: NonNullable<HarnessEvent["tool_input"]>, lineCount: number): [number, number] | null {
	const offset = typeof toolInput.offset === "number" ? Math.max(1, toolInput.offset) : null;
	const limit = typeof toolInput.limit === "number" ? toolInput.limit : null;
	if (offset === null && limit === null) return null;
	const start = offset ?? 1;
	const end = limit === null ? lineCount : Math.min(lineCount, start + limit - 1);
	return [start, end];
}

/** Merge a displayed range into a view (same content) or start a fresh view. */
function mergeView(existing: FileView | undefined, next: FileView): FileView {
	if (!existing || existing.hash !== next.hash) return next;
	if (existing.ranges === null || next.ranges === null) {
		return { ...existing, at_step: next.at_step, ranges: null };
	}
	return { ...existing, at_step: next.at_step, ranges: [...existing.ranges, ...next.ranges] };
}

/** Rescue attribution: a successful write to the doomed file soon after. */
function trackRescue(session: SessionTrajectory, _event: HarnessEvent, filePath: string): void {
	const mechanics = session.edit_mechanics;
	const doom = mechanics?.last_doom;
	if (!mechanics || !doom || doom.file !== filePath) return;
	if (session.tool_call_count - doom.step <= RESCUE_STEP_WINDOW + 1) {
		mechanics.rescued++;
		mechanics.last_doom = undefined;
	}
}

/**
 * Capture/refresh the session's view of a file. PostToolUse only, mirroring
 * `recordSequenceInputs`: a PreToolUse event is an INTENDED operation that may
 * be blocked and never display or land anything.
 */
export function recordFileView(session: SessionTrajectory, event: HarnessEvent): void {
	const filePath = event.tool_input?.file_path as string | undefined;
	const toolName = event.tool_name;
	if (!filePath || !toolName || !isPostToolUseEvent(event)) return;
	const isRead = isReadOperation(toolName);
	const succeeded = event.tool_outcome !== "error" && event.tool_outcome !== "interrupted";
	if (!isRead && !(isWriteOperation(toolName) && succeeded)) return;
	if (isRead && event.tool_outcome === "error") return;

	const absPath = resolveEventPath(event, filePath);
	const content = readViewable(absPath);
	if (content === null) return;

	if (!isRead) trackRescue(session, event, filePath);
	const lineHashes = toLineHashes(content);
	// A write refreshes the whole view: the client echoes the result, so the
	// session is grounded in the file's new state (ranges null = whole file).
	const displayed = isRead ? readRange(event.tool_input ?? {}, lineHashes.length) : null;
	const next: FileView = {
		hash: sha256Hex(content),
		line_hashes: lineHashes,
		at_step: session.tool_call_count,
		ranges: displayed === null ? null : [displayed],
	};
	if (!session.file_views) session.file_views = new Map();
	session.file_views.set(filePath, mergeView(session.file_views.get(filePath), next));
}

/** 1-based first line whose hash differs from the recorded view (length
 *  differences count as divergence at the shorter+1 boundary). */
function firstDriftLine(view: FileView, currentLines: string[]): number {
	const max = Math.min(view.line_hashes.length, currentLines.length);
	for (let i = 0; i < max; i++) {
		if (fnv1a32(nonNull(currentLines[i])) !== view.line_hashes[i]) return i + 1;
	}
	return max + 1;
}

function renderDriftContext(currentLines: string[], driftLine: number): string {
	const start = Math.max(1, driftLine - STALE_CONTEXT_LINES);
	const end = Math.min(currentLines.length, driftLine + STALE_CONTEXT_LINES);
	const body = currentLines.slice(start - 1, end).join("\n");
	const fence = body.includes("```") ? "~~~~" : "```";
	return `Current content, lines ${start}–${end}:\n${fence}\n${body}\n${fence}`;
}

/**
 * LG-3: warn when a write targets a file whose live content no longer hashes
 * to what this session last displayed. Repeat-gated per (path, liveHash) so a
 * formatter sweep warns once, not on every subsequent edit.
 */
export function staleReadWarning(
	session: SessionTrajectory,
	event: HarnessEvent,
	toolName: string,
	toolInput: NonNullable<HarnessEvent["tool_input"]>,
): string | null {
	const filePath = toolInput.file_path as string | undefined;
	if (!filePath || !isWriteOperation(toolName)) return null;
	const view = session.file_views?.get(filePath);
	if (!view) return null;
	const content = readViewable(resolveEventPath(event, filePath));
	if (content === null) return null;
	const liveHash = sha256Hex(content);
	if (liveHash === view.hash) return null;

	const mechanics = ensureEditMechanics(session);
	const gateKey = `${filePath}::${liveHash}`;
	if (mechanics.stale_warned.has(gateKey)) return null;
	mechanics.stale_warned.add(gateKey);
	mechanics.stale_reads++;

	const currentLines = content.split("\n");
	const driftLine = firstDriftLine(view, currentLines);
	return (
		`[interlinked:stale-read][heuristic] ${filePath} changed since this session last viewed it ` +
		`(step ${view.at_step}) — a formatter, another agent, or an out-of-band edit may have run. ` +
		`Divergence begins at line ${driftLine}. ${renderDriftContext(currentLines, driftLine)}`
	);
}

interface BlindEditSpan {
	file: string;
	startLine: number;
	endLine: number;
}

/** Whether [start,end] lies inside any displayed range. */
function insideDisplayedRanges(ranges: Array<[number, number]>, start: number, end: number): boolean {
	return ranges.some(([lo, hi]) => start >= lo && end <= hi);
}

/**
 * LG-4: an Edit/MultiEdit whose first resolvable anchor lies entirely outside
 * every line range this session displayed for the file. Null when provenance
 * is absent or partial in the anchor's favor — measure-first, so callers
 * record recurrence rows and only warn when configured.
 */
export function blindEditSpan(
	session: SessionTrajectory,
	event: HarnessEvent,
	toolName: string,
	toolInput: NonNullable<HarnessEvent["tool_input"]>,
): BlindEditSpan | null {
	if (toolName !== "Edit" && toolName !== "MultiEdit") return null;
	const filePath = toolInput.file_path as string | undefined;
	if (!filePath) return null;
	const view = session.file_views?.get(filePath);
	if (!view || view.ranges === null) return null;
	const content = readViewable(resolveEventPath(event, filePath));
	if (content === null) return null;

	for (const oldString of anchorStrings(toolInput)) {
		const at = content.indexOf(oldString);
		if (at === -1) continue; // doom guard's territory, not provenance's
		let startLine = 1;
		for (let i = 0; i < at; i++) if (content.charCodeAt(i) === NEWLINE_CODE) startLine++;
		const endLine = startLine + (oldString.split("\n").length - 1);
		if (!insideDisplayedRanges(view.ranges, startLine, endLine)) {
			return { file: filePath, startLine, endLine };
		}
	}
	return null;
}

/** The old_string anchors carried by an Edit or MultiEdit input. */
function anchorStrings(toolInput: NonNullable<HarnessEvent["tool_input"]>): string[] {
	if (typeof toolInput.old_string === "string") return [toolInput.old_string];
	if (!Array.isArray(toolInput.edits)) return [];
	const rawEdits: unknown[] = toolInput.edits;
	const anchors: string[] = [];
	for (const edit of rawEdits) {
		if (edit && typeof edit === "object") {
			const oldS = (edit as Record<string, unknown>).old_string;
			if (typeof oldS === "string") anchors.push(oldS);
		}
	}
	return anchors;
}
