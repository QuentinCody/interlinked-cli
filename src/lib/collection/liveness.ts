// ===========================================
// Collection-stream liveness
// ===========================================
// Answers one question deterministically: "is data collection actually
// advancing?" Reads only the TAIL of collection.jsonl (the canonical
// `collection.v1` stream — see `writer.ts`), so it is O(tailBytes) regardless
// of how large the log has grown.
//
// This exists because the stream can silently stop advancing (a hook gets
// unwired, the daemon dies, the disk fills) with no other signal. The legacy
// `activity.jsonl` froze for days exactly this way before anyone noticed.
// `interlinked doctor`/`status` surface this readout; a regression test pins
// the write path so a code change that breaks recording fails CI.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isJsonObject } from "../json-types.js";
import { getCollectionPath } from "./writer.js";

type CollectionLivenessStatus =
	| "live" // last record is recent — collection is flowing
	| "idle" // older than idleMs but < staleMs — plausibly just no recent activity
	| "stale" // older than staleMs — likely broken if a session is active
	| "empty" // file exists but holds no parseable record
	| "missing" // file does not exist yet
	| "unreadable"; // file exists but the tail could not be read/parsed

export interface CollectionLiveness {
	status: CollectionLivenessStatus;
	path: string;
	exists: boolean;
	sizeBytes: number;
	mtimeMs: number | null;
	/** `ts` of the last record in the stream, or null if none was parseable. */
	lastRecordTs: string | null;
	/** `now - lastRecordTs` in ms, or null when there is no last record. */
	lastRecordAgeMs: number | null;
	reason: string;
}

interface CollectionLivenessOpts {
	/** Injectable clock (ms since epoch) — tests pass a fixed value. */
	now?: number;
	/** At or under this age the stream is "live". Default 5 min. */
	idleMs?: number;
	/** Beyond this age the stream is "stale" (suspected broken). Default 24 h. */
	staleMs?: number;
	/** Trailing bytes scanned for the last record. Default 64 KiB. */
	tailBytes?: number;
}

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_STALE_MS = 24 * 60 * 60_000;
const DEFAULT_TAIL_BYTES = 64 * 1024;

/** Read the trailing `tailBytes` of a file as UTF-8. Returns null on any I/O
 *  error. The first line of the slice may be a partial record when the cut
 *  lands mid-line — callers only trust the LAST complete line. */
function readTail(path: string, size: number, tailBytes: number): string | null {
	const readLen = Math.min(tailBytes, size);
	if (readLen <= 0) return null;
	const start = size - readLen;
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.allocUnsafe(readLen);
		readSync(fd, buf, 0, readLen, start);
		return buf.toString("utf-8");
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** Extract the `ts` field of the last complete JSONL record in a tail slice.
 *  Replaces `JSON.parse(line) as { ts?: unknown }` — the cast never checked
 *  that the parsed value was even an object, so a garbled non-object line
 *  (rather than throwing in JSON.parse) would read `.ts` off a primitive and
 *  silently return `undefined` disguised as a valid parse. */
function lastRecordTsFromTail(tail: string): string | null {
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line);
			if (!isJsonObject(parsed)) continue;
			const ts = parsed.ts;
			return typeof ts === "string" ? ts : null;
		} catch {
			// Partial/garbled line — the tail cut landed mid-record. Walk back
			// to the previous complete line rather than failing the whole read.
			continue;
		}
	}
	return null;
}

/** Classify how fresh the collection stream is. Pure given `opts.now`. */
export function getCollectionLiveness(
	cwd: string,
	opts: CollectionLivenessOpts = {},
): CollectionLiveness {
	const path = getCollectionPath(cwd);
	const now = opts.now ?? Date.now();
	const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
	const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
	const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;

	const base = { path, exists: true, lastRecordTs: null, lastRecordAgeMs: null };

	if (!existsSync(path)) {
		return {
			...base,
			exists: false,
			status: "missing",
			sizeBytes: 0,
			mtimeMs: null,
			reason: "collection.jsonl does not exist — no tool events have been recorded yet",
		};
	}

	let sizeBytes = 0;
	let mtimeMs: number | null = null;
	try {
		const st = statSync(path);
		sizeBytes = st.size;
		mtimeMs = st.mtimeMs;
	} catch {
		return {
			...base,
			status: "unreadable",
			sizeBytes: 0,
			mtimeMs: null,
			reason: "collection.jsonl could not be stat'd",
		};
	}

	if (sizeBytes === 0) {
		return { ...base, status: "empty", sizeBytes, mtimeMs, reason: "collection.jsonl is empty" };
	}

	const tail = readTail(path, sizeBytes, tailBytes);
	const lastTs = tail ? lastRecordTsFromTail(tail) : null;
	if (!lastTs) {
		return {
			...base,
			status: "unreadable",
			sizeBytes,
			mtimeMs,
			reason: "could not parse a record timestamp from the tail of collection.jsonl",
		};
	}

	const lastMs = Date.parse(lastTs);
	if (Number.isNaN(lastMs)) {
		return {
			...base,
			status: "unreadable",
			sizeBytes,
			mtimeMs,
			lastRecordTs: lastTs,
			reason: `last record has an unparseable ts: ${lastTs}`,
		};
	}

	const ageMs = now - lastMs;
	const common = {
		path,
		exists: true,
		sizeBytes,
		mtimeMs,
		lastRecordTs: lastTs,
		lastRecordAgeMs: ageMs,
	};
	if (ageMs <= idleMs) {
		return { ...common, status: "live", reason: `last record ${formatAge(ageMs)} ago` };
	}
	if (ageMs <= staleMs) {
		return {
			...common,
			status: "idle",
			reason: `last record ${formatAge(ageMs)} ago — no recent tool events`,
		};
	}
	return {
		...common,
		status: "stale",
		reason: `last record ${formatAge(ageMs)} ago — data collection may be broken`,
	};
}

/** Compact human age: "8s", "5m", "3h", "2d". Negative clamps to "0s" (clock
 *  skew — a record stamped slightly in the future). */
export function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}
