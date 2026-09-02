// interlinked-tdd: exempt
// ===========================================
// Local Activity — sync cursor, sync-error log, unsynced-event reader
// ===========================================
// Extracted from local-activity.ts to keep that module under the per-file
// line cap. Depends on node:fs/path, the data-dir path helpers, and the
// shared types — never imports back from the main module (leaf cluster).

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	MAX_CAPTURED_JSONL_LINE_BYTES,
	readFileRange,
	scanFileLines,
} from "./bounded-file-io.js";
import {
	fileIdentity,
	type FileIdentity,
	sameFileIdentity,
} from "./file-suffix-replacement.js";
import { withFileMutationLock } from "./file-mutation-lock.js";
import { isJsonObject } from "./json-types.js";
import { parseLocalActivityEvent } from "./local-activity-collection.js";
import {
	getActivityPath,
	getSyncErrorsPath,
	getSyncStatePath,
} from "./local-activity-paths.js";
import type {
	LastSyncSummary,
	LocalActivityEvent,
	SyncState,
} from "./local-activity-types.js";
/**
 * Read the sync cursor (byte offset into activity.jsonl).
 */
export const MAX_SYNC_STATE_BYTES = 64 * 1024;

const EMPTY_SYNC_STATE: SyncState = { synced_through_bytes: 0, last_sync_at: "" };
const SUMMARY_TOOL_TUPLE_LENGTH = 2;

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function countMap(value: unknown): Record<string, number> | null {
	if (!isJsonObject(value)) return null;
	// SAFETY: this null-prototype dictionary is populated only with own string
	// keys whose values pass nonNegativeSafeInteger below.
	const result: Record<string, number> = Object.create(null) as Record<string, number>;
	for (const [key, count] of Object.entries(value)) {
		if (!nonNegativeSafeInteger(count)) return null;
		Object.defineProperty(result, key, {
			value: count,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return result;
}

function parseTopTools(value: unknown): [string, number][] | null {
	if (!Array.isArray(value)) return null;
	const topTools: [string, number][] = [];
	for (const entry of value) {
		if (
			!Array.isArray(entry) ||
			entry.length !== SUMMARY_TOOL_TUPLE_LENGTH ||
			typeof entry[0] !== "string" ||
			!nonNegativeSafeInteger(entry[1])
		) {
			return null;
		}
		topTools.push([entry[0], entry[1]]);
	}
	return topTools;
}

type SummaryCounts = Pick<
	LastSyncSummary,
	"events_total" | "accepted" | "skipped" | "scrubbed" | "batches" | "sessions"
>;

function parseSummaryCounts(value: Record<string, unknown>): SummaryCounts | null {
	const { events_total, accepted, skipped, scrubbed, batches, sessions } = value;
	if (
		!nonNegativeSafeInteger(events_total) ||
		!nonNegativeSafeInteger(accepted) ||
		!nonNegativeSafeInteger(skipped) ||
		!nonNegativeSafeInteger(scrubbed) ||
		!nonNegativeSafeInteger(batches) ||
		!nonNegativeSafeInteger(sessions)
	) {
		return null;
	}
	return { events_total, accepted, skipped, scrubbed, batches, sessions };
}

function parseSummaryTimeRange(value: unknown): LastSyncSummary["time_range"] | null {
	if (!isJsonObject(value)) return null;
	if (typeof value.earliest !== "string" || typeof value.latest !== "string") return null;
	return { earliest: value.earliest, latest: value.latest };
}

function parseLastSyncSummary(value: unknown): LastSyncSummary | null {
	if (!isJsonObject(value)) return null;
	const byType = countMap(value.by_type);
	const byAgent = countMap(value.by_agent);
	const topTools = parseTopTools(value.top_tools);
	const timeRange = parseSummaryTimeRange(value.time_range);
	const counts = parseSummaryCounts(value);
	if (!byType || !byAgent || !topTools || !timeRange || !counts) return null;
	if (typeof value.server_url !== "string") return null;
	if (!(typeof value.workspace_id === "string" || value.workspace_id === null)) return null;
	return {
		server_url: value.server_url,
		workspace_id: value.workspace_id,
		events_total: counts.events_total,
		accepted: counts.accepted,
		skipped: counts.skipped,
		scrubbed: counts.scrubbed,
		batches: counts.batches,
		by_type: byType,
		by_agent: byAgent,
		top_tools: topTools,
		sessions: counts.sessions,
		time_range: timeRange,
	};
}

function parseSyncState(value: unknown): SyncState | null {
	if (!isJsonObject(value) || !nonNegativeSafeInteger(value.synced_through_bytes)) return null;
	if (value.last_sync_at !== undefined && typeof value.last_sync_at !== "string") return null;
	const state: SyncState = {
		synced_through_bytes: value.synced_through_bytes,
		last_sync_at: value.last_sync_at ?? "",
	};
	if (value.last_summary !== undefined) {
		const summary = parseLastSyncSummary(value.last_summary);
		if (summary) state.last_summary = summary;
	}
	return state;
}

export function readSyncState(cwd?: string): SyncState {
	const path = getSyncStatePath(cwd);
	if (!existsSync(path)) {
		return { ...EMPTY_SYNC_STATE };
	}
	try {
		const bytes = statSync(path).size;
		if (bytes > MAX_SYNC_STATE_BYTES) {
			return { ...EMPTY_SYNC_STATE };
		}
		const parsed: unknown = JSON.parse(
			readFileRange(path, 0, bytes, MAX_SYNC_STATE_BYTES).toString("utf8"),
		);
		return parseSyncState(parsed) ?? { ...EMPTY_SYNC_STATE };
	} catch (_err) {
		/* intentional: malformed sync-state JSON — reset to "never synced" */
		return { ...EMPTY_SYNC_STATE };
	}
}

/**
 * Advance the sync cursor and optionally store last sync summary.
 */
export function updateSyncState(
	syncedBytes: number,
	summary?: LastSyncSummary,
	cwd?: string,
): void {
	const path = getSyncStatePath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const state: SyncState = {
		synced_through_bytes: syncedBytes,
		last_sync_at: new Date().toISOString(),
	};
	if (summary) {
		state.last_summary = summary;
	}
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Cap for sync-errors.jsonl before rotation. 10 MB is enough to keep
 *  a few thousand recent failures while preventing the multi-GB bloat
 *  observed in production (a single workspace grew this file to 3 GB
 *  with one identical "fetch failed" message per realtime POST). */
const SYNC_ERRORS_MAX_BYTES = 10 * 1024 * 1024;

function rotateSyncErrorsIfNeeded(path: string): void {
	try {
		if (!existsSync(path)) return;
		const size = statSync(path).size;
		if (size < SYNC_ERRORS_MAX_BYTES) return;
		// Single-generation retention: rename to .1 (overwriting any
		// existing .1) and start fresh. A real-world flapping network
		// can fill 10 MB in seconds; deeper retention is wasted bytes.
		const archived = `${path}.1`;
		if (existsSync(archived)) {
			try {
				unlinkSync(archived);
			} catch (_err) {
				/* intentional: stale archive — rename will overwrite on POSIX */
			}
		}
		renameSync(path, archived);
	} catch (_err) {
		/* intentional: rotation is best-effort. If it fails, the next
		   appendSyncError call will continue past the cap until rotation
		   eventually succeeds — no data loss, just delayed cleanup. */
	}
}

/**
 * Persist sync diagnostics for failed pushes and retry outcomes.
 */
export function appendSyncError(
	entry: {
		stage: string;
		message: string;
		status?: number;
		batch?: number;
		attempt?: number;
		transient?: boolean;
	},
	cwd?: string,
): void {
	const path = getSyncErrorsPath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	rotateSyncErrorsIfNeeded(path);
	appendFileSync(
		path,
		`${JSON.stringify({
			ts: new Date().toISOString(),
			stage: entry.stage,
			message: entry.message,
			status: entry.status,
			batch: entry.batch,
			attempt: entry.attempt,
			transient: entry.transient ?? false,
		})}\n`,
	);
}

export interface UnsyncedEvents {
	events: LocalActivityEvent[];
	newOffset: number;
}

interface UnsyncedReadRange {
	/** Override the persisted cursor (used by read-only/dry-run pagination). */
	startOffset?: number;
	/** Freeze a sync run at the activity-log size observed when it started. */
	endExclusive?: number;
	/** Reject pages read after compaction replaced the activity-log inode. */
	expectedIdentity?: FileIdentity;
}

export interface ActivitySyncBasis {
	identity: FileIdentity;
	endExclusive: number;
}

export class SyncCursorInvalidatedError extends Error {
	constructor(reason: string) {
		super(`activity sync cursor basis changed: ${reason}`);
		this.name = "SyncCursorInvalidatedError";
	}
}

export function assertActivitySyncCursor(cursor: number, fileSize: number): void {
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new SyncCursorInvalidatedError(`cursor ${cursor} is not a non-negative safe integer`);
	}
	if (cursor > fileSize) {
		throw new SyncCursorInvalidatedError(`cursor ${cursor} exceeds the ${fileSize}-byte activity log`);
	}
}

/** Capture the inode and EOF that all pages in one manual sync must retain. */
export function captureActivitySyncBasis(expectedCursor: number, cwd?: string): ActivitySyncBasis {
	const activityPath = getActivityPath(cwd);
	return withFileMutationLock(activityPath, () => {
		if (!existsSync(activityPath)) {
			throw new SyncCursorInvalidatedError("activity log disappeared before sync started");
		}
		const currentCursor = readSyncState(cwd).synced_through_bytes;
		if (currentCursor !== expectedCursor) {
			throw new SyncCursorInvalidatedError(
				`persisted cursor moved from ${expectedCursor} to ${currentCursor}`,
			);
		}
		const endExclusive = statSync(activityPath).size;
		assertActivitySyncCursor(expectedCursor, endExclusive);
		return { identity: fileIdentity(activityPath), endExclusive };
	});
}

function assertCheckpointBasis(
	activityPath: string,
	basis: ActivitySyncBasis,
	nextCursor: number,
): void {
	if (!existsSync(activityPath)) {
		throw new SyncCursorInvalidatedError("activity log disappeared before checkpoint");
	}
	if (!sameFileIdentity(fileIdentity(activityPath), basis.identity)) {
		throw new SyncCursorInvalidatedError("activity log was replaced before checkpoint");
	}
	assertActivitySyncCursor(nextCursor, statSync(activityPath).size);
}

interface SyncCheckpoint {
	basis: ActivitySyncBasis;
	expectedCursor: number;
	nextCursor: number;
	summary?: LastSyncSummary;
	cwd?: string;
}

/** Persist a checkpoint only while its inode and preceding cursor still match. */
export function checkpointSyncState(checkpoint: SyncCheckpoint): void {
	const activityPath = getActivityPath(checkpoint.cwd);
	withFileMutationLock(activityPath, () => {
		assertCheckpointBasis(activityPath, checkpoint.basis, checkpoint.nextCursor);
		const currentCursor = readSyncState(checkpoint.cwd).synced_through_bytes;
		if (currentCursor === checkpoint.nextCursor) return;
		if (currentCursor !== checkpoint.expectedCursor) {
			throw new SyncCursorInvalidatedError(
				`persisted cursor moved from ${checkpoint.expectedCursor} to ${currentCursor}`,
			);
		}
		updateSyncState(checkpoint.nextCursor, checkpoint.summary, checkpoint.cwd);
	});
}

function snapshotEnd(requested: number | undefined, fileSize: number): number {
	if (requested === undefined) return fileSize;
	if (!Number.isSafeInteger(requested) || requested < 0) {
		throw new SyncCursorInvalidatedError(`snapshot EOF ${requested} is invalid`);
	}
	if (requested > fileSize) {
		throw new SyncCursorInvalidatedError(
			`snapshot EOF ${requested} exceeds the current ${fileSize}-byte activity log`,
		);
	}
	return requested;
}

function cursorStart(requested: number, endExclusive: number, fileSize: number): number {
	assertActivitySyncCursor(requested, fileSize);
	if (requested > endExclusive) {
		throw new SyncCursorInvalidatedError(
			`cursor ${requested} exceeds snapshot EOF ${endExclusive}`,
		);
	}
	return requested;
}

function boundedReadRange(
	fileSize: number,
	persistedOffset: number,
	range: UnsyncedReadRange,
): { startOffset: number; endExclusive: number } {
	const endExclusive = snapshotEnd(range.endExclusive, fileSize);
	const startOffset = cursorStart(range.startOffset ?? persistedOffset, endExclusive, fileSize);
	return { startOffset, endExclusive };
}

const MAX_SYNC_PAGE_BYTES = 8 * 1024 * 1024;

interface UnsyncedScanState {
	events: LocalActivityEvent[];
	newOffset: number;
	retainedBytes: number;
}

function consumeUnsyncedLine(
	line: Parameters<Parameters<typeof scanFileLines>[1]>[0],
	state: UnsyncedScanState,
	eventLimit: number | undefined,
): boolean | void {
	if (!line.nonEmpty) {
		state.newOffset = line.nextOffset;
		return;
	}
	if (line.oversized) {
		throw new RangeError(
			`activity JSONL row at byte ${line.start} exceeds ${MAX_CAPTURED_JSONL_LINE_BYTES} bytes; cursor was not advanced`,
		);
	}
	if (line.text === undefined) return;
	let event: LocalActivityEvent | null;
	try {
		event = parseLocalActivityEvent(JSON.parse(line.text));
	} catch {
		state.newOffset = line.nextOffset;
		return;
	}
	if (event === null) {
		state.newOffset = line.nextOffset;
		return;
	}
	const lineBytes = line.nextOffset - line.start;
	if (state.retainedBytes + lineBytes > MAX_SYNC_PAGE_BYTES) return false;
	state.events.push(event);
	state.retainedBytes += lineBytes;
	state.newOffset = line.nextOffset;
	return eventLimit !== undefined && state.events.length >= eventLimit ? false : undefined;
}

function assertPageIdentity(path: string, expected: FileIdentity): void {
	if (!sameFileIdentity(fileIdentity(path), expected)) {
		throw new SyncCursorInvalidatedError("activity log was replaced during page read");
	}
}

/**
 * Read unsynced events from the JSONL log (from byte offset to EOF).
 */
export function getUnsyncedEvents(
	limit?: number,
	cwd?: string,
	range: UnsyncedReadRange = {},
): UnsyncedEvents {
	const activityPath = getActivityPath(cwd);
	const syncState = readSyncState(cwd);
	if (!existsSync(activityPath)) {
		assertActivitySyncCursor(range.startOffset ?? syncState.synced_through_bytes, 0);
		return { events: [], newOffset: 0 };
	}

	const beforeIdentity = fileIdentity(activityPath);
	if (range.expectedIdentity) assertPageIdentity(activityPath, range.expectedIdentity);
	const fileSize = statSync(activityPath).size;
	const { startOffset, endExclusive } = boundedReadRange(
		fileSize,
		syncState.synced_through_bytes,
		range,
	);

	if (startOffset >= endExclusive) {
		return { events: [], newOffset: endExclusive };
	}

	// Parse one bounded line at a time. The old offset→EOF Buffer followed by a
	// single `.toString("utf-8")` failed once the pending suffix crossed V8's
	// string ceiling. Malformed rows within the line ceiling are consumed;
	// oversized rows fail explicitly and leave their starting cursor pending.
	const eventLimit = limit && limit > 0 ? limit : undefined;
	const state: UnsyncedScanState = { events: [], newOffset: startOffset, retainedBytes: 0 };
	scanFileLines(
		activityPath,
		(line) => consumeUnsyncedLine(line, state, eventLimit),
		{
			startOffset,
			endExclusive,
			maxCapturedLineBytes: MAX_CAPTURED_JSONL_LINE_BYTES,
			// A newline is the append-only writer's commit marker. Keep a partial
			// trailing row pending until a later append terminates it.
			includeFinalLine: false,
		},
	);
	assertPageIdentity(activityPath, beforeIdentity);

	return { events: state.events, newOffset: state.newOffset };
}
