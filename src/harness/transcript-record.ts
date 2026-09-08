// ===========================================
// Transcript record parser — one source of truth for turning a Claude Code
// transcript JSONL entry into categorized, time-stamped, model-labeled records.
// ===========================================
// Claude Code writes a full-fidelity transcript per session at
// ~/.claude/projects/<slug>/<session>.jsonl. Every turn lives there: user
// prompts, assistant TEXT messages (the natural-language replies the terminal
// shows but which NO hook event carries), assistant thinking, tool calls, and
// tool results — each with a `timestamp`, `uuid`, and (assistant turns) a
// `message.model`.
//
// The daemon's hook pipeline only fires on TOOL events, so assistant messages
// never reached activity.jsonl / collection.jsonl. This module is the shared
// parser used by BOTH the live capture (cursor-tailed on every daemon event,
// including Stop, in `timeline-capture.ts`) and the backfill (whole-file,
// time-sorted). One content block → one record, so the stream stays
// categorized and searchable.
//
// Scrub policy mirrors the existing capture: natural-language fields
// (prompt / message / thinking) are scrubbed for secrets + PII; tool input and
// tool-result content are left RAW — parity with thinking-capture's deliberate
// tool-I/O decision (see project_thinking_capture_full_fidelity), and the
// canonical full tool copy lives in collection.jsonl regardless.

import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { redactPii, scrubSecrets } from "../lib/secrets.js";

/** The categories a transcript entry decomposes into — one per content block. */
export type TimelineCategory =
	| "user_prompt"
	| "agent_message"
	| "agent_thinking"
	| "tool_use"
	| "tool_result";

/** A single categorized timeline record (one content block of one transcript
 *  entry). `${uuid}#${seq}` is the stable dedup key across re-runs. Optional
 *  fields carry `| undefined` so a present-but-absent transcript field (cwd,
 *  model, …) round-trips cleanly under exactOptionalPropertyTypes; JSON
 *  serialization drops the undefined keys. */
export interface TimelineRecord {
	schema: "timeline.v1";
	ts: string;
	session: string;
	uuid: string;
	seq: number;
	category: TimelineCategory;
	/** Which model provider produced this record. Absent on the earliest Claude
	 *  rows is read as "claude-code"; Codex rollout capture stamps "codex". One
	 *  normalized store across providers (cross-model analysis / distillation). */
	provider?: "claude-code" | "codex" | undefined;
	role: "user" | "assistant";
	/** Subagent attribution: the `agentId` a sidechain transcript entry
	 *  carries (absent for main-session turns). Sidechain entries keep the
	 *  PARENT's sessionId, so this is the only field that distinguishes a
	 *  subagent's turns from the parent's in the merged timeline. */
	agent_id?: string | undefined;
	model?: string | undefined;
	text?: string | undefined;
	tool_name?: string | undefined;
	tool_input?: unknown;
	tool_use_id?: string | undefined;
	is_error?: boolean;
	cwd?: string | undefined;
	git_branch?: string | undefined;
	version?: string | undefined;
	scrubbed?: boolean;
	/** True on a SIDECHAIN entry — a spawned agent's turn. Paired with
	 *  `agent_id` it distinguishes agent work from the parent's without
	 *  needing the agent-id join. */
	is_sidechain?: boolean | undefined;
	/** The runner's prompt / request correlation ids for this entry. `prompt_id`
	 *  groups an agent's turns under the prompt that started them; `request_id`
	 *  is the per-round-trip API id (the join key to provider-side records). */
	prompt_id?: string | undefined;
	request_id?: string | undefined;
	/** Reasoning-effort tier the runner ran this turn at. */
	effort?: string | undefined;
	/** Permission mode in force (`bypassPermissions`, `acceptEdits`, …). */
	permission_mode?: string | undefined;
	/** The runner's own attribution label for the acting agent. */
	attribution_agent?: string | undefined;
	/** Stable parent thread/agent identity for a spawned actor, when reported. */
	parent_agent?: string | undefined;
	/** Why a tool call was denied, when the runner refused one. */
	tool_denial_kind?: string | undefined;
	/** The runner's STRUCTURED tool result (diffs, exit codes, file metadata) —
	 *  strictly richer than the flattened `text`, and captured nowhere else.
	 *  Serialized-size-capped; `tool_use_result_truncated` marks a drop. */
	tool_use_result?: unknown;
	tool_use_result_truncated?: boolean;
	/** Token usage for the assistant turn this record came from. Attached to
	 *  the entry's FIRST record only, so summing over the timeline does not
	 *  double-count an entry that decomposed into several blocks. */
	usage?: TimelineUsage | undefined;
}

