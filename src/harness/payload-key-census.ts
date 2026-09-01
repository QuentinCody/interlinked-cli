// ===========================================
// Hook-payload key census — what the runner sends vs what we consume
// ===========================================
// The adapter keeps every runner payload field on `UnifiedHookEvent.raw`, but
// the conversion to the harness event copies a FIXED whitelist of keys. Any
// field a runner adds later — a new correlation id, per-subagent usage, a
// parent-call pointer — is therefore dropped silently, and the only way to
// notice is to go read a vendor binary. That is exactly how the subagent
// token/label gaps went unseen for months.
//
// This module closes the loop: every hook invocation compares the payload's
// top-level keys against the set the pipeline actually reads and records any
// leftovers to `.interlinked/payload-keys.json`. The file is a small,
// append-only-in-spirit census — one entry per runner + native event, listing
// the unconsumed keys with a first/last-seen stamp. When a runner starts
// sending something new, it shows up there instead of nowhere.
//
// Hot path, so: one small read + a write ONLY when a key is new. Fail-open —
// a census hiccup must never affect the hook's decision.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

/** Top-level payload keys the pipeline already consumes somewhere (adapter,
 *  legacy conversion, normalizers, or the writers). A key listed here is
 *  captured; anything else is reported as unconsumed. Keep in sync when a new
 *  field starts being read — an over-broad list silently re-hides a gap. */
export const CONSUMED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
	// envelope
	"session_id",
	"sessionId",
	"cwd",
	"transcript_path",
	"transcriptPath",
	"hook_event_name",
	"permission_mode",
	"model",
	"agent_name",
	"cli_version",
	"claude_code_version",
	// tool events
	"tool_name",
	"toolName",
	"name",
	"tool_input",
	"toolInput",
	"tool_response",
	"toolResponse",
	"tool_use_id",
	"parent_tool_use_id",
	"error",
	"tool_error",
	"message",
	"is_interrupt",
	"duration_ms",
	"durationMs",
	// prompts / stop
	"prompt",
	"user_prompt",
	"userPrompt",
	"stop_hook_active",
	"stop_reason",
	"last_assistant_message",
	"usage",
	"token_usage",
	"reason",
	"source",
	// Turn context + background roster — wired 2026-08-08 after this very
	// census reported them (activity-writer.ts, background-task-log.ts).
	"prompt_id",
	"effort",
	"background_tasks",
	"available_tools",
	// subagent / task lifecycle
	"agent_id",
	"agent_type",
	"agent_transcript_path",
	"parent_agent",
	"parent_agent_name",
	"parent_session_id",
	"subagent_id",
	"subagent_type",
	"task_id",
	"task_subject",
	"task_description",
	"teammate_name",
	"team_name",
	// notifications / compaction
	"notification_type",
	"title",
	"trigger",
	"custom_instructions",
	"files_modified",
	// OpenCode v2 plugin / adapter payload aliases
	"sessionID",
	"callID",
	"tool",
	"args",
	"input",
	"output",
	"filePath",
	"oldString",
	"newString",
	"replaceAll",
	"workdir",
	"include",
	"agent",
]);

/** One census entry: the unconsumed keys seen for a runner + native event,
 *  plus each one's SHAPE. The shape is what makes the census actionable — a
 *  bare key name ("background_tasks") does not tell you what to capture, while
 *  `array<object{id,status,description}>` does. Shapes record TYPE and MEMBER
 *  NAMES only, never values: this file is written on the hook path from live
 *  payloads, so it must not become a second copy of the data. */
export interface PayloadKeyEntry {
	unconsumed: string[];
	shapes?: Record<string, string>;
	first_seen: string;
	last_seen: string;
}

export interface PayloadKeyCensus {
	schema: "payload-keys.v1";
	entries: Record<string, PayloadKeyEntry>;
}

/** Census path for a repo. Exported so tests and `interlinked query` agree. */
export function censusPath(cwd: string): string {
	return join(cwd, ".interlinked", "payload-keys.json");
}

