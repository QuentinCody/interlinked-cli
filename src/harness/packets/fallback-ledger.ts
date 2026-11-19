// Instruction packets — which released texts a session has actually RECEIVED (design §9, seventh review).
//
// A released instruction must reach the model whenever its packet is not live, and only once per context: a
// repeat every call bloats the context the release was meant to save. "Received" can only be known where the
// output is encoded for the runner's native event, i.e. in the hook process: the daemon does not know the
// native event, and an adapter may route the same warning to model-visible JSON context on one event and to
// exit-0 stderr (never shown to the model) on another (Cursor afterShellExecution vs postToolUse).
//
// So the hook records, after encoding, the fallback lines whose header made it into stdout
// (`recordVisibleFallback`), and every proposer — the daemon's SessionStart and PostToolUse phases, the outage
// path, the window queue, and the cold path — skips ids already received in this session (`deliveredIds`).
// A SessionStart starts a fresh context (start, resume, clear, compact), so it RESETS the set to what it
// carried, which is nothing when the runner's SessionStart is not model-visible. Durable on disk, shared by the
// daemon and the cold path, survives a daemon restart. Rows: `.interlinked/packet-fallback-delivered.jsonl`.

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FALLBACK_LEDGER = "packet-fallback-delivered.jsonl";
/** A session's rows are written near its start and on each delivery; the newest 512 KB (≈ 5,000 rows) hold them. */
export const LEDGER_KEEP_BYTES = 512 * 1024;
/** Past this size a write compacts the ledger to its newest LEDGER_KEEP_BYTES (every SessionStart adds a row). */
export const LEDGER_MAX_BYTES = 2 * LEDGER_KEEP_BYTES;
const TAIL_BYTES = LEDGER_KEEP_BYTES;
const FALLBACK_HEADER = /\[interlinked:packet ([a-z0-9][a-z0-9_.-]{0,99})\] not live here \(/g;

export interface FallbackRow {
	ts: string;
	session_id: string;
	/** `start` replaces the session's delivered set; `delivered` adds to it. */
	kind: "start" | "delivered";
	packets: string[];
	/** Which hook path encoded it: the daemon's reply or the cold fallback. */
	via: "daemon" | "cold";
}

/** Packet ids of the fallback lines in `warnings`, first occurrence order, each once. */
export function fallbackIdsIn(warnings: readonly string[]): string[] {
	const ids: string[] = [];
	for (const w of warnings) {
		for (const m of w.matchAll(FALLBACK_HEADER)) {
			const id = m[1] as string;
			if (m.index === 0 && !ids.includes(id)) ids.push(id);
		}
	}
	return ids;
}

function readTail(path: string): string {
	return readTailAt(path).text;
}

/** The whole lines of the newest TAIL_BYTES, and the file size they were read at. */
function readTailAt(path: string): { text: string; size: number } {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		const text = buf.toString("utf8");
		return { text: start === 0 ? text : text.slice(text.indexOf("\n") + 1), size };
	} finally {
		closeSync(fd);
	}
}

/** Bytes [from, to) of the file. */
function readRange(path: string, from: number, to: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(Math.max(0, to - from));
		const n = readSync(fd, buf, 0, buf.length, from);
		return buf.subarray(0, n);
	} finally {
		closeSync(fd);
	}
}

/** True when the file is non-empty and its last byte is not a newline (a torn last row). */
function endsTorn(path: string): boolean {
	if (!existsSync(path)) return false;
	const size = statSync(path).size;
	return size > 0 && readRange(path, size - 1, size)[0] !== 0x0a;
}

function parseRow(line: string): FallbackRow | null {
	try {
		const row = JSON.parse(line) as Partial<FallbackRow>;
		if (typeof row.session_id !== "string" || (row.kind !== "start" && row.kind !== "delivered") || !Array.isArray(row.packets)) return null;
		return row as FallbackRow;
	} catch {
		return null; // a torn line is skipped; the next delivery re-records
	}
}

/** Released packet ids this session has received since its last SessionStart. */
export function deliveredIds(interlinkedDir: string, sessionId: string): Set<string> {
	const path = join(interlinkedDir, FALLBACK_LEDGER);
	const out = new Set<string>();
	if (NO_SESSION.has(sessionId) || !existsSync(path)) return out;
	let text: string;
	try {
		text = readTail(path);
	} catch {
		return out;
	}
	for (const line of text.split("\n")) {
		if (!line) continue;
		const row = parseRow(line);
		if (!row || row.session_id !== sessionId) continue;
		if (row.kind === "start") out.clear();
		for (const id of row.packets) if (typeof id === "string") out.add(id);
	}
	return out;
}