/** Per-turn token usage as the transcript reports it. */
interface TimelineUsage {
	input?: number | undefined;
	output?: number | undefined;
	cache_read?: number | undefined;
	cache_creation?: number | undefined;
}

/** The shared per-entry fields every record off one transcript line inherits. */
type RecordBase = Pick<
	TimelineRecord,
	| "schema"
	| "ts"
	| "session"
	| "uuid"
	| "provider"
	| "agent_id"
	| "cwd"
	| "git_branch"
	| "version"
	| "is_sidechain"
	| "prompt_id"
	| "request_id"
	| "effort"
	| "permission_mode"
	| "attribution_agent"
>;

/** Cap on the serialized structural tool result kept per record. */
export const MAX_TOOL_USE_RESULT_BYTES = 32 * 1024;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function readEntryMetadata(entry: JsonObject): Omit<RecordBase, "schema" | "ts" | "session" | "uuid" | "provider"> {
	const metadata: Omit<RecordBase, "schema" | "ts" | "session" | "uuid" | "provider"> = {};
	const fields = [
		["agent_id", entry.agentId], ["cwd", entry.cwd], ["git_branch", entry.gitBranch],
		["version", entry.version], ["prompt_id", entry.promptId], ["request_id", entry.requestId],
		["effort", entry.effort], ["permission_mode", entry.permissionMode],
		["attribution_agent", entry.attributionAgent],
	] as const;
	for (const [key, value] of fields) {
		if (typeof value === "string") metadata[key] = value;
	}
	if (typeof entry.isSidechain === "boolean") metadata.is_sidechain = entry.isSidechain;
	return metadata;
}

/** Secrets + PII scrub for natural-language fields. */
function scrubText(text: string): string {
	return redactPii(scrubSecrets(text).text).text;
}

/** The plain text of one tool_result content element (a bare string, or a
 *  `{text}` block). RAW — not scrubbed (tool-I/O parity). */
function blockText(b: unknown): string {
	if (typeof b === "string") return b;
	return isJsonObject(b) && typeof b.text === "string" ? b.text : "";
}

/** Flatten a tool_result `content` (string | block[]) to a plain string. RAW —
 *  not scrubbed (tool-I/O parity; the full copy lives in collection.jsonl). */
function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(blockText)
		.filter((s) => s.length > 0)
		.join("\n");
}

/** Records for a `user` entry: a bare-string prompt, or text-prompt + tool_result blocks. */
function userRecords(base: RecordBase, content: unknown): TimelineRecord[] {
	const out: TimelineRecord[] = [];
	if (typeof content === "string") {
		if (content.trim()) out.push({ ...base, seq: 0, category: "user_prompt", role: "user", text: scrubText(content), scrubbed: true });
		return out;
	}
	if (!Array.isArray(content)) return out;
	content.forEach((b, seq) => {
		if (!isJsonObject(b)) return;
		if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
			out.push({ ...base, seq, category: "user_prompt", role: "user", text: scrubText(b.text), scrubbed: true });
			return;
		}
		if (b.type !== "tool_result") return;
		const flat = flattenContent(b.content);
		const record: TimelineRecord = {
			...base, seq, category: "tool_result", role: "user",
			text: flat.length > 0 ? flat : undefined,
		};
		if (typeof b.tool_use_id === "string") record.tool_use_id = b.tool_use_id;
		if (b.is_error === undefined) record.is_error = false;
		else if (typeof b.is_error === "boolean") record.is_error = b.is_error;
		out.push(record);
	});
	return out;
}

/** Records for an `assistant` entry: message text, thinking, and tool calls. */
function assistantRecords(base: RecordBase, content: unknown, model: string | undefined): TimelineRecord[] {
	const out: TimelineRecord[] = [];
	if (!Array.isArray(content)) return out;
	const modelFields = model === undefined ? {} : { model };
	content.forEach((b, seq) => {
		if (!isJsonObject(b)) return;
		if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
			out.push({ ...base, ...modelFields, seq, category: "agent_message", role: "assistant", text: scrubText(b.text), scrubbed: true });
			return;
		}
		if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
			out.push({ ...base, ...modelFields, seq, category: "agent_thinking", role: "assistant", text: scrubText(b.thinking), scrubbed: true });
			return;
		}
		if (b.type !== "tool_use") return;
		const record: TimelineRecord = { ...base, ...modelFields, seq, category: "tool_use", role: "assistant", tool_input: b.input };
		if (typeof b.name === "string") record.tool_name = b.name;
		if (typeof b.id === "string") record.tool_use_id = b.id;
		out.push(record);
	});
	return out;
}

