// ===========================================
// Per-subagent transcript metrics
// ===========================================
// A spawned agent's own transcript carries the ONLY record of what that agent
// cost and did: per-turn token usage, the model it actually ran on (often NOT
// the parent's model), and every tool call it made. Claude records those facts
// in assistant `message.usage` / content blocks; Codex records them in
// `event_msg` token_count, `turn_context`, and `response_item` rows. None of it
// reaches the parent hook payload, so before this module the entire cost and
// shape of a subagent's run was discarded at capture time.
//
// `summarizeAgentTranscript` is a pure function over transcript JSONL text so
// it can be unit-tested without a daemon or a filesystem. It is called once,
// on SubagentStop, from server/agent-event-capture.ts.
//
// The `tool_use_ids` list is the ATTRIBUTION KEY: a subagent's own tool calls
// reach the guard as ordinary PreToolUse/PostToolUse events carrying the
// PARENT session id and no agent marker, so activity.jsonl cannot tell them
// apart. Recording the ids the agent emitted lets any consumer join
// activity/collection rows back to the agent that made them.

// The record shapes live with the other collection.v1 types (lib/collection)
// so the writer and every consumer see one definition; re-exported here
// because this module is where they are produced.
import type { AgentTokenTotals, AgentTranscriptMetrics } from "../lib/collection/types.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

export type { AgentTranscriptMetrics };

/** Cap on the recorded id list — a runaway agent must not write an unbounded
 *  field into collection.jsonl. Counts stay exact when this trips. */
export const MAX_TOOL_USE_IDS = 2000;

const ZERO_TOKENS: AgentTokenTotals = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };

/** Empty metrics — returned for an unreadable / empty transcript so callers
 *  never branch on null in the middle of record assembly. */
export function emptyAgentMetrics(): AgentTranscriptMetrics {
	return {
		assistant_turns: 0,
		tool_calls: 0,
		tools: {},
		tool_use_ids: [],
		tool_use_ids_truncated: false,
		models: [],
		tokens: { ...ZERO_TOKENS },
		thinking_blocks: 0,
		thinking_blocks_with_text: 0,
		first_ts: null,
		last_ts: null,
		duration_ms: null,
		transcript_entries: 0,
	};
}

