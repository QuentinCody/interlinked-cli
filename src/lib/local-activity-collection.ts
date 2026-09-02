// interlinked-tdd: exempt
// ===========================================
// Local Activity — collection-stream reader + low-level JSONL helpers
// ===========================================
// Extracted from local-activity.ts to keep that module under the per-file
// line cap. Pure leaf cluster: depends only on node:fs/path, collection
// types/path, and the LocalActivityEvent type — never imports back from main.

import { existsSync } from "node:fs";
import { countNonEmptyFileLines } from "./bounded-file-io.js";
import type { AgentEventName } from "./collection/types.js";
import { getCollectionPath } from "./collection/writer.js";
import { isJsonObject, type JsonObject } from "./json-types.js";
import type { EventAttribution, LocalActivityEvent, TokenUsage } from "./local-activity-types.js";
import { readRecentLines } from "./reverse-line-reader.js";

export { readRecentLines };

/** Best human label for a collection action: command / path / pattern / url.
 *  Takes the validated-but-unvalidated-shape `action` field straight from
 *  `parseCollectionRecordUsed` — `CollectionAction` (`collection/types.ts`) is
 *  a 10-variant union with no runtime discriminant, and every field this
 *  function reads is opportunistic best-effort, so the boundary parser only
 *  confirms "object or null" and leaves the per-variant shape unchecked. */
function summarizeAction(action: JsonObject | null | undefined): string | null {
	if (!action) return null;
	const a = action as {
		command?: unknown;
		path?: unknown;
		pattern?: unknown;
		url?: unknown;
		task?: unknown;
		tool?: unknown;
	};
	const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
	return (
		str(a.command) ??
		str(a.path) ??
		str(a.pattern) ??
		str(a.url) ??
		str(a.task) ??
		str(a.tool) ??
		null
	);
}

/** Display-summary cap for an agent's final message in the activity view.
 *  The FULL message stays on the collection record; this only bounds the
 *  one-line `summary` column. */
const AGENT_SUMMARY_MAX_CHARS = 200;

/** Hook-event label for each agent_event, for the display `hook` column. */
const AGENT_EVENT_HOOKS: Record<AgentEventName, string> = {
	subagent_start: "SubagentStart",
	subagent_stop: "SubagentStop",
	task_completed: "TaskCompleted",
};

// ---------------------------------------------------------------------------
// Boundary parsing — collection.jsonl (see CAMPAIGN-boundary-parsers.md).
// `CollectionRecord`/`AgentEventRecord` (collection/types.ts) are the full
// on-disk schemas (~30 fields apiece); the two interfaces below are the USED
// PROJECTION — only what collectionToActivity/agentEventToActivity read.
// Fields reached through `??`/`===`/a truthy guard/a function call tolerate
// an absent key and stay optional; fields assigned UNCONDITIONALLY into an
// optional LocalActivityEvent column (`tool: rec.provider_tool`, `session:
// rec.session_id`, `tool: rec.agent_type`) must never read as `undefined`
// (exactOptionalPropertyTypes forbids writing that into an optional target),
// so those three stay required keys that normalize an absent/malformed
// source to `null` — already a legitimate value for each of them. Real rows
// back the leniency: the hand-written hook runtime
// (hook-template-chunks/collection-writer.ts) omits `agent_name` on ~88% of
// tool_event rows (measured against the live collection.jsonl tail) that the
// TS-typed builder (collection/builder.ts) always sets — two writers drifted,
// and `?? `-based consumption already treats absent the same as `null`.

interface CollectionRecordUsed {
	ts: string;
	provider_tool: string | null;
	session_id: string | null;
	phase?: "pre" | "post";
	outcome?: "ok" | "error";
	agent_name?: string | null;
	provider?: string;
	action?: JsonObject | null;
	cwd?: string | null;
	tool_use_id?: string | null;
}

interface AgentEventRecordUsed {
	ts: string;
	event: AgentEventName;
	agent_type: string | null;
	session_id: string | null;
	agent_name?: string | null;
	provider?: string;
	subagent_id?: string | null;
	parent_agent?: string | null;
	agent_transcript_path?: string | null;
	last_assistant_message?: string | null;
	cwd?: string | null;
	task?: { task_subject?: string | null } | null;
}

