// ===========================================
// Agent-event capture — persist subagent / parallel-agent lifecycle + results
// ===========================================
// SubagentStop is the ONLY hook that carries a spawned agent's RESULT text
// (`last_assistant_message`): a background agent's result is delivered to the
// parent over a queue-notification channel that fires no hook, and the
// launch's PostToolUse returns just a task id. Until 2026-07 these events
// reached the daemon (lifecycle-events.ts routed them to cohort tracking) but
// were never persisted — a spawned agent's answer existed nowhere under
// .interlinked/, only in Claude Code's own per-agent transcript files.
//
// This module writes one collection.v1 `agent_event` record per
// SubagentStart / SubagentStop / TaskCompleted:
//   - the final message comes from the hook payload, or — when the payload
//     omits it — from a bounded tail-read of the agent's own transcript;
//   - the message is scrubbed (secrets + PII) like every natural-language
//     field (parity with prompt/thinking scrub policy);
//   - on SubagentStop the agent's transcript is also drained into
//     timeline.jsonl (attributed via `agent_id` — see transcript-record.ts).
//
// Best-effort / fail-open everywhere (feedback_safety_continuity): capture
// must never break the guard pipeline.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type {
	AgentEventName,
	AgentEventRecord,
	AgentMessageSource,
	AgentTranscriptMetrics,
} from "../../lib/collection/types.js";
import { appendCollection } from "../../lib/collection/writer.js";
import { isJsonObject } from "../../lib/json-types.js";
import type { JsonObject } from "../../lib/json-types.js";
import { redactPii, scrubSecrets } from "../../lib/secrets.js";
import { captureAgentTranscript } from "../timeline-capture.js";
import type { AgentSource, HarnessEvent } from "../types.js";
import {
	readAgentMetrics,
	rememberAgentType,
	resolveAgentType,
	type ResolvedAgentType,
} from "./agent-event-context.js";

/** Hook events this module persists, mapped to their record `event` name. */
const AGENT_EVENT_NAMES: Record<string, AgentEventName> = {
	SubagentStart: "subagent_start",
	SubagentStop: "subagent_stop",
	TaskCompleted: "task_completed",
};

/** How much of a transcript tail to scan for the final assistant message.
 *  The final message is the last assistant entry, so a generous tail is
 *  plenty; bounding the read keeps a pathological transcript cheap. */
export const FINAL_MESSAGE_TAIL_BYTES = 256 * 1024;

/** Persisted-message cap — mirrors the full-fidelity thinking-capture policy
 *  (64KB+ records are fine) while still bounding a runaway payload. */
export const FINAL_MESSAGE_MAX_CHARS = 65_536;

/** Delay before the one-shot transcript RE-drain. The runner flushes the
 *  agent's final transcript entries a few ms AFTER firing SubagentStop
 *  (observed: 29ms in the live probe), so the immediate drain can miss the
 *  final assistant/thinking records. The re-drain is idempotent (uuid#seq
 *  dedup) and its timer is unref'd, so it never holds the daemon open. */
export const AGENT_TRANSCRIPT_REDRAIN_MS = 750;

/** Provider label per agent source — same vocabulary the tool_event records
 *  use (`detectProvider` in lib/collection/builder.ts). */
export const PROVIDER_BY_SOURCE: Record<AgentSource, string> = {
	claude: "claude-code",
	gemini: "gemini-cli",
	copilot: "copilot",
	codex: "codex",
	cursor: "cursor",
	opencode: "opencode",
	opencode2: "opencode2",
	pi: "pi",
};

/** Read the last `tailBytes` of a file as utf-8, dropping a partial first
 *  line when the read starts mid-file. Null on any failure. */
