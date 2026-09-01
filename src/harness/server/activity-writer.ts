// ===========================================
// Legacy activity.jsonl mirror (daemon dual-write)
// ===========================================
// Maps a `HarnessEvent` (the daemon's normalized wire event) to the legacy v5
// `LocalActivityEvent` and appends it to activity.jsonl. The canonical stream
// is collection.jsonl (server/collection-writer.ts); this mirror keeps the CLI
// reader commands (status / activity / logs / sync) working, which still read
// activity.jsonl. Mirrors the dual-write the old self-contained .mjs hook did
// before the thin hook-entry.js + daemon path took over.
//
// Best-effort: a failure here never breaks the pipeline. Tool events are
// mirrored alongside collection.jsonl; lifecycle events use a separate writer
// because collection.jsonl intentionally accepts tool events only.

import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../lib/config.js";
import { appendChainedAuditRecord } from "../../lib/audit-chain.js";
import type { JsonObject } from "../../lib/json-types.js";
import { appendActivityRecordOnly, type LocalActivityEvent } from "../../lib/local-activity.js";
import { eventAttributionFields } from "../event-attribution-fields.js";
import { extractNewThinking, latestTranscriptModel, resolveTranscriptPath } from "../thinking-capture.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";

const ACTIVITY_SUMMARY_MAX_CHARS = 200;

/** Partition the hook event into a v5 activity `type`, or null for non-tool
 *  events. Same partition the collection writer uses for `event_type`. */
function activityType(hookEvent: string): string | null {
	if (hookEvent === "PreToolUse" || hookEvent === "BeforeTool") return "tool_use_start";
	if (hookEvent === "PostToolUseFailure") return "tool_use_error";
	if (hookEvent === "PostToolUse" || hookEvent === "AfterTool") return "tool_use";
	return null;
}

/** Canonical full-fidelity activity types for hook events that do not enter the
 *  Pre/Post tool pipelines. Aliases from supported clients collapse onto the
 *  same stable type (for example PreCompact and Gemini's PreCompress).
 *  SubagentStart/SubagentStop/TaskCompleted are absent by design: the lifecycle
 *  handler already writes richer, scrubbed collection.v1 agent_event records,
 *  which the activity reader projects without needing a second mirror row. */
const LIFECYCLE_ACTIVITY_TYPES: Readonly<Record<string, string>> = {
	SessionStart: "session_start",
	SessionEnd: "session_end",
	Interrupt: "interrupt",
	Stop: "agent_stop",
	UserPromptSubmit: "user_prompt",
	Notification: "notification",
	PreCompact: "context_compact",
	PreCompress: "context_compact",
	PostCompact: "context_compacted",
	AfterModel: "model_response",
	TeammateIdle: "teammate_idle",
	PermissionRequest: "permission_request",
	WorktreeCreate: "worktree_create",
	SkillEnter: "skill_enter",
	SkillLeave: "skill_leave",
	SkillList: "skill_list",
};

/** Event fields copied onto lifecycle records when the normalized wire event
 *  carries them either top-level or in its compact lifecycle `tool_input`. The
 *  prompt is deliberately absent: it has a dedicated redaction-aware path. */
const LIFECYCLE_STRING_FIELDS = [
	"permission_mode",
	"transcript_path",
	"source",
	"agent_type",
	"last_assistant_message",
	"agent_transcript_path",
	"notification_type",
	"notification_title",
	"notification_message",
	"task_id",
	"task_subject",
	"task_description",
	"teammate_name",
	"team_name",
	"trigger",
	"custom_instructions",
	"reason",
] as const satisfies ReadonlyArray<keyof LocalActivityEvent>;

const SUMMARY_FIELDS: Readonly<Record<string, readonly string[]>> = {
	session_end: ["reason"],
	agent_stop: ["stop_reason", "reason"],
	notification: ["notification_message", "message"],
	task_completed: ["task_subject", "task_id"],
	teammate_idle: ["teammate_name"],
	worktree_create: ["path", "worktree_path"],
};

const TOOL_FIELD_BY_LIFECYCLE_TYPE: Readonly<Record<string, string>> = {
	subagent_start: "agent_type",
	subagent_stop: "agent_type",
	teammate_idle: "teammate_name",
	model_response: "model",
};