/** `string | null`, tolerating an absent or wrongly-typed key by OMITTING the
 *  field (returns undefined) rather than rejecting the whole record. */
function optionalStringOrNull(v: unknown): string | null | undefined {
	if (v === null) return null;
	return typeof v === "string" ? v : undefined;
}

/** Same shape, but for a field an UNGUARDED downstream assignment depends on
 *  being present — an absent or wrongly-typed key normalizes to `null`
 *  (already a legitimate value for these fields) instead of vanishing. */
function requiredStringOrNull(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function parseCollectionRecordUsed(value: JsonObject, ts: string): CollectionRecordUsed {
	const phase = value.phase === "pre" || value.phase === "post" ? value.phase : undefined;
	const outcome = value.outcome === "ok" || value.outcome === "error" ? value.outcome : undefined;
	const agent_name = optionalStringOrNull(value.agent_name);
	const provider = typeof value.provider === "string" ? value.provider : undefined;
	const action =
		value.action === null ? null : isJsonObject(value.action) ? value.action : undefined;
	const cwd = optionalStringOrNull(value.cwd);
	const tool_use_id = optionalStringOrNull(value.tool_use_id);
	return {
		ts,
		provider_tool: requiredStringOrNull(value.provider_tool),
		session_id: requiredStringOrNull(value.session_id),
		...(phase !== undefined ? { phase } : {}),
		...(outcome !== undefined ? { outcome } : {}),
		...(agent_name !== undefined ? { agent_name } : {}),
		...(provider !== undefined ? { provider } : {}),
		...(action !== undefined ? { action } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		...(tool_use_id !== undefined ? { tool_use_id } : {}),
	};
}

/** `task`'s only consumed member is `task_subject` (`agentEventToActivity`
 *  reads `rec.task?.task_subject`) — absent/non-object task normalizes like
 *  every other field here rather than rejecting the record. */
function parseAgentEventTask(v: unknown): { task_subject?: string | null } | null | undefined {
	if (v === null) return null;
	if (!isJsonObject(v)) return undefined;
	const task_subject = optionalStringOrNull(v.task_subject);
	return { ...(task_subject !== undefined ? { task_subject } : {}) };
}

/** `event` is the row's discriminant (also the `AGENT_EVENT_HOOKS` lookup key
 *  and the output event's `type`), so — unlike every other agent_event field —
 *  a missing or unrecognised value rejects the row instead of degrading. Zero
 *  real rows hit this: the only writer (`agent-event-capture.ts`) always sets
 *  it from a `name: AgentEventName` parameter. */
function parseAgentEventUsed(value: JsonObject, ts: string): AgentEventRecordUsed | null {
	const event = value.event;
	if (event !== "subagent_start" && event !== "subagent_stop" && event !== "task_completed") {
		return null;
	}
	const agent_name = optionalStringOrNull(value.agent_name);
	const provider = typeof value.provider === "string" ? value.provider : undefined;
	const subagent_id = optionalStringOrNull(value.subagent_id);
	const parent_agent = optionalStringOrNull(value.parent_agent);
	const agent_transcript_path = optionalStringOrNull(value.agent_transcript_path);
	const last_assistant_message = optionalStringOrNull(value.last_assistant_message);
	const cwd = optionalStringOrNull(value.cwd);
	const task = parseAgentEventTask(value.task);
	return {
		ts,
		event,
		agent_type: requiredStringOrNull(value.agent_type),
		session_id: requiredStringOrNull(value.session_id),
		...(agent_name !== undefined ? { agent_name } : {}),
		...(provider !== undefined ? { provider } : {}),
		...(subagent_id !== undefined ? { subagent_id } : {}),
		...(parent_agent !== undefined ? { parent_agent } : {}),
		...(agent_transcript_path !== undefined ? { agent_transcript_path } : {}),
		...(last_assistant_message !== undefined ? { last_assistant_message } : {}),
		...(cwd !== undefined ? { cwd } : {}),
		...(task !== undefined ? { task } : {}),
	};
}

/**
 * Parse one collection.jsonl line into the used projection of a
 * `CollectionRecord` or `AgentEventRecord`. Replaces
 * `JSON.parse(line) as CollectionRecord | AgentEventRecord` — an unchecked
 * cast that asserted ~30 fields (most never read) with zero runtime
 * verification of any of them, including the ones this reader actually
 * depends on. `kind` dispatches exactly like the pre-fix code: anything other
 * than the literal string `"agent_event"` is a tool_event. `ts` is the one
 * field both record kinds must have to become an event at all — every real
 * row in both the tool_event and agent_event population carries it (measured
 * against the live .interlinked/collection.jsonl tail).
 */
export function parseCollectionOrAgentEvent(
	value: unknown,
): CollectionRecordUsed | AgentEventRecordUsed | null {
	if (!isJsonObject(value)) return null;
	const { ts } = value;
	if (typeof ts !== "string") return null;
	return value.kind === "agent_event"
		? parseAgentEventUsed(value, ts)
		: parseCollectionRecordUsed(value, ts);
}

/** Project one collection.v1 agent_event record to a v5 LocalActivityEvent —
 *  the projection that makes subagent results visible to `interlinked
 *  activity` / `logs` (type filters: subagent_start / subagent_stop /
 *  task_completed). */
function agentEventToActivity(rec: AgentEventRecordUsed): LocalActivityEvent {
	const fullSummary = rec.last_assistant_message ?? rec.task?.task_subject ?? null;
	const summary =
		fullSummary && fullSummary.length > AGENT_SUMMARY_MAX_CHARS
			? fullSummary.slice(0, AGENT_SUMMARY_MAX_CHARS)
			: fullSummary;
	const ev: LocalActivityEvent = {
		schema_version: 5,
		ts: rec.ts,
		agent: rec.agent_name ?? rec.provider ?? "unknown",
		type: rec.event,
		tool: rec.agent_type,
		summary,
		session: rec.session_id,
		hook: AGENT_EVENT_HOOKS[rec.event],
	};
	if (rec.cwd) ev.cwd = rec.cwd;
	if (rec.subagent_id) ev.subagent_id = rec.subagent_id;
	if (rec.parent_agent) ev.parent_agent = rec.parent_agent;
	if (rec.agent_type) ev.agent_type = rec.agent_type;
	if (rec.last_assistant_message) ev.last_assistant_message = rec.last_assistant_message;
	if (rec.agent_transcript_path) ev.agent_transcript_path = rec.agent_transcript_path;
	return ev;
}

/** Project one collection.v1 record to a v5 LocalActivityEvent. */
function collectionToActivity(rec: CollectionRecordUsed): LocalActivityEvent {
	const isPre = rec.phase === "pre";
	// Reconstruct the failed-tool discriminator from the record's `outcome` so a
	// `logs --type tool_use_error` query still surfaces failures once collection.jsonl
	// is canonical (finding 5). A post record with `outcome: "error"` → `tool_use_error`;
	// everything else (including legacy records with no `outcome`) reads as `tool_use`.
	const postType = rec.outcome === "error" ? "tool_use_error" : "tool_use";
	const ev: LocalActivityEvent = {
		schema_version: 5,
		ts: rec.ts,
		agent: rec.agent_name ?? rec.provider ?? "unknown",
		type: isPre ? "tool_use_start" : postType,
		tool: rec.provider_tool,
		summary: summarizeAction(rec.action),
		session: rec.session_id,
		hook: isPre ? "PreToolUse" : "PostToolUse",
	};
	if (rec.cwd) ev.cwd = rec.cwd;
	if (rec.tool_use_id) ev.tool_use_id = rec.tool_use_id;
	return ev;
}

type ReadCollectionActivityOpts = {
	since?: number | undefined;
	agent?: string | undefined;
	limit?: number | undefined;
	type?: string | undefined;
	cwd?: string | undefined;
};

/** Parse one collection.jsonl line to a v5 LocalActivityEvent, or `null` on any
 *  malformed/unrecognized line — mirrors the original inline try/catch: any
 *  parse or projection error is swallowed and the line is skipped. */
function parseCollectionLine(line: string): LocalActivityEvent | null {
	try {
		const parsed = parseCollectionOrAgentEvent(JSON.parse(line));
		if (!parsed) return null;
		return "event" in parsed ? agentEventToActivity(parsed) : collectionToActivity(parsed);
	} catch {
		return null;
	}
}

/** `true` once `ev` is older than `opts.since` — the loop's break condition. */
function isBeforeSince(ev: LocalActivityEvent, since: number | undefined): boolean {
	if (!since) return false;
	return new Date(ev.ts).getTime() < since;
}

/** Same agent/type filters `readLocalActivity` applies. */
function matchesCollectionFilters(
	ev: LocalActivityEvent,
	opts: Pick<ReadCollectionActivityOpts, "agent" | "type"> | undefined,
): boolean {
	if (opts?.agent && ev.agent !== opts.agent) return false;
	if (opts?.type && ev.type !== opts.type) return false;
	return true;
}

/** Read recent tool activity from collection.jsonl, projected to the v5 display
 *  shape, applying the same since/agent/type/limit filters as readLocalActivity.
 *  Newest-first (mirrors readRecentLines order). */
export function readCollectionActivity(opts?: ReadCollectionActivityOpts): LocalActivityEvent[] {
	const path = getCollectionPath(opts?.cwd ?? process.cwd());
	if (!existsSync(path)) return [];
	const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
	const scanLineBudget = limit ? Math.max(limit * 20, 500) : 10000;
	const events: LocalActivityEvent[] = [];
	for (const line of readRecentLines(path, scanLineBudget)) {
		const ev = parseCollectionLine(line);
		if (!ev) continue;
		if (isBeforeSince(ev, opts?.since)) break;
		if (!matchesCollectionFilters(ev, opts)) continue;
		events.push(ev);
		if (limit && events.length >= limit) break;
	}
	return events;
}

export function countJsonlLines(path: string): number {
	if (!existsSync(path)) {
		return 0;
	}
	try {
		return countNonEmptyFileLines(path);
	} catch (_err) {
		/* intentional: unreadable jsonl — report 0 lines rather than surface the error */
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Boundary parsing — activity.jsonl (see CAMPAIGN-boundary-parsers.md). ts/
// agent/type are the only required fields — the actual gap the old
// `as LocalActivityEvent` cast left unchecked. Every optional field is
// included when present-and-correctly-typed, omitted otherwise — never a
// reason to reject the row (two independent writers across schema versions
// 2-5 disagree on which optional fields they set). Looping over a field-name
// list keeps each extractor's cost at one branch regardless of list length.

function stringFields<K extends string>(value: JsonObject, keys: readonly K[]): Partial<Record<K, string>> {
	const out: Partial<Record<K, string>> = {};
	for (const key of keys) {
		const v = value[key];
		if (typeof v === "string") out[key] = v;
	}
	return out;
}

function stringOrNullFields<K extends string>(value: JsonObject, keys: readonly K[]): Partial<Record<K, string | null>> {
	const out: Partial<Record<K, string | null>> = {};
	for (const key of keys) {
		const v = optionalStringOrNull(value[key]);
		if (v !== undefined) out[key] = v;
	}
	return out;
}

function numberFields<K extends string>(value: JsonObject, keys: readonly K[]): Partial<Record<K, number>> {
	const out: Partial<Record<K, number>> = {};
	for (const key of keys) {
		const v = value[key];
		if (typeof v === "number") out[key] = v;
	}
	return out;
}

function booleanFields<K extends string>(value: JsonObject, keys: readonly K[]): Partial<Record<K, boolean>> {
	const out: Partial<Record<K, boolean>> = {};
	for (const key of keys) {
		const v = value[key];
		if (typeof v === "boolean") out[key] = v;
	}
	return out;
}

const STRING_OR_NULL_FIELDS = [
	"workspace_key", "project_key", "tool", "summary", "session", "hook",
	"guard_rule_id", "guard_severity", "guard_category", "guard_reason",
] as const satisfies ReadonlyArray<keyof LocalActivityEvent>;

const STRING_FIELDS = [
	"trace_id", "parent_agent", "subagent_id", "checkpoint_id", "tool_use_id",
	"parent_tool_use_id", "prompt_id", "effort", "event_id", "cwd", "permission_mode",
	"transcript_path", "model", "thinking", "source", "agent_type", "last_assistant_message",
	"agent_transcript_path", "prompt", "notification_type", "notification_title",
	"notification_message", "task_id", "task_subject", "task_description", "teammate_name",
	"team_name", "trigger", "custom_instructions", "reason", "error_message",
	"error_category", "git_head", "git_branch",
] as const satisfies ReadonlyArray<keyof LocalActivityEvent>;

const NUMBER_FIELDS = [
	"duration_ms", "seq", "tool_input_bytes", "tool_output_bytes", "guard_harness_ms",
] as const satisfies ReadonlyArray<keyof LocalActivityEvent>;

const BOOLEAN_FIELDS = ["scrubbed", "is_interrupt", "stop_hook_active"] as const satisfies ReadonlyArray<keyof LocalActivityEvent>;

function parseTokenUsage(v: unknown): TokenUsage | undefined {
	return isJsonObject(v) ? numberFields(v, ["input", "output", "cache_read", "cache_creation"] as const) : undefined;
}

function parseEventAttribution(v: unknown): EventAttribution | undefined {
	return isJsonObject(v) ? numberFields(v, ["agent_lines", "human_lines"] as const) : undefined;
}

function parseSchemaVersion(v: unknown): 2 | 3 | 4 | 5 | undefined {
	return v === 2 || v === 3 || v === 4 || v === 5 ? v : undefined;
}

// Real rows also carry `guard_decision: "warn"`, outside this declared union
// (local-activity-types.ts is not an assigned site) — a "warn" row simply
// omits this one field, like any other malformed optional field.
function parseGuardDecision(v: unknown): "allow" | "block" | "ask" | undefined {
	return v === "allow" || v === "block" || v === "ask" ? v : undefined;
}

function stringArray(v: unknown): string[] | undefined {
	return Array.isArray(v) && v.every((e): e is string => typeof e === "string") ? v : undefined;
}

/**
 * Parse one activity.jsonl line into `LocalActivityEvent`. Replaces
 * `JSON.parse(line) as LocalActivityEvent`, which never checked even
 * ts/agent/type — confirmed present-and-string on 20000/20000 rows of the
 * live .interlinked/activity.jsonl tail sampled for this fix.
 */
export function parseLocalActivityEvent(value: unknown): LocalActivityEvent | null {
	if (!isJsonObject(value)) return null;
	const { ts, agent, type } = value;
	if (typeof ts !== "string" || typeof agent !== "string" || typeof type !== "string") {
		return null;
	}
	const schema_version = parseSchemaVersion(value.schema_version);
	const guard_decision = parseGuardDecision(value.guard_decision);
	const files_modified = stringArray(value.files_modified);
	const guard_warnings = value.guard_warnings === null ? null : stringArray(value.guard_warnings);
	const tokens = parseTokenUsage(value.tokens);
	const attribution = parseEventAttribution(value.attribution);
	return {
		ts,
		agent,
		type,
		...stringOrNullFields(value, STRING_OR_NULL_FIELDS),
		...stringFields(value, STRING_FIELDS),
		...numberFields(value, NUMBER_FIELDS),
		...booleanFields(value, BOOLEAN_FIELDS),
		...(value.tool_input !== undefined ? { tool_input: value.tool_input } : {}),
		...(value.tool_response !== undefined ? { tool_response: value.tool_response } : {}),
		...(value.error !== undefined ? { error: value.error } : {}),
		...(value.permission_suggestions !== undefined
			? { permission_suggestions: value.permission_suggestions }
			: {}),
		...(schema_version !== undefined ? { schema_version } : {}),
		...(guard_decision !== undefined ? { guard_decision } : {}),
		...(files_modified !== undefined ? { files_modified } : {}),
		...(guard_warnings !== undefined ? { guard_warnings } : {}),
		...(tokens !== undefined ? { tokens } : {}),
		...(attribution !== undefined ? { attribution } : {}),
	};
}