function readTranscriptTail(path: string, tailBytes: number): string | null {
	try {
		if (!existsSync(path)) return null;
		const size = statSync(path).size;
		if (size === 0) return null;
		const offset = Math.max(0, size - tailBytes);
		const fd = openSync(path, "r");
		const buf = Buffer.alloc(size - offset);
		readSync(fd, buf, 0, buf.length, offset);
		closeSync(fd);
		let text = buf.toString("utf-8");
		if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
		return text;
	} catch (err) {
		void err; // unreadable transcript — capture degrades to payload-only
		return null;
	}
}

/** The text of the LAST text block of one assistant transcript entry, or null. */
function assistantEntryText(entry: JsonObject): string | null {
	if (entry.type !== "assistant") return null;
	// SAFETY: transcript lines are untyped JSON; every field read is guarded.
	const message = entry.message as JsonObject | undefined;
	const content = message?.content;
	if (!Array.isArray(content)) return null;
	for (let i = content.length - 1; i >= 0; i--) {
		// SAFETY: untyped content block; type/text are guarded before use.
		const block = content[i] as JsonObject | undefined;
		if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
			return block.text;
		}
	}
	return null;
}

/** Walk transcript JSONL text backwards for the final assistant text. */
export function lastAssistantText(jsonlText: string): string | null {
	const lines = jsonlText.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isJsonObject(parsed)) continue;
			const text = assistantEntryText(parsed);
			if (text !== null) return text;
		} catch (err) {
			void err; // truncated / non-JSON line — keep walking
		}
	}
	return null;
}

/** Secrets + PII scrub and length-cap for the persisted final message —
 *  natural-language field, same policy as prompt/thinking capture. */
export function scrubFinalMessage(text: string): string {
	const scrubbed = redactPii(scrubSecrets(text).text).text;
	return scrubbed.length > FINAL_MESSAGE_MAX_CHARS
		? scrubbed.slice(0, FINAL_MESSAGE_MAX_CHARS)
		: scrubbed;
}

/** The agent's final message: hook payload first, transcript tail as the
 *  fallback (the payload is authoritative when present — it is what the
 *  parent actually received). Null when neither source has one. */
export function resolveFinalMessage(
	event: HarnessEvent,
): { text: string; source: AgentMessageSource } | null {
	if (typeof event.last_assistant_message === "string" && event.last_assistant_message.trim()) {
		return { text: event.last_assistant_message, source: "payload" };
	}
	if (event.agent_transcript_path) {
		const tail = readTranscriptTail(event.agent_transcript_path, FINAL_MESSAGE_TAIL_BYTES);
		const text = tail !== null ? lastAssistantText(tail) : null;
		if (text !== null) return { text, source: "transcript" };
	}
	return null;
}

/** One string field off the event's tool_input or (legacy raw-socket path,
 *  where the .mjs normalizer keeps payload fields top-level) the event root. */
function eventField(event: HarnessEvent, key: string): string | null {
	const fromInput = event.tool_input?.[key];
	if (typeof fromInput === "string" && fromInput) return fromInput;
	// SAFETY: raw-socket events carry extra top-level fields the interface
	// doesn't declare; read-only string probe, type-guarded below.
	const fromRoot = (event as unknown as JsonObject)[key];
	return typeof fromRoot === "string" && fromRoot ? fromRoot : null;
}

/** TaskCompleted context; null for subagent events / when nothing present. */
function taskContext(event: HarnessEvent, name: AgentEventName): AgentEventRecord["task"] {
	if (name !== "task_completed") return null;
	const task = {
		task_id: eventField(event, "task_id"),
		task_subject: eventField(event, "task_subject"),
		teammate_name: eventField(event, "teammate_name"),
		team_name: eventField(event, "team_name"),
	};
	return task.task_id || task.task_subject || task.teammate_name || task.team_name ? task : null;
}

/** Everything resolved OUTSIDE the pure record assembly: the final message,
 *  the agent's type label (payload, or remembered from its SubagentStart), and
 *  the transcript-derived metrics. All optional — an absent field records
 *  null, so a caller that resolves nothing still gets a well-formed record. */