function emptyCensus(): PayloadKeyCensus {
	return { schema: "payload-keys.v1", entries: {} };
}

/**
 * Narrow one parsed census entry. NOTE the boundary this draws: the entry's
 * OWN fields (`unconsumed`, `first_seen`, `last_seen`) have a fixed shape we
 * control (we wrote them), so they're validated field-by-field like any
 * other self-written baseline. `shapes` is keyed by the runner PAYLOAD's own
 * field names — genuinely arbitrary, by this module's whole purpose — so
 * only its VALUE type (always a shape-description string) is checked; the
 * key names themselves are deliberately left unconstrained.
 */
function parsePayloadKeyEntry(value: unknown): PayloadKeyEntry | null {
	if (!isJsonObject(value)) return null;
	const { unconsumed, shapes, first_seen, last_seen } = value;
	if (!Array.isArray(unconsumed) || !unconsumed.every((k): k is string => typeof k === "string")) {
		return null;
	}
	if (typeof first_seen !== "string") return null;
	if (typeof last_seen !== "string") return null;
	if (shapes === undefined) {
		return { unconsumed, first_seen, last_seen };
	}
	if (!isJsonObject(shapes)) return null;
	const parsedShapes: Record<string, string> = {};
	for (const [key, shape] of Object.entries(shapes)) {
		if (typeof shape !== "string") return null;
		parsedShapes[key] = shape;
	}
	// `exactOptionalPropertyTypes` is on: `shapes?: T` means the key is either
	// `T` or ABSENT, never `undefined` explicitly — so the two return shapes
	// above must be separate object literals, not one with `shapes: T |
	// undefined`.
	return { unconsumed, shapes: parsedShapes, first_seen, last_seen };
}

/** Narrow a parsed `payload-keys.json`. A malformed individual entry (one
 *  runner+event) is dropped rather than discarding the whole census — this
 *  file is best-effort analytics, not a gate, so losing one entry to a
 *  hand-edit is preferable to losing every entry over it. */
function parsePayloadKeyCensus(value: unknown): PayloadKeyCensus | null {
	if (!isJsonObject(value)) return null;
	if (!isJsonObject(value.entries)) return null;
	const entries: Record<string, PayloadKeyEntry> = {};
	for (const [key, raw] of Object.entries(value.entries)) {
		const entry = parsePayloadKeyEntry(raw);
		if (entry) entries[key] = entry;
	}
	return { schema: "payload-keys.v1", entries };
}

/** Read the census; a missing / corrupt file reads as empty. */
export function loadCensus(cwd: string): PayloadKeyCensus {
	try {
		const path = censusPath(cwd);
		if (!existsSync(path)) return emptyCensus();
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parsePayloadKeyCensus(parsed) ?? emptyCensus();
	} catch (err) {
		void err; // unreadable census — start fresh rather than fail the hook
		return emptyCensus();
	}
}

/** The payload keys the pipeline does not consume, sorted for stable output. */
export function unconsumedKeys(raw: JsonObject): string[] {
	return Object.keys(raw)
		.filter((key) => !CONSUMED_PAYLOAD_KEYS.has(key))
		.sort();
}

/** Cap on member names recorded per object shape — enough to identify the
 *  field, short enough that a wide object can't bloat the census. */
export const MAX_SHAPE_MEMBERS = 12;

/** A value's TYPE and member NAMES — never its values. Arrays describe their
 *  first element, so `[{id, status}]` reads as `array<object{id,status}>`. */
export function describeShape(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return value.length === 0 ? "array<empty>" : `array<${describeShape(value[0])}>`;
	}
	if (typeof value !== "object") return typeof value;
	// SAFETY: narrowed to a non-null, non-array object above; only keys are read.
	const keys = Object.keys(value as Record<string, unknown>);
	const shown = keys.slice(0, MAX_SHAPE_MEMBERS).join(",");
	const more = keys.length > MAX_SHAPE_MEMBERS ? ",…" : "";
	return `object{${shown}${more}}`;
}

