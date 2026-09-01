// ===========================================
// Live timeline capture — daemon-side transcript drain
// ===========================================
// On every daemon event the agent's transcript is drained from the last cursor
// to EOF, parsed into categorized records (transcript-record.ts), and appended
// to .interlinked/timeline.jsonl (timeline-writer.ts). Call this on tool events
// AND on Stop/SessionEnd: the Stop call is what captures a turn's FINAL message
// (an assistant turn that ends in text with no following tool call never fires
// a PreToolUse, so without the Stop drain it would only land at the next turn).
//
// Idempotent against the backfill: a daemon-lifetime per-cwd set of the keys
// already in timeline.jsonl is seeded once from disk, so a fresh cursor
// re-reading a session the backfill already captured does not duplicate it.
//
// Best-effort and fail-open (feedback_safety_continuity): a capture hiccup must
// never break the guard pipeline. The byte-cursor can rarely miss a line caught
// mid-write; the backfill (timeline-backfill.ts) is the completeness backstop.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { resolveTranscriptPath } from "./thinking-capture.js";
import { appendTimelineRecords, recentTimelineKeys, recordKey } from "./timeline-writer.js";
import { parseTranscriptText, type TimelineRecord } from "./transcript-record.js";
import type { HarnessEvent } from "./types.js";

interface Cursor {
	path: string;
	offset: number;
	offsets: Record<string, number>;
}

const MAX_CURSOR_TRANSCRIPTS = 32;
export const MAX_LIVE_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function numericOffsets(value: unknown): Record<string, number> {
	const offsets: Record<string, number> = {};
	if (!isJsonObject(value)) return offsets;
	for (const [path, offset] of Object.entries(value)) {
		if (isValidOffset(offset)) {
			offsets[path] = offset;
		}
	}
	return offsets;
}