export interface AgentEventExtras {
	resolved?: { text: string; source: AgentMessageSource } | null;
	agentType?: ResolvedAgentType | null;
	metrics?: AgentTranscriptMetrics | null;
}

/** The label straight off the payload. An empty-string `agent_type` is NOT a
 *  label (Claude Code sends "" on some paths), so it normalizes to null
 *  rather than surviving as a falsy-but-present value. */
function payloadLabel(event: HarnessEvent): ResolvedAgentType {
	const raw = event.agent_type?.trim() || event.tool_name?.trim() || null;
	return { type: raw, source: raw ? "payload" : null };
}

/** Pure record assembly for one agent lifecycle event. */
export function buildAgentEventRecord(
	event: HarnessEvent,
	name: AgentEventName,
	fallbackCwd: string,
	extras: AgentEventExtras = {},
): AgentEventRecord {
	const resolved = extras.resolved ?? null;
	const label = extras.agentType ?? payloadLabel(event);
	return {
		schema: "collection.v1",
		kind: "agent_event",
		ts: event.timestamp,
		session_id: event.session_id || null,
		agent_name: event.agent_name ?? null,
		provider: PROVIDER_BY_SOURCE[event.agent_source] ?? event.agent_source,
		event: name,
		subagent_id: event.subagent_id ?? eventField(event, "agent_id"),
		agent_type: label.type,
		agent_type_source: label.source,
		parent_agent: event.parent_agent ?? null,
		agent_transcript_path: event.agent_transcript_path ?? null,
		last_assistant_message: resolved ? scrubFinalMessage(resolved.text) : null,
		message_source: resolved?.source ?? null,
		metrics: extras.metrics ?? null,
		task: taskContext(event, name),
		cwd: event.cwd ?? fallbackCwd,
	};
}

/** Resolve the label + (on stop) message and transcript metrics for one
 *  event, and remember a start event's label for the stop that follows it. */
function resolveExtras(event: HarnessEvent, name: AgentEventName): AgentEventExtras {
	const agentType = resolveAgentType(event);
	if (name === "subagent_start") {
		rememberAgentType(event.subagent_id ?? null, agentType.type);
		return { agentType };
	}
	if (name !== "subagent_stop") return { agentType };
	return {
		agentType,
		resolved: resolveFinalMessage(event),
		metrics: readAgentMetrics(event.agent_transcript_path),
	};
}

/**
 * Persist one agent lifecycle event to collection.jsonl and — on
 * SubagentStop — drain the agent's transcript into timeline.jsonl. No-op for
 * hook events outside the agent-lifecycle set. Fail-open by contract.
 */
export function captureAgentEvent(
	event: HarnessEvent,
	fallbackCwd: string,
	log?: (msg: string) => void,
): void {
	try {
		const name = AGENT_EVENT_NAMES[event.hook_event];
		if (!name) return;
		const cwd = event.cwd ?? fallbackCwd;
		const extras = resolveExtras(event, name);
		appendCollection(buildAgentEventRecord(event, name, fallbackCwd, extras), cwd);
		if (name === "subagent_stop") {
			const transcriptPath = event.agent_transcript_path;
			const drained = captureAgentTranscript(transcriptPath, cwd);
			// Re-drain once after the runner's post-Stop transcript flush lands
			// (see AGENT_TRANSCRIPT_REDRAIN_MS); dedup makes the second pass free.
			setTimeout(() => captureAgentTranscript(transcriptPath, cwd), AGENT_TRANSCRIPT_REDRAIN_MS).unref();
			log?.(
				`Agent event captured: ${name} (${event.subagent_id ?? "unknown"}, ` +
					`type: ${extras.agentType?.type ?? "unknown"}, ` +
					`message: ${extras.resolved?.source ?? "none"}, ` +
					`tokens: ${extras.metrics?.tokens.output ?? "n/a"} out, timeline records: ${drained})`,
			);
		}
	} catch (err) {
		void err; // capture is best-effort — never break the pipeline
	}
}
