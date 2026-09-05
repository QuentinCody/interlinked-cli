// ===========================================
// Timeline writer — append / rebuild .interlinked/timeline.jsonl
// ===========================================
// The unified, append-only, time-sorted record of everything an agent did,
// one categorized `TimelineRecord` per line (see transcript-record.ts). Two
// write paths share this module:
//   - LIVE   — `appendTimelineRecords` appends new records as the daemon drains
//              the transcript on each event (timeline-capture.ts). Fail-open.
//   - BACKFILL — `writeTimeline` rebuilds the whole file, time-sorted + deduped,
//              from every transcript (timeline-backfill.ts). Idempotent.
//
// Dedup key is `${uuid}#${seq}` (entry uuid + block index): stable across
// re-runs, so backfilling twice — or backfilling a session the live path
// already captured — reproduces the same file rather than duplicating rows.

import {
	appendFileSync,
	mkdirSync,
	statSync,
} from "node:fs";
import { dirname } from "node:path";
import { MAX_CAPTURED_JSONL_LINE_BYTES, scanFileLines } from "../lib/bounded-file-io.js";
import {
	type FileIdentity,
	sameFileIdentity,
} from "../lib/file-suffix-replacement.js";
import { isJsonObject } from "../lib/json-types.js";
import {
	appendFileWithMutationLock,
	withFileMutationLock,
} from "../lib/file-mutation-lock.js";
import { readRecentLines } from "../lib/local-activity-collection.js";
import { serializeRecord, timelinePath } from "./timeline-record-utils.js";
import {
	assertTimelineMaterializationBounds,
	captureTimelineBasis,
	type TimelineRewriteBasis,
} from "./timeline-rewrite.js";
import type { TimelineRecord } from "./transcript-record.js";
import { captureEnvelope, recordCaptureReceipt } from "../lib/data/capture.js";
import { captureTimelineUsage } from "./data-capture-usage.js";
import { assertCaptureIsolation } from "../lib/data/capture-isolation.js";

export {
	dedupeTimeline,
	recordKey,
	serializeRecord,
	sortTimeline,
	TIMELINE_FILENAME,
	timelinePath,
} from "./timeline-record-utils.js";
export {
	MAX_TIMELINE_REWRITE_BYTES,
	MAX_TIMELINE_REWRITE_CATCHUPS,
	MAX_TIMELINE_REWRITE_CATCHUP_BYTES,
	MAX_TIMELINE_REWRITE_RECORDS,
	TimelineRewriteConflictError,
	writeTimeline,
} from "./timeline-rewrite.js";
/** Live-capture seed bound. Backfill keeps the full reader below; the daemon
 * only needs the same recent key window it retains in memory. */
export const RECENT_TIMELINE_KEY_BYTES = 4 * 1024 * 1024;
/** Compatibility-only full-key scan limits. Normal collection uses the
 * candidate-driven scanner below and therefore does not retain historical
 * keys. These bounds prevent callers from turning a large log into an
 * unbounded Set. */
export const MAX_EXISTING_TIMELINE_KEY_SCAN_BYTES = 64 * 1024 * 1024;
export const MAX_EXISTING_TIMELINE_KEYS = 250_000;

/** Append records as JSONL to the timeline log (live path). Creates the dir if
 *  missing. Best-effort: never throws (fail-open, like the rest of capture).
 *  Returns whether every record was appended so callers can commit cursors and
 *  in-memory dedup state only after durable-enough filesystem success. */
export function appendTimelineRecords(records: TimelineRecord[], cwd: string): boolean {
	if (records.length === 0) return true;
	assertCaptureIsolation(timelinePath(cwd));
	try {
		const path = timelinePath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		assertTimelineMaterializationBounds(records, "timeline append input");
		const body = records.map((record) => serializeRecord(Object.assign({}, record, {
			capture: captureEnvelope({ cwd, producer: "harness/timeline-writer", session: record.session }),
		}))).join("\n");
		appendFileWithMutationLock(path, `${body}\n`);
		recordCaptureReceipt({ cwd, producer: "harness/timeline-writer" }, { source: "timeline", status: "written", records: records.length, bytes: Buffer.byteLength(body) + 1 });
		captureTimelineUsage(cwd, records);
		return true;
	} catch (err) {
		void err;
		recordCaptureReceipt({ cwd, producer: "harness/timeline-writer" }, { source: "timeline", status: "failed", error: "append-failed" });
		return false;
	}
}

/** One JSONL line's dedup key (`uuid#seq`), or null when the line is corrupt
 *  or its `uuid`/`seq` fields are missing or the wrong type. Never throws. */
function parseTimelineDedupKey(line: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const { uuid, seq } = parsed;
	if (typeof uuid !== "string" || typeof seq !== "number") return null;
	return `${uuid}#${seq}`;
}

export class TimelineScanError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TimelineScanError";
	}
}

export interface TimelineScanReceipt {
	identity: FileIdentity | null;
	eof: number;
}

function strictTimelineDedupKey(line: string): string {
	const key = parseTimelineDedupKey(line);
	if (key === null) {
		throw new TimelineScanError(
			"timeline contains malformed JSON or a row without a string uuid and numeric seq",
		);
	}
	return key;
}

function timelineSize(path: string): number | null {
	try {
		return statSync(path).size;
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw new TimelineScanError(`cannot inspect timeline: ${path}`, { cause: error });
	}
}