function isValidOffset(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readCursor(cursorPath: string): Cursor {
	try {
		const parsed: unknown = JSON.parse(readFileSync(cursorPath, "utf-8"));
		if (isJsonObject(parsed)) {
			const offsets = numericOffsets(parsed.offsets);
			if (typeof parsed.path !== "string" || !isValidOffset(parsed.offset)) {
				return { path: "", offset: 0, offsets };
			}
			offsets[parsed.path] = parsed.offset;
			return { path: parsed.path, offset: parsed.offset, offsets };
		}
	} catch (err) {
		void err; // missing/corrupt cursor → start fresh
	}
	return { path: "", offset: 0, offsets: {} };
}

function updatedCursor(cursor: Cursor, transcriptPath: string, offset: number): Cursor {
	const offsets = { ...cursor.offsets };
	delete offsets[transcriptPath];
	offsets[transcriptPath] = offset;
	const paths = Object.keys(offsets);
	for (let i = 0; i < paths.length - MAX_CURSOR_TRANSCRIPTS; i++) {
		const oldest = paths[i];
		if (oldest !== undefined) delete offsets[oldest];
	}
	return { path: transcriptPath, offset, offsets };
}

interface TranscriptDrain {
	records: TimelineRecord[];
	cursor: Cursor;
}

function readRange(path: string, start: number, end: number): Buffer {
	const expected = Math.max(0, end - start);
	const buffer = Buffer.alloc(expected);
	const fd = openSync(path, "r");
	let bytesRead = 0;
	try {
		while (bytesRead < expected) {
			const count = readSync(fd, buffer, bytesRead, expected - bytesRead, start + bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
	} finally {
		closeSync(fd);
	}
	return bytesRead === expected ? buffer : buffer.subarray(0, bytesRead);
}

function completeJsonlLength(buffer: Buffer): number {
	const afterLastNewline = buffer.lastIndexOf(0x0a) + 1;
	const trailing = buffer.subarray(afterLastNewline).toString("utf-8").trim();
	if (trailing.length === 0) return afterLastNewline;
	try {
		return isJsonObject(JSON.parse(trailing)) ? buffer.length : afterLastNewline;
	} catch {
		return afterLastNewline;
	}
}

/** New complete JSONL records appended to `transcriptPath` since the cursor.
 *  A syntactically complete final object is accepted without a trailing LF;
 *  otherwise the returned cursor stops after the last newline so a writer
 *  split across hook events is retried rather than silently skipped. */
function readNewRecords(transcriptPath: string, cursorPath: string): TranscriptDrain | null {
	const size = statSync(transcriptPath).size;
	const cursor = readCursor(cursorPath);
	let offset = cursor.offsets[transcriptPath] ?? 0;
	if (offset > size) offset = 0;
	if (offset === size) return null;
	const readStart = Math.max(offset, size - MAX_LIVE_TRANSCRIPT_BYTES);
	const buffer = readRange(transcriptPath, readStart, size);
	const completeLength = completeJsonlLength(buffer);
	if (completeLength === 0) return null;
	let textStart = 0;
	if (readStart > offset) {
		textStart = buffer.indexOf(0x0a) + 1;
	}
	const nextOffset = readStart + completeLength;
	const text = buffer.subarray(textStart, completeLength).toString("utf-8");
	return {
		records: parseTranscriptText(text),
		cursor: updatedCursor(cursor, transcriptPath, nextOffset),
	};
}

function writeCursor(cursorPath: string, cursor: Cursor): void {
	mkdirSync(dirname(cursorPath), { recursive: true });
	writeFileSync(cursorPath, JSON.stringify(cursor));
}

// Daemon-lifetime dedup: the record keys already in timeline.jsonl, per cwd.
// Seeded once from disk on first use, then grown as the live path appends — so
// a cursor-reset (first sight of a session the backfill already captured)
// re-reads its records but appends none of them twice. Bounds the per-event
// cost to a single seed read. Mirrors activity-writer.ts's per-cwd `keyCache`.
const seenKeysByCwd = new Map<string, Set<string>>();

// Cap the per-cwd dedup set so a long-lived daemon can't grow it without bound
// (it otherwise accretes one key per content block ever captured). Sets iterate
// in insertion order, so evicting from the front drops the OLDEST keys — least
// likely to be re-read by a cursor reset — keeping the most recent for correct
// in-session dedup. (The backfill stays the completeness backstop for the rare
// evicted-then-re-read case.)
export const MAX_SEEN_KEYS_PER_CWD = 20_000;

export function boundKeySet(set: Set<string>, max = MAX_SEEN_KEYS_PER_CWD): void {
	const over = set.size - max;
	if (over <= 0) return;
	let removed = 0;
	for (const key of set) {
		set.delete(key);
		if (++removed >= over) break;
	}
}

function seenKeys(cwd: string): Set<string> {
	let set = seenKeysByCwd.get(cwd);
	if (!set) {
		set = recentTimelineKeys(cwd, MAX_SEEN_KEYS_PER_CWD);
		seenKeysByCwd.set(cwd, set);
	}
	return set;
}

/** Records not already in the timeline. Does not mutate `seen`: callers only
 *  commit those keys after the corresponding append succeeds. */
function filterFresh(records: TimelineRecord[], seen: Set<string>): TimelineRecord[] {
	const fresh: TimelineRecord[] = [];
	const pending = new Set<string>();
	for (const r of records) {
		const key = recordKey(r);
		if (seen.has(key) || pending.has(key)) continue;
		pending.add(key);
		fresh.push(r);
	}
	return fresh;
}

function rememberRecords(records: TimelineRecord[], seen: Set<string>): void {
	for (const record of records) seen.add(recordKey(record));
	boundKeySet(seen);
}

/**
 * Drain the event's transcript and append any new records to timeline.jsonl.
 * Best-effort / fail-open. Resolves the transcript from the payload (or the
 * standard `~/.claude/projects/...` layout), reads from the per-cwd cursor at
 * `.interlinked/timeline-cursor.json`, dedups against the timeline, and appends.
 * No-op when the transcript can't be resolved.
 */
export function captureTimeline(event: HarnessEvent, fallbackCwd: string): void {
	try {
		// Codex rollouts use the `ordinal/payload` envelope, not Claude's
		// top-level assistant-message schema consumed by parseTranscriptText.
		// Reading them produces zero records and can be hundreds of megabytes;
		// Codex has its own rollout collector, so keep this legacy reader scoped
		// to providers whose transcript shape it understands.
		if (event.agent_source === "codex") return;
		const cwd = event.cwd ?? fallbackCwd;
		const transcriptPath = resolveTranscriptPath(event.transcript_path, event.session_id, cwd, homedir());
		if (!transcriptPath || !existsSync(transcriptPath)) return;
		const cursorPath = join(cwd, ".interlinked", "timeline-cursor.json");
		const drain = readNewRecords(transcriptPath, cursorPath);
		if (!drain) return;
		const seen = seenKeys(cwd);
		const fresh = filterFresh(drain.records, seen);
		if (fresh.length > 0 && !appendTimelineRecords(fresh, cwd)) return;
		rememberRecords(fresh, seen);
		writeCursor(cursorPath, drain.cursor);
	} catch (err) {
		void err; // best-effort capture — never break the daemon pipeline
	}
}

/** Read cap for a one-shot transcript drain. A subagent transcript is
 *  typically well under 1MB; anything past this cap reads only the TAIL
 *  (newest entries win — the final result message is what capture exists
 *  for). Keeps a pathological transcript from stalling the daemon. */
const MAX_ONESHOT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * One-shot drain of a SUBAGENT transcript into timeline.jsonl. Unlike
 * `captureTimeline` this does NOT touch the per-cwd cursor — the cursor
 * tracks the MAIN session transcript, and pointing it at an agent file
 * would force a full re-read of the main transcript on the next event.
 * Subagent transcripts are separate files (`<session>/subagents/agent-*.jsonl`)
 * that the main cursor never visits, so a full-file read + the daemon-lifetime
 * dedup set gives idempotency without cursor state. Fires on SubagentStop —
 * once per agent (a re-fire after agent resume re-reads and appends only the
 * new records). Best-effort / fail-open. Returns the number of records
 * appended (0 on any failure).
 */
export function captureAgentTranscript(agentTranscriptPath: string | undefined, cwd: string): number {
	try {
		if (!agentTranscriptPath || !existsSync(agentTranscriptPath)) return 0;
		const size = statSync(agentTranscriptPath).size;
		const offset = Math.max(0, size - MAX_ONESHOT_TRANSCRIPT_BYTES);
		const buffer = readRange(agentTranscriptPath, offset, size);
		const completeLength = completeJsonlLength(buffer);
		if (completeLength === 0) return 0;
		let textStart = 0;
		// A tail read may start mid-line; drop the partial first line.
		if (offset > 0) textStart = buffer.indexOf(0x0a) + 1;
		const text = buffer.subarray(textStart, completeLength).toString("utf-8");
		const seen = seenKeys(cwd);
		const fresh = filterFresh(parseTranscriptText(text), seen);
		if (fresh.length > 0 && !appendTimelineRecords(fresh, cwd)) return 0;
		rememberRecords(fresh, seen);
		return fresh.length;
	} catch (err) {
		void err; // best-effort capture — never break the daemon pipeline
		return 0;
	}
}