/** Shapes for the given keys of a payload. */
export function describeShapes(raw: JsonObject, keys: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of keys) out[key] = describeShape(raw[key]);
	return out;
}

/** One census observation: which runner+event was seen, with what leftovers. */
export interface PayloadObservation {
	/** Census key, `"<runner>/<nativeEvent>"`. */
	key: string;
	/** Unconsumed top-level payload keys seen on this invocation. */
	keys: string[];
	/** Type + member-name shape per key (no values). */
	shapes?: Record<string, string>;
	/** ISO timestamp to stamp the entry with. */
	now: string;
}

/** A merge outcome: the next census and whether it differs from the input. */
export interface CensusMerge {
	census: PayloadKeyCensus;
	changed: boolean;
}

/** Merge one observation into a census. Pure — returns the next census plus
 *  whether anything changed, so the caller only writes when it must. */
export function mergeObservation(
	census: PayloadKeyCensus,
	{ key, keys, shapes, now }: PayloadObservation,
): CensusMerge {
	const existing = census.entries[key];
	const seen = shapes ?? {};
	if (!existing) {
		if (keys.length === 0) return { census, changed: false };
		const entry: PayloadKeyEntry = { unconsumed: keys, shapes: seen, first_seen: now, last_seen: now };
		return { census: withEntry(census, key, entry), changed: true };
	}
	// Prune keys that have since been WIRED UP. Without this the census keeps
	// reporting a field forever after someone captured it, and a report that
	// lists solved problems stops being read.
	const kept = existing.unconsumed.filter((k) => !CONSUMED_PAYLOAD_KEYS.has(k));
	const merged = [...new Set([...kept, ...keys])].sort();
	const mergedShapes: Record<string, string> = {};
	for (const k of merged) {
		const shape = seen[k] ?? existing.shapes?.[k];
		if (shape) mergedShapes[k] = shape;
	}
	const entry: PayloadKeyEntry = {
		unconsumed: merged,
		shapes: mergedShapes,
		first_seen: existing.first_seen,
		last_seen: now,
	};
	const unchanged =
		JSON.stringify({ ...entry, last_seen: existing.last_seen }) === JSON.stringify(existing);
	return unchanged ? { census, changed: false } : { census: withEntry(census, key, entry), changed: true };
}

/** A census with one entry replaced. */
function withEntry(census: PayloadKeyCensus, key: string, entry: PayloadKeyEntry): PayloadKeyCensus {
	return { schema: "payload-keys.v1", entries: { ...census.entries, [key]: entry } };
}

/** Inputs for one census recording. `now` is injected so the write is
 *  deterministic under test. */
export interface RecordPayloadKeysArgs {
	runner: string;
	nativeEvent: string;
	raw: unknown;
	cwd: string;
	now?: string;
}

/**
 * Record one hook payload's unconsumed top-level keys. Writes only when a key
 * is new for this runner + event, so the steady state is a single small read.
 * Fail-open by contract: never throws, never affects the hook decision.
 */
export function recordPayloadKeys(args: RecordPayloadKeysArgs): void {
	try {
		const { raw, cwd } = args;
		if (!isJsonObject(raw)) return;
		const keys = unconsumedKeys(raw);
		// NOTE: no early return on an empty key list. A payload with nothing
		// unconsumed is exactly the case that must still reach the merge, so a
		// PREVIOUSLY reported key that has since been wired up gets pruned.
		// loadCensus short-circuits on a missing file, so the common
		// nothing-to-report path stays a single existsSync.
		const observation: PayloadObservation = {
			key: `${args.runner}/${args.nativeEvent}`,
			keys,
			shapes: describeShapes(raw, keys),
			now: args.now ?? new Date().toISOString(),
		};
		const next = mergeObservation(loadCensus(cwd), observation);
		if (!next.changed) return;
		const path = censusPath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(next.census, null, 2)}\n`);
	} catch (err) {
		void err; // census is best-effort — never break the hook pipeline
	}
}