function scanTimelineKeys(
	path: string,
	endExclusive: number,
	visitor: (key: string) => boolean | void,
): void {
	try {
		scanFileLines(
			path,
			(line) => {
				if (!line.nonEmpty) return;
				if (line.oversized || line.text === undefined) {
					throw new TimelineScanError(
						`timeline contains a row larger than ${MAX_CAPTURED_JSONL_LINE_BYTES} bytes`,
					);
				}
				return visitor(strictTimelineDedupKey(line.text));
			},
			{ endExclusive, includeFinalLine: true },
		);
	} catch (error) {
		if (error instanceof TimelineScanError) throw error;
		throw new TimelineScanError(`cannot scan timeline: ${path}`, { cause: error });
	}
}

/** Delete keys already present in the timeline from a bounded incoming
 * candidate collection. The historical file is streamed and never retained.
 * Candidate deletions apply only after the entire captured file validates, so
 * a corrupt tail cannot produce a partial/clean-looking result. Missing files
 * leave the candidates unchanged. Corrupt, oversized, or unreadable rows fail
 * closed rather than laundering history into an empty key set. */
export function removeExistingTimelineCandidates(
	cwd: string,
	candidates: {
		readonly size: number;
		has(key: string): boolean;
		delete(key: string): boolean;
	},
): TimelineScanReceipt {
	if (candidates.size > MAX_EXISTING_TIMELINE_KEYS) {
		throw new TimelineScanError(
			`refusing ${candidates.size} timeline candidates (limit ${MAX_EXISTING_TIMELINE_KEYS})`,
		);
	}
	const path = timelinePath(cwd);
	const basis = captureTimelineBasis(path);
	if (basis.identity === null || basis.eof === 0) {
		return { identity: basis.identity, eof: basis.eof };
	}
	const matched = new Set<string>();
	scanTimelineKeys(path, basis.eof, (key) => {
		if (candidates.has(key)) matched.add(key);
	});
	for (const key of matched) candidates.delete(key);
	return { identity: basis.identity, eof: basis.eof };
}

function timelineBasisMatches(
	current: TimelineRewriteBasis,
	expected: TimelineScanReceipt,
): boolean {
	if (expected.identity === null) return current.identity === null && current.eof === 0;
	return (
		current.identity !== null &&
		sameFileIdentity(current.identity, expected.identity) &&
		current.eof === expected.eof
	);
}

/** Validate the scan receipt and append under the same mutation lock. A false
 * result means the timeline changed after it was scanned; callers must refuse
 * or rescan, never append against the stale candidate decision. `dryRun`
 * performs the validation without writing. */
export function appendTimelineRecordsAtBasis(
	options: {
		records: TimelineRecord[];
		cwd: string;
		basis: TimelineScanReceipt;
		dryRun?: boolean;
	},
): boolean {
	const { records, cwd, basis, dryRun = false } = options;
	assertTimelineMaterializationBounds(records, "timeline collection input");
	const path = timelinePath(cwd);
	if (dryRun || records.length === 0) {
		return timelineBasisMatches(captureTimelineBasis(path), basis);
	}
	mkdirSync(dirname(path), { recursive: true });
	const body = `${records.map(serializeRecord).join("\n")}\n`;
	return withFileMutationLock(path, () => {
		if (!timelineBasisMatches(captureTimelineBasis(path), basis)) return false;
		if (body.length > 0) appendFileSync(path, body);
		return true;
	});
}

/** The dedup keys already present in a small timeline log. This compatibility
 * API has explicit byte and key ceilings because retaining every historical
 * key is inherently non-streaming. Missing files return an empty set;
 * corrupt, oversized, unreadable, or over-limit files throw. Prefer
 * {@link removeExistingTimelineCandidates} for collection paths. */
export function existingTimelineKeys(cwd: string): Set<string> {
	const keys = new Set<string>();
	const path = timelinePath(cwd);
	const size = timelineSize(path);
	if (size === null || size === 0) return keys;
	if (size > MAX_EXISTING_TIMELINE_KEY_SCAN_BYTES) {
		throw new TimelineScanError(
			`refusing to retain keys from ${size} timeline bytes (limit ${MAX_EXISTING_TIMELINE_KEY_SCAN_BYTES})`,
		);
	}
	scanTimelineKeys(path, size, (key) => {
		keys.add(key);
		if (keys.size > MAX_EXISTING_TIMELINE_KEYS) {
			throw new TimelineScanError(
				`timeline contains more than ${MAX_EXISTING_TIMELINE_KEYS} distinct keys`,
			);
		}
	});
	return keys;
}

/** Recent dedup keys for the daemon's bounded live-capture cache. Reads from
 * the file tail directly; unlike {@link existingTimelineKeys}, it never
 * materializes the full append-only timeline. Newest rows win. */
export function recentTimelineKeys(
	cwd: string,
	maxKeys: number,
	maxBytes: number = RECENT_TIMELINE_KEY_BYTES,
): Set<string> {
	const keys = new Set<string>();
	if (maxKeys <= 0 || maxBytes <= 0) return keys;
	try {
		for (const line of readRecentLines(timelinePath(cwd), maxKeys, maxBytes)) {
			const key = parseTimelineDedupKey(line);
			if (key !== null) keys.add(key);
		}
	} catch (err) {
		void err;
	}
	return keys;
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}