function finiteMetric(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addClaudeUsage(totals: AgentTokenTotals, usage: JsonObject): void {
	totals.input += finiteMetric(usage.input_tokens);
	totals.output += finiteMetric(usage.output_tokens);
	totals.cache_read += finiteMetric(usage.cache_read_input_tokens);
	totals.cache_creation += finiteMetric(usage.cache_creation_input_tokens);
}

function addCodexUsage(totals: AgentTokenTotals, usage: JsonObject): void {
	totals.input += finiteMetric(usage.input_tokens);
	totals.output += finiteMetric(usage.output_tokens);
	totals.cache_read += finiteMetric(usage.cached_input_tokens);
	totals.cache_creation += finiteMetric(usage.cache_write_input_tokens);
}

/** Fold one `tool_use` block: per-tool count plus the capped id list. */
function foldToolUse(block: JsonObject, m: AgentTranscriptMetrics): void {
	m.tool_calls += 1;
	const name = typeof block.name === "string" && block.name ? block.name : "unknown";
	m.tools[name] = (m.tools[name] ?? 0) + 1;
	if (typeof block.id !== "string" || !block.id) return;
	if (m.tool_use_ids.length < MAX_TOOL_USE_IDS) m.tool_use_ids.push(block.id);
	else m.tool_use_ids_truncated = true;
}

/** Fold one `thinking` block, tracking text-bearing ones separately. */
function foldThinking(block: JsonObject, m: AgentTranscriptMetrics): void {
	m.thinking_blocks += 1;
	if (typeof block.thinking === "string" && block.thinking.trim()) m.thinking_blocks_with_text += 1;
}

/** Fold one assistant content block into the running metrics. */
function foldContentBlock(block: JsonObject, m: AgentTranscriptMetrics): void {
	if (block.type === "tool_use") foldToolUse(block, m);
	else if (block.type === "thinking") foldThinking(block, m);
}

/** Fold one assistant transcript entry (usage, model, content blocks). */
function foldAssistantEntry(message: JsonObject, m: AgentTranscriptMetrics): void {
	const usage = message.usage;
	if (isJsonObject(usage)) {
		m.assistant_turns += 1;
		addClaudeUsage(m.tokens, usage);
	}
	const model = message.model;
	if (typeof model === "string" && model && !m.models.includes(model)) m.models.push(model);
	const content = message.content;
	if (!Array.isArray(content)) return;
	for (const raw of content) {
		// transcript content is untyped JSON; foldContentBlock guards every field it reads.
		if (isJsonObject(raw)) foldContentBlock(raw, m);
	}
}

/** Codex emits one incremental `last_token_usage` object per completed model
 * request. `total_token_usage` is cumulative across the rollout and must never
 * be summed here. Reasoning output is already included in `output_tokens`. */
function foldCodexTokenCount(payload: JsonObject, m: AgentTranscriptMetrics): void {
	if (payload.type !== "token_count") return;
	const info = payload.info;
	if (!isJsonObject(info)) return;
	const usage = info.last_token_usage;
	if (!isJsonObject(usage)) return;
	m.assistant_turns += 1;
	addCodexUsage(m.tokens, usage);
}

/** Codex tool calls live as response items rather than assistant content
 * blocks. `call_id` is the result-join key; provider `id` is a safe fallback
 * for incomplete or older rollout rows. */
function foldCodexToolCall(payload: JsonObject, m: AgentTranscriptMetrics): void {
	if (payload.type !== "function_call" && payload.type !== "custom_tool_call") return;
	const id =
		typeof payload.call_id === "string" && payload.call_id
			? payload.call_id
			: typeof payload.id === "string"
				? payload.id
				: "";
	foldToolUse({ name: payload.name, id }, m);
}

/** Fold the provider-specific facts carried by a Codex rollout row. Every
 * nested object is shape-gated so partial rows remain harmless. */
function foldCodexEntry(entry: JsonObject, m: AgentTranscriptMetrics): void {
	const payload = entry.payload;
	if (!isJsonObject(payload)) return;
	if (entry.type === "event_msg") foldCodexTokenCount(payload, m);
	if (
		(entry.type === "turn_context" || payload.type === "turn_context") &&
		typeof payload.model === "string" &&
		payload.model &&
		!m.models.includes(payload.model)
	) {
		m.models.push(payload.model);
	}
	if (entry.type === "response_item") foldCodexToolCall(payload, m);
}

/** Track the transcript's time span; entries are chronological but a tail read
 *  may start anywhere, so take min/max rather than first/last seen. */
function foldTimestamp(ts: unknown, m: AgentTranscriptMetrics): void {
	if (typeof ts !== "string" || !ts) return;
	if (m.first_ts === null || ts < m.first_ts) m.first_ts = ts;
	if (m.last_ts === null || ts > m.last_ts) m.last_ts = ts;
}

function spanMs(first: string | null, last: string | null): number | null {
	if (first === null || last === null || first === last) return null;
	const a = Date.parse(first);
	const b = Date.parse(last);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	return Math.max(0, b - a);
}

/**
 * Summarize one agent transcript (JSONL text) into cost + activity metrics.
 * Pure and total: malformed lines are skipped, an empty input yields
 * `emptyAgentMetrics()`. Never throws.
 */
export function summarizeAgentTranscript(jsonlText: string): AgentTranscriptMetrics {
	const m = emptyAgentMetrics();
	for (const line of jsonlText.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			void err; // truncated / non-JSON line — skip it
			continue;
		}
		// Transcript lines are untyped JSON (provider-specific shapes); every
		// field read below is individually type-checked, so this is only a
		// structural gate (reject non-object rows), not a full schema.
		if (!isJsonObject(parsed)) continue;
		const entry = parsed;
		m.transcript_entries += 1;
		foldTimestamp(entry.timestamp, m);
		const message = entry.message;
		if (entry.type === "assistant" && isJsonObject(message)) {
			foldAssistantEntry(message, m);
		}
		foldCodexEntry(entry, m);
	}
	m.duration_ms = spanMs(m.first_ts, m.last_ts);
	return m;
}