/**
 * Parse one transcript JSONL entry into zero or more categorized records.
 * Pure; returns [] for any entry missing ts/uuid/session or of an unhandled
 * type. Block index drives `seq` so `${uuid}#${seq}` is a stable dedup key
 * across re-runs. Public API — consumed by `timeline-capture.ts` (live) and the
 * backfill command.
 */
export function parseTranscriptEntry(entry: unknown): TimelineRecord[] {
	if (!isJsonObject(entry)) return [];
	if (!isNonEmptyString(entry.timestamp) || !isNonEmptyString(entry.uuid) || !isNonEmptyString(entry.sessionId)) return [];
	if (!isJsonObject(entry.message)) return [];
	const base: RecordBase = {
		schema: "timeline.v1",
		ts: entry.timestamp,
		session: entry.sessionId,
		uuid: entry.uuid,
		provider: "claude-code",
		...readEntryMetadata(entry),
	};
	if (entry.type === "user") return attachEntryExtras(userRecords(base, entry.message.content), entry);
	if (entry.type === "assistant") {
		const model = typeof entry.message.model === "string" ? entry.message.model : undefined;
		return attachEntryExtras(assistantRecords(base, entry.message.content, model), entry);
	}
	return [];
}

/** Serialize the runner's structural tool result, capped. Returns the value
 *  itself when it fits, a truncated JSON prefix when it does not, and null
 *  when the entry carries none / it is not serializable. */
export function capToolUseResult(value: unknown): { value: unknown; truncated: boolean } | null {
	if (value === undefined || value === null) return null;
	try {
		const json = JSON.stringify(value);
		if (typeof json !== "string") return null;
		if (json.length <= MAX_TOOL_USE_RESULT_BYTES) return { value, truncated: false };
		return { value: `${json.slice(0, MAX_TOOL_USE_RESULT_BYTES)}…`, truncated: true };
	} catch (err) {
		void err; // circular / non-serializable — record nothing rather than throw
		return null;
	}
}

/** Read `message.usage` into the compact timeline shape; null when absent. */
export function readUsage(message: unknown): TimelineUsage | null {
	if (!isJsonObject(message) || !isJsonObject(message.usage)) return null;
	const u = message.usage;
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;
	const out: TimelineUsage = {
		input: num(u.input_tokens),
		output: num(u.output_tokens),
		cache_read: num(u.cache_read_input_tokens),
		cache_creation: num(u.cache_creation_input_tokens),
	};
	return Object.values(out).some((v) => v !== undefined) ? out : null;
}

/** Attach the entry-level extras that belong to specific records: the denial
 *  kind and structural result onto tool_result rows, and token usage onto the
 *  FIRST record only (so summing the timeline never double-counts an entry
 *  that decomposed into several blocks). */
function attachEntryExtras(records: TimelineRecord[], e: JsonObject): TimelineRecord[] {
	if (records.length === 0) return records;
	const capped = capToolUseResult(e.toolUseResult);
	for (const record of records) {
		if (record.category !== "tool_result") continue;
		if (typeof e.toolDenialKind === "string" && e.toolDenialKind) record.tool_denial_kind = e.toolDenialKind;
		if (!capped) continue;
		record.tool_use_result = capped.value;
		if (capped.truncated) record.tool_use_result_truncated = true;
	}
	const usage = readUsage(e.message);
	if (usage && records[0]) records[0].usage = usage;
	return records;
}

/**
 * Parse a whole transcript file's text into records, in file order. Skips
 * blank/truncated lines. Never throws. Public API — consumed by the backfill
 * command.
 */
export function parseTranscriptText(text: string): TimelineRecord[] {
	const out: TimelineRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(...parseTranscriptEntry(JSON.parse(line)));
		} catch (err) {
			void err; // truncated / non-JSON line — skip (a partial final line is normal)
		}
	}
	return out;
}