/** Read a lifecycle payload field from the normalized event first, then from
 *  the compact `tool_input` fallback used by the legacy bridge. */
function lifecycleField(event: HarnessEvent, key: string): unknown {
	// SAFETY: hook payloads are parsed JSON objects and HarnessEvent deliberately
	// models only the decision-path subset; lifecycle metadata remains keyed data.
	const direct = (event as HarnessEvent & Record<string, unknown>)[key];
	return direct !== undefined ? direct : event.tool_input?.[key];
}

function lifecycleString(event: HarnessEvent, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = lifecycleField(event, key);
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function lifecycleSummary(
	event: HarnessEvent,
	type: string,
	persistedPrompt: string | null,
): string | null {
	if (type === "user_prompt") {
		return persistedPrompt ? persistedPrompt.slice(0, ACTIVITY_SUMMARY_MAX_CHARS) : null;
	}
	if (type === "permission_request") return summarize(event.tool_name, event.tool_input);
	const fields = SUMMARY_FIELDS[type];
	const value = fields ? lifecycleString(event, fields) : null;
	return value ? value.slice(0, ACTIVITY_SUMMARY_MAX_CHARS) : null;
}

function lifecycleTool(event: HarnessEvent, type: string): string | null {
	if (type === "permission_request") return event.tool_name ?? null;
	const field = TOOL_FIELD_BY_LIFECYCLE_TYPE[type];
	return field ? lifecycleString(event, [field]) : null;
}

/** Copy optional lifecycle payload fields without ever copying the raw prompt.
 *  `redacted_prompt` is the only prompt value allowed into the record when the
 *  content-scanner decision supplied one. */
function copyLifecyclePayloadFields(
	record: LocalActivityEvent,
	event: HarnessEvent,
): void {
	for (const key of LIFECYCLE_STRING_FIELDS) {
		const value = lifecycleField(event, key);
		if (typeof value === "string" && value.length > 0) Object.assign(record, { [key]: value });
	}
	const stopHookActive = lifecycleField(event, "stop_hook_active");
	if (typeof stopHookActive === "boolean") record.stop_hook_active = stopHookActive;
	const permissionSuggestions = lifecycleField(event, "permission_suggestions");
	if (permissionSuggestions !== undefined) record.permission_suggestions = permissionSuggestions;
}

/** A short human label for the activity feed: the command for shell tools, the
 *  path for file tools, the pattern for search tools, else the tool name. */
function summarize(toolName: string | undefined, input: JsonObject | undefined): string | null {
	const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
	const command = input ? str(input.command) : null;
	if (command) return command.slice(0, 200);
	const path = input ? (str(input.file_path) ?? str(input.path) ?? str(input.notebook_path)) : null;
	if (path) return path;
	const pattern = input ? (str(input.pattern) ?? str(input.query)) : null;
	if (pattern) return pattern.slice(0, 200);
	return toolName ?? null;
}

// Workspace/project keys come from config; cache per-cwd so the hot path does no
// repeat config I/O. `resolveConfig` returns defaults for a missing config and
// does not throw, so no guard is needed here.
const keyCache = new Map<string, { workspace: string; project: string }>();
function projectKeys(cwd: string): { workspace: string; project: string } {
	const cached = keyCache.get(cwd);
	if (cached) return cached;
	const cfg = resolveConfig(cwd);
	const keys = {
		workspace: cfg.default_workspace_key ?? cfg.workspace_id ?? "main",
		project: cfg.default_project ?? "main",
	};
	keyCache.set(cwd, keys);
	return keys;
}

/**
 * `event` is parsed straight from an untrusted socket payload (`JSON.parse`
 * in server-event-loop.ts, cast to `HarnessEvent` with no runtime
 * validation), so `agent_source` — typed as the required, non-optional
 * `AgentSource` union — can genuinely be missing or malformed at runtime
 * despite the type saying otherwise. Read it through `unknown` and narrow
 * with a real `typeof` check so callers see an honest `string | undefined`
 * instead of a lint-dead `?? "unknown"` fallback.
 */
function honestAgentSource(event: HarnessEvent): string | undefined {
	const value: unknown = event.agent_source;
	return typeof value === "string" ? value : undefined;
}

/** Map a tool `HarnessEvent` to a v5 `LocalActivityEvent`, or null for non-tool
 *  events. Pure (modulo the cached config lookup). */
export function mapEventToActivityRecord(
	event: HarnessEvent,
	fallbackCwd: string,
): LocalActivityEvent | null {
	const type = activityType(event.hook_event);
	if (!type) return null;
	const cwd = event.cwd ?? fallbackCwd;
	const keys = projectKeys(cwd);
	const rec: LocalActivityEvent = {
		schema_version: 5,
		ts: event.timestamp,
		agent: event.agent_name ?? honestAgentSource(event) ?? "unknown",
		workspace_key: keys.workspace,
		project_key: keys.project,
		type,
		tool: event.tool_name ?? null,
		summary: summarize(event.tool_name, event.tool_input),
		session: event.session_id,
		hook: event.hook_event,
		tool_input: event.tool_input ?? {},
		cwd,
	};
	if (event.tool_use_id) rec.tool_use_id = event.tool_use_id;
	Object.assign(rec, eventAttributionFields(event));
	// The owning Task call, when the runner sends it: the one field that says
	// a SUBAGENT made this call rather than the parent session.
	if (event.parent_tool_use_id) rec.parent_tool_use_id = event.parent_tool_use_id;
	if (event.prompt_id) rec.prompt_id = event.prompt_id;
	if (event.effort) rec.effort = event.effort;
	if (event.seq !== undefined) rec.seq = event.seq;
	if (event.event_id) rec.event_id = event.event_id;
	return rec;
}

/** Map a non-tool lifecycle event to the full-fidelity activity stream. Prompt
 *  persistence is decision-aware: once the lifecycle scanner supplies a
 *  redacted copy, neither the raw prompt nor its raw summary is written. */
export function mapLifecycleEventToActivityRecord(
	event: HarnessEvent,
	fallbackCwd: string,
	decision?: HarnessDecision,
): LocalActivityEvent | null {
	const type = LIFECYCLE_ACTIVITY_TYPES[event.hook_event];
	if (!type) return null;
	const cwd = event.cwd ?? fallbackCwd;
	const keys = projectKeys(cwd);
	const persistedPrompt =
		type === "user_prompt" ? (decision?.redacted_prompt ?? event.prompt ?? "") : null;
	const rec: LocalActivityEvent = {
		schema_version: 5,
		ts: event.timestamp,
		agent: event.agent_name ?? honestAgentSource(event) ?? "unknown",
		workspace_key: keys.workspace,
		project_key: keys.project,
		type,
		tool: lifecycleTool(event, type),
		summary: lifecycleSummary(event, type, persistedPrompt),
		session: event.session_id,
		hook: event.hook_event,
		cwd,
	};
	Object.assign(rec, eventAttributionFields(event));
	copyLifecyclePayloadFields(rec, event);
	if (type === "user_prompt") {
		rec.prompt = persistedPrompt ?? "";
		if (decision?.redacted_prompt !== undefined) rec.scrubbed = true;
	}
	if (type === "interrupt") rec.is_interrupt = true;
	if (event.prompt_id) rec.prompt_id = event.prompt_id;
	if (event.effort) rec.effort = event.effort;
	if (event.seq !== undefined) rec.seq = event.seq;
	if (event.event_id) rec.event_id = event.event_id;
	return rec;
}

/** Append the legacy activity.jsonl mirror for a tool event. Best-effort: any
 *  failure is swallowed so the daemon pipeline never breaks on the mirror. */
export function writeActivityRecord(event: HarnessEvent, fallbackCwd: string): void {
	try {
		const rec = mapEventToActivityRecord(event, fallbackCwd);
		if (!rec) return;
		// Live thinking capture: on a tool_use_start, attach the reasoning that
		// preceded this tool call. The thin hook-entry path never replicated the
		// old .mjs's extractNewThinking — this restores it daemon-side (the June-1
		// regression). Scrubbed inside extractNewThinking; best-effort.
		if (rec.type === "tool_use_start" && event.agent_source !== "codex") {
			const cwd = event.cwd ?? fallbackCwd;
			const tp = resolveTranscriptPath(event.transcript_path, event.session_id, cwd, homedir());
			if (tp) {
				const thinking = extractNewThinking(tp, join(cwd, ".interlinked", "thinking-cursor.json"));
				if (thinking) rec.thinking = thinking;
				const model = latestTranscriptModel(tp);
				if (model) rec.model = model;
			}
		}
		appendActivityRecordOnly(rec, event.cwd ?? fallbackCwd);
	} catch {
		// Best-effort legacy mirror — a failed activity.jsonl write must never
		// break the daemon pipeline; collection.jsonl is the canonical record.
		return;
	}
}

/** Append one non-tool lifecycle event to activity.jsonl. This intentionally
 *  does not call the tool collection writer, whose schema excludes lifecycle
 *  records. Best-effort so observability I/O cannot break hook evaluation. */
export function writeLifecycleActivityRecord(
	event: HarnessEvent,
	fallbackCwd: string,
	decision?: HarnessDecision,
): void {
	try {
		const rec = mapLifecycleEventToActivityRecord(event, fallbackCwd, decision);
		if (!rec) return;
		const cwd = event.cwd ?? fallbackCwd;
		if (rec.type === "session_end") appendChainedAuditRecord(rec, cwd);
		else appendActivityRecordOnly(rec, cwd);
	} catch {
		return;
	}
}

/** Map a guard DECISION (not the event) to a v5 guard_* activity record.
 *  block/ask becomes guard_block; an allow carrying warnings becomes guard_warn.
 *  A bare allow with no warnings returns null and is NOT recorded: it is
 *  derivable from a tool_use_start having no paired guard_block, and recording
 *  one per call would double the log 1:1 with tool_use_start. Pure (modulo the
 *  cached config lookup) -- mirrors mapEventToActivityRecord. */
export function mapDecisionToGuardRecord(
	event: HarnessEvent,
	decision: HarnessDecision,
	fallbackCwd: string,
): LocalActivityEvent | null {
	const isBlock = decision.decision === "block" || decision.decision === "ask";
	const hasWarnings = (decision.warnings?.length ?? 0) > 0;
	if (!isBlock && !hasWarnings) return null;
	const cwd = event.cwd ?? fallbackCwd;
	const keys = projectKeys(cwd);
	const rec: LocalActivityEvent = {
		schema_version: 5,
		ts: event.timestamp,
		agent: event.agent_name ?? honestAgentSource(event) ?? "unknown",
		workspace_key: keys.workspace,
		project_key: keys.project,
		type: isBlock ? "guard_block" : "guard_warn",
		tool: event.tool_name ?? null,
		summary: (decision.reason ?? decision.warnings?.join("; ") ?? "guard").slice(0, 500),
		session: event.session_id,
		hook: event.hook_event,
		cwd,
		guard_decision: decision.decision,
		guard_rule_id: decision.rule_id ?? null,
		guard_severity: decision.severity ?? null,
		guard_category: decision.category ?? null,
		guard_reason: decision.reason ?? null,
		guard_warnings: decision.warnings ?? null,
	};
	if (event.tool_use_id) rec.tool_use_id = event.tool_use_id;
	Object.assign(rec, eventAttributionFields(event));
	if (event.seq !== undefined) rec.seq = event.seq;
	if (typeof decision.checks_timing_ms === "number") rec.guard_harness_ms = decision.checks_timing_ms;
	return rec;
}

/** Append the legacy activity.jsonl guard_* record for a guard decision.
 *  Best-effort: any failure is swallowed so the daemon pipeline never breaks.
 *  collection.jsonl deliberately drops guard_* (lib/collection/builder.ts), so
 *  activity.jsonl is the ONLY local sink -- this restores the 2026-06-01 writer
 *  regression where the .mjs to daemon port dropped appendGuardDecision and
 *  guard decisions stopped being recorded even though blocking kept working. */
export function writeGuardDecisionRecord(
	event: HarnessEvent,
	decision: HarnessDecision,
	fallbackCwd: string,
): void {
	try {
		const rec = mapDecisionToGuardRecord(event, decision, fallbackCwd);
		if (!rec) return;
		appendChainedAuditRecord(rec, event.cwd ?? fallbackCwd);
	} catch {
		// Best-effort -- a failed guard-telemetry write must never break the
		// daemon pipeline (feedback_safety_continuity).
		return;
	}
}