/** True when the encoded output carries this fallback line's header — raw, or escaped inside a JSON string. */
function carried(stdout: string, warning: string): boolean {
	const header = warning.split("\n")[0] as string;
	return stdout.includes(header) || stdout.includes(JSON.stringify(header).slice(1, -1));
}

/** What the runner does with this native event's output, from its capability table (never from stdout alone: the
 *  OpenCode and Pi bridges print warnings on events the model never sees — break R1). */
export interface DeliveryChannel {
	modelVisible: boolean;
	/** Characters of context the runner keeps (Codex: 2,500); a line ending past it was cut, so it was not received. */
	limit?: number | undefined;
	/** Characters the adapter puts before the warnings in the context (`additional_context` and its newline). */
	prefix?: number | undefined;
}

/** A session id no runner sent (the normalizer's placeholder) is shared by every such session: never recorded. */
const NO_SESSION = new Set(["", "unknown"]);

/** Fallback lines the model received whole: the channel is model-visible, stdout carries the line, and the line
 *  ends inside the runner's context limit (the context is the warnings joined by newlines after `prefix`). */
function receivedIds(warnings: readonly string[], stdout: string | undefined, channel: DeliveryChannel): string[] {
	if (!channel.modelVisible || stdout === undefined) return [];
	const out: string[] = [];
	let offset = channel.prefix ?? 0;
	for (const w of warnings) {
		const end = offset + w.length;
		offset = end + 1;
		const id = fallbackIdsIn([w])[0];
		if (id === undefined || !carried(stdout, w)) continue;
		if (channel.limit !== undefined && end > channel.limit) continue;
		if (!out.includes(id)) out.push(id);
	}
	return out;
}

/** After the hook encoded `warnings` into `stdout` for one native event: record the fallback lines the model
 *  received. A SessionStart always records (a reset) once the ledger exists or it proposed a line. */
export function recordVisibleFallback(interlinkedDir: string, event: { session_id: string; phase: string }, rawWarnings: readonly unknown[], stdout: string | undefined, via: FallbackRow["via"], channel: DeliveryChannel): void {
	if (NO_SESSION.has(event.session_id)) return;
	const warnings = rawWarnings.filter((w): w is string => typeof w === "string");
	const fallbacks = warnings.filter((w) => fallbackIdsIn([w]).length > 0);
	const visible = receivedIds(warnings, stdout, channel);
	const path = join(interlinkedDir, FALLBACK_LEDGER);
	const start = event.phase === "session-start";
	if (start ? fallbacks.length === 0 && !existsSync(path) : visible.length === 0) return;
	const row: FallbackRow = { ts: new Date().toISOString(), session_id: event.session_id, kind: start ? "start" : "delivered", packets: visible, via };
	try {
		if (!existsSync(interlinkedDir)) return;
		// After a torn last line, start on a new line, or this receipt joins the torn one and is lost (R6 P2).
		appendFileSync(path, `${endsTorn(path) ? "\n" : ""}${JSON.stringify(row)}\n`, { mode: 0o600 });
		compactIfLarge(path);
	} catch {
		// A lost record means one more proposal on the next call, never a lost instruction.
		return;
	}
}

/** Rewrite a ledger past LEDGER_MAX_BYTES to the whole lines of its newest LEDGER_KEEP_BYTES (temp + rename). Only
 *  rows older than every read window go. Whole rows another hook appends after the tail read are copied into the
 *  temp just before the rename (R6 P3); only a row appended in the stat-to-rename gap can still be lost, and that
 *  costs one more proposal of the words, never a lost instruction. `beforeRename` is a test seam for that race. */
export function compactIfLarge(path: string, beforeRename?: () => void): void {
	if (statSync(path).size <= LEDGER_MAX_BYTES) return;
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		// Bytes only, never decoded (R6 P3): keep whole rows of the tail and copy from the end of the last one, so a
		// torn (even mid-character) last row is copied raw once its writer finishes it.
		const size = statSync(path).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = readRange(path, start, size);
		const first = start === 0 ? 0 : buf.indexOf(0x0a) + 1;
		const last = buf.lastIndexOf(0x0a) + 1;
		const kept = last > first ? buf.subarray(first, last) : Buffer.alloc(0);
		const copyFrom = start + Math.max(first, last);
		writeFileSync(tmp, kept, { mode: 0o600 });
		beforeRename?.();
		const grown = statSync(path).size;
		if (grown > copyFrom) {
			const extra = readRange(path, copyFrom, grown);
			const end = extra.lastIndexOf(0x0a);
			if (end >= 0) appendFileSync(tmp, extra.subarray(0, end + 1));
		}
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}
