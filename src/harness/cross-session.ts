// Cross-session activity-log reader. Used by sequence detectors that need
// to look across session boundaries — e.g., `stale_read_then_write`
// (§3.4) and `file_overwrite_after_other_agent` (§3.10) check whether
// *other* agents have touched a file this workspace.
//
// Bounded I/O: only the trailing N events of `.interlinked/activity.jsonl`
// are loaded, and the result is cached per Stop turn so multiple detectors
// share the read cost.

import { statSync } from "node:fs";
import { join } from "node:path";

import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import type { LocalActivityEvent } from "../lib/local-activity-types.js";
import {
	parseLocalActivityEvent,
	readRecentLines,
} from "../lib/local-activity-collection.js";

/** Dual cap for each tail scan. The byte ceiling is the hard memory/I/O bound;
 * the row ceiling keeps parsing and detector work bounded within that window. */
const MAX_TRAILING_EVENTS = 500;
const MAX_TRAILING_BYTES = 4 * 1024 * 1024;

/** Narrow projection shared by the legacy HarnessEvent-shaped fixtures and
 * the v5 LocalActivityEvent rows that activity.jsonl actually contains. */
export interface WorkspaceActivityEvent {
	timestamp: string;
	agent_name?: string;
	tool_name?: string;
	tool_input?: JsonObject;
	session_id?: string;
	hook_event?: string;
	cwd?: string;
}

interface CacheEntry {
	mtime: number;
	since: string;
	events: WorkspaceActivityEvent[];
}

const CACHE_MAX_ENTRIES = 16;
const cache = new Map<string, CacheEntry>();

function cacheKey(cwd: string, since: string): string {
	return `${cwd}::${since}`;
}

function pruneCache(): void {
	if (cache.size <= CACHE_MAX_ENTRIES) return;
	const toDrop = cache.size - CACHE_MAX_ENTRIES;
	let dropped = 0;
	for (const key of cache.keys()) {
		if (dropped >= toDrop) break;
		cache.delete(key);
		dropped++;
	}
}

/**
 * Load the trailing N events from `.interlinked/activity.jsonl` for the
 * given working tree, optionally filtering to events at or after a
 * given ISO timestamp.
 *
 * Best-effort: if the file doesn't exist or is malformed, returns `[]`
 * (per `[[feedback_safety_continuity]]` — fail-open on observability
 * infrastructure).
 *
 * @param cwd Project root (the dir containing `.interlinked/`)
 * @param sinceTimestamp Optional ISO timestamp; events with `timestamp <`
 *   this are filtered out
 */
export function loadRecentWorkspaceEvents(
	cwd: string,
	sinceTimestamp: string = "",
): WorkspaceActivityEvent[] {
	const logPath = join(cwd, ".interlinked", "activity.jsonl");
	let mtime: number;
	try {
		mtime = statSync(logPath).mtimeMs;
	} catch {
		return [];
	}

	const key = cacheKey(cwd, sinceTimestamp);
	const cached = cache.get(key);
	if (cached && cached.mtime === mtime) {
		cache.delete(key);
		cache.set(key, cached);
		return cached.events;
	}

	let lines: string[];
	try {
		// readRecentLines scans backward in fixed-size chunks and returns
		// newest-first. Reverse the bounded result to preserve this reader's
		// established chronological ordering without ever loading the full log.
		lines = readRecentLines(logPath, MAX_TRAILING_EVENTS, MAX_TRAILING_BYTES).reverse();
	} catch {
		return [];
	}

	const events: WorkspaceActivityEvent[] = [];
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // malformed line — best-effort, skip silently
		}
		if (!isJsonObject(parsed)) continue;
		const event = normalizeActivityEvent(parsed, cwd);
		if (!event) continue;
		if (sinceTimestamp && event.timestamp < sinceTimestamp) continue;
		events.push(event);
	}

	cache.set(key, { mtime, since: sinceTimestamp, events });
	pruneCache();
	return events;
}

function stringField(record: JsonObject, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function normalizeActivityEvent(record: JsonObject, cwd: string): WorkspaceActivityEvent | null {
	const local = parseLocalActivityEvent(record);
	const timestamp = stringField(record, "timestamp") ?? local?.ts;
	if (!timestamp) return null;
	const event: WorkspaceActivityEvent = {
		timestamp,
		cwd: typeof record.cwd === "string" ? record.cwd : cwd,
	};
	applyOptionalActivityFields(event, record, local);
	return event;
}

/** Inferred hook-event kind from a legacy-shaped record, used only when no
 * explicit `hook_event`/`local.hook` field is present. */
function resolveHookEvent(record: JsonObject, local: LocalActivityEvent | null): string | undefined {
	const explicitHook = stringField(record, "hook_event") ?? local?.hook ?? undefined;
	const inferredHook =
		record.type === "tool_use_start"
			? "PreToolUse"
			: record.type === "tool_use"
				? "PostToolUse"
				: undefined;
	return explicitHook ?? inferredHook;
}

/** Resolves and assigns every optional field on `event`, mutating it in
 * place. Split out of `normalizeActivityEvent` to keep the required-field
 * path (timestamp resolution + the early null return) separately readable. */
function applyOptionalActivityFields(
	event: WorkspaceActivityEvent,
	record: JsonObject,
	local: LocalActivityEvent | null,
): void {
	const agentName = stringField(record, "agent_name") ?? local?.agent;
	const toolName = stringField(record, "tool_name") ?? local?.tool ?? undefined;
	const sessionId = stringField(record, "session_id") ?? local?.session ?? undefined;
	const hookEvent = resolveHookEvent(record, local);
	if (agentName) event.agent_name = agentName;
	if (toolName) event.tool_name = toolName;
	if (isJsonObject(record.tool_input)) event.tool_input = record.tool_input;
	if (sessionId) event.session_id = sessionId;
	if (hookEvent) event.hook_event = hookEvent;
}

/** Test helper — drop all cached entries. Exported only for vitest. */
export function _clearCrossSessionCache(): void {
	cache.clear();
}
