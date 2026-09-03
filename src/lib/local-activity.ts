// ===========================================
// Local Activity — JSONL log, session state, sync
// ===========================================
// Zero external dependencies. Provides local-first activity storage
// so CLI commands work offline and can sync later.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
	countNonEmptyFileLines,
	MAX_CAPTURED_JSONL_LINE_BYTES,
	readFirstNonEmptyFileLine,
} from "./bounded-file-io.js";
import { buildCollectionRecord, PRE_EVENT_TYPES, TOOL_EVENT_TYPES } from "./collection/builder.js";
import { appendCollection, getCollectionPath } from "./collection/writer.js";
import { isJsonObject } from "./json-types.js";
import { appendFileWithMutationLock } from "./file-mutation-lock.js";
import {
	countJsonlLines,
	parseLocalActivityEvent,
	readCollectionActivity,
	readRecentLines,
} from "./local-activity-collection.js";
import {
	getActivityPath,
	getRealtimeRetryPath,
	getSessionsDir,
	getSyncErrorsPath,
} from "./local-activity-paths.js";
import { readSyncState } from "./local-activity-sync.js";
import { nonNull } from "./non-null.js";
import { readBoundedLocalSessions } from "./local-session-reader.js";

// Re-exported for back-compat call sites that import these from local-activity.js.
export { mergeAndDedup } from "./local-activity-merge.js";
export {
	appendSyncError,
	assertActivitySyncCursor,
	captureActivitySyncBasis,
	checkpointSyncState,
	getUnsyncedEvents,
	readSyncState,
	type ActivitySyncBasis,
	SyncCursorInvalidatedError,
	type UnsyncedEvents,
	updateSyncState,
} from "./local-activity-sync.js";

// ===========================================
// Types
// ===========================================
// All type/interface definitions live in `local-activity-types.ts` (extracted to
// keep this module under the per-file line cap). The ones used in this module's
// own signatures are imported here; every previously-exported type is re-exported
// so existing `import { ... } from "./local-activity.js"` call sites are unchanged.
import type {
	LocalActivityEvent,
	LocalStats,
	SessionState,
	SyncDiagnostics,
} from "./local-activity-types.js";

export type {
	AgentContribution,
	CodeEdit,
	CommitAttribution,
	EventAttribution,
	LastSyncSummary,
	LocalActivityEvent,
	LocalStats,
	SessionState,
	SubagentState,
	SyncDiagnostics,
	TokenUsage,
} from "./local-activity-types.js";

// ===========================================
// JSONL Write
// ===========================================

/**
 * Append a single activity event to the local JSONL log.
 * Synchronous (~0.1ms) — safe to call from hook scripts.
 */
/**
 * Append a single activity event to activity.jsonl ONLY — no collection.jsonl
 * mirror. Used by the daemon's legacy-stream dual-write, which writes the
 * canonical collection.jsonl via its own path (server/collection-writer.ts) and
 * must not double-write it here.
 */
export function appendActivityRecordOnly(event: LocalActivityEvent, cwd?: string): void {
	const resolvedCwd = cwd || process.cwd();
	const activityPath = getActivityPath(resolvedCwd);
	const dir = dirname(activityPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	appendFileWithMutationLock(activityPath, `${JSON.stringify(event)}\n`);
}

export function appendLocalActivity(event: LocalActivityEvent, cwd?: string): void {
	const resolvedCwd = cwd || process.cwd();
	appendActivityRecordOnly(event, resolvedCwd);

	const collectionRecord = buildCollectionRecord({ ...event });
	if (collectionRecord) {
		appendCollection(collectionRecord, resolvedCwd);
	}
}

// ===========================================
// JSONL Read
// ===========================================

/** Activity types that collection.jsonl covers — the EXACT set the collection builder
 *  consumes (imported, not mirrored: a hand-copied set drifted and `permission_request`
 *  came back twice, once projected + once raw — finding 2026-06). Every OTHER type
 *  (session_start, prompt, notification, token, duration, …) lives only in the
 *  full-fidelity activity.jsonl stream and is restored from it. */
const COLLECTION_BACKED_TYPES: ReadonlySet<string> = TOOL_EVENT_TYPES;

interface ReadActivityOpts {
	since?: number | undefined; // ms cutoff timestamp
	agent?: string | undefined;
	limit?: number | undefined;
	type?: string | undefined;
	cwd?: string | undefined;
}

/** One parsed activity line's disposition: a kept event, a signal to stop
 *  scanning (lines are newest -> oldest, so `since` cutoff makes every
 *  remaining line stale too), or `null` to skip this line and keep going
 *  (malformed JSON, or filtered out by agent/type). */
type ActivityLineResult = { event: LocalActivityEvent } | { stop: true } | null;

/** Parse + filter one activity.jsonl line against the read options. Pulled out
 *  of `readActivityStream`'s loop body so the loop itself stays flat. */
function parseActivityLine(line: string, opts: ReadActivityOpts | undefined): ActivityLineResult {
	try {
		const event = parseLocalActivityEvent(JSON.parse(line));
		if (!event) return null;
		if (opts?.since && new Date(event.ts).getTime() < opts.since) {
			return { stop: true };
		}
		if (opts?.agent && event.agent !== opts.agent) {
			return null;
		}
		if (opts?.type && event.type !== opts.type) {
			return null;
		}
		return { event };
	} catch (_err) {
		/* intentional: skip malformed JSONL lines to keep log readable */
		return null;
	}
}

/** Read + filter the legacy full-fidelity activity.jsonl stream (ALL event types). */
function readActivityStream(opts?: ReadActivityOpts): LocalActivityEvent[] {
	const path = getActivityPath(opts?.cwd);
	if (!existsSync(path)) return [];

	const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
	const scanLineBudget = limit ? Math.max(limit * 20, 500) : 10000;
	const lines = readRecentLines(path, scanLineBudget);
	const events: LocalActivityEvent[] = [];

	for (const line of lines) {
		const result = parseActivityLine(line, opts);
		if (!result) continue;
		if ("stop" in result) break;
		events.push(result.event);
		if (limit && events.length >= limit) {
			break;
		}
	}

	return events;
}

/** A raw activity `type` as the collection reader PROJECTS it: every pre-phase
 *  type (notably `permission_request`) reads back as `tool_use_start`. Keying
 *  identity on the projected type is what lets a raw `permission_request` row
 *  match its collection twin across the type mapping. Idempotent on
 *  already-projected types. */
function projectedType(rawType: string): string {
	return PRE_EVENT_TYPES.has(rawType) ? "tool_use_start" : rawType;
}

/**
 * Identity of a tool event for deduplicating across the two stores (the
 * canonical collection.jsonl projection vs its legacy activity.jsonl twin):
 *   - `idKey` — `tool_use_id` + the projected `type` (pre/post phases of one
 *     call share the id but differ in type). Null when the event carries no id.
 *   - `fieldKey` — timestamp + session + projected type + tool; both records
 *     are built from the same hook payload, so these agree for a dual-written
 *     pair.
 * An event WITH a tool_use_id is identified by the id ALONE — two parallel
 * calls can legitimately share the same millisecond timestamp, session, type,
 * and tool while having DIFFERENT ids, and the field fallback would collapse
 * them (finding 2026-06: one legacy event was dropped as a supposed twin).
 * The field key is the identity only for id-less events (older writers).
 */
function toolEventIdentity(e: LocalActivityEvent): { idKey: string | null; fieldKey: string } {
	const type = projectedType(e.type);
	return {
		idKey: e.tool_use_id ? `id:${e.tool_use_id}|${type}` : null,
		fieldKey: `f:${e.ts}|${e.session ?? ""}|${type}|${e.tool ?? ""}`,
	};
}

/**
 * Read and filter local activity events. MERGES both stores so no event is lost
 * (finding 11): the enriched TOOL events come from the canonical collection.jsonl
 * projection, while every NON-tool event (session_start / prompt / notification /
 * token / duration) is restored from the full-fidelity activity.jsonl — which the
 * collection projection drops. When collection.jsonl is absent (older installs / the
 * daemon never ran), activity.jsonl is the whole story.
 *
 * Tool events dedup by EVENT IDENTITY, not by type (finding 2026-06): dropping
 * every collection-backed TYPE from activity.jsonl also erased (a) history from
 * before the collection stream existed and (b) events whose collection append
 * failed — both live ONLY in activity.jsonl and vanished from activity/status
 * output despite remaining on disk. A legacy tool event is dropped only when its
 * canonical twin is actually present in the collection read.
 */
export function readLocalActivity(opts?: ReadActivityOpts): LocalActivityEvent[] {
	const cwd = opts?.cwd ?? process.cwd();
	const activityEvents = readActivityStream(opts);
	if (!existsSync(getCollectionPath(cwd))) return activityEvents;

	// Each source is already newest-first and pre-limited, so the global newest N
	// is within their union — dedup, merge, re-sort, re-limit.
	const collectionEvents = readCollectionActivity(opts);
	const canonicalIds = new Set<string>();
	const canonicalFields = new Set<string>();
	for (const e of collectionEvents) {
		const id = toolEventIdentity(e);
		if (id.idKey) canonicalIds.add(id.idKey);
		canonicalFields.add(id.fieldKey);
	}
	// A legacy tool event WITH a tool_use_id is a twin only on an ID match — the
	// field fallback applies solely to id-less events, so two parallel same-ms
	// calls with distinct ids both survive (finding 2026-06).
	const legacy = activityEvents.filter((e) => {
		if (!COLLECTION_BACKED_TYPES.has(e.type)) return true;
		const id = toolEventIdentity(e);
		return id.idKey ? !canonicalIds.has(id.idKey) : !canonicalFields.has(id.fieldKey);
	});
	const merged = [...collectionEvents, ...legacy];
	merged.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
	const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
	return limit ? merged.slice(0, limit) : merged;
}

// ===========================================
// Session State
// ===========================================

/**
 * Read all session state files.
 */
export function readLocalSessions(cwd?: string): SessionState[] {
	return readBoundedLocalSessions(getSessionsDir(cwd));
}

// ===========================================
// Stats
// ===========================================

/**
 * Get summary stats about local activity.
 */
export function getLocalStats(cwd?: string): LocalStats {
	const path = getActivityPath(cwd);
	if (!existsSync(path)) {
		return { total_events: 0, file_size_bytes: 0, pending_sync: 0 };
	}

	const fileSize = statSync(path).size;
	const syncState = readSyncState(cwd);
	const pendingBytes = Math.max(0, fileSize - syncState.synced_through_bytes);

	// Count the file in fixed-size chunks. The previous readFileSync(..., "utf-8")
	// failed above V8's ~512MB string ceiling and then claimed `pending_sync: 0`,
	// which made status and sync report a large unreadable backlog as up to date.
	// Read failures now propagate to the command boundary instead of fabricating
	// zero; large healthy logs stay exact with bounded memory.
	const totalEvents = countNonEmptyFileLines(path);
	const firstLine = readFirstNonEmptyFileLine(path);
	const [lastLine] = readRecentLines(path, 1, MAX_CAPTURED_JSONL_LINE_BYTES);

	let oldest: string | undefined;
	let newest: string | undefined;
	if (firstLine !== undefined) {
		try {
			oldest = JSON.parse(firstLine).ts;
		} catch (_err) {
			/* intentional: first line unparseable — leave oldest undefined */
		}
	}
	if (lastLine !== undefined) {
		try {
			newest = JSON.parse(lastLine).ts;
		} catch (_err) {
			/* intentional: last line unparseable — leave newest undefined */
		}
	}

	// Estimate pending event count from pending bytes ratio
	const pendingSyncEstimate =
		pendingBytes > 0 && totalEvents > 0 && fileSize > 0
			? Math.max(1, Math.round((pendingBytes / fileSize) * totalEvents))
			: 0;

	return {
		total_events: totalEvents,
		file_size_bytes: fileSize,
		pending_sync: pendingSyncEstimate,
		oldest_event: oldest,
		newest_event: newest,
	};
}

/** Parse one sync-errors.jsonl line. Replaces
 *  `JSON.parse(...) as { ts?: string; message?: string }` — both fields were
 *  already declared optional, so the cast asserted nothing a validator could
 *  meaningfully tighten; this just makes the shape check real. */
function parseSyncErrorEntry(value: unknown): { ts?: string; message?: string } | null {
	if (!isJsonObject(value)) return null;
	const { ts, message } = value;
	return {
		...(typeof ts === "string" ? { ts } : {}),
		...(typeof message === "string" ? { message } : {}),
	};
}

/**
 * Return sync health details for status/reporting.
 */
export function getSyncDiagnostics(cwd?: string): SyncDiagnostics {
	const syncState = readSyncState(cwd);
	const pendingRealtimeRetry = countJsonlLines(getRealtimeRetryPath(cwd));

	const errorPath = getSyncErrorsPath(cwd);
	const errorLines = existsSync(errorPath) ? readRecentLines(errorPath, 5000) : [];
	const syncErrorCount = errorLines.length;

	let lastSyncErrorAt: string | undefined;
	let lastSyncError: string | undefined;
	if (syncErrorCount > 0) {
		try {
			const parsed = parseSyncErrorEntry(JSON.parse(nonNull(errorLines[0])));
			lastSyncErrorAt = parsed?.ts;
			lastSyncError = parsed?.message;
		} catch (_err) {
			/* intentional: malformed sync-error line — keep diagnostics best-effort */
		}
	}

	return {
		pending_realtime_retry: pendingRealtimeRetry,
		sync_error_count: syncErrorCount,
		last_sync_success_at: syncState.last_sync_at || undefined,
		last_sync_error_at: lastSyncErrorAt,
		last_sync_error: lastSyncError,
	};
}
