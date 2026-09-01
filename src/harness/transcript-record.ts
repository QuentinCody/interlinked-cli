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

/** Structural view of a transcript JSONL entry — only the fields we read. */
interface TranscriptEntry {
	type?: string;
	uuid?: string;
	timestamp?: string;
	sessionId?: string;
	agentId?: string;
	cwd?: string;
	gitBranch?: string;
	version?: string;
	isSidechain?: boolean;
	promptId?: string;
	requestId?: string;
	effort?: string;
	permissionMode?: string;
	attributionAgent?: string;
	toolDenialKind?: string;
	toolUseResult?: unknown;
	message?: { role?: string; model?: string; content?: unknown; usage?: unknown };
}

/** Structural view of a content block (assistant or user message content). */
interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	is_error?: boolean;
	content?: unknown;
}

/** Secrets + PII scrub for natural-language fields. */
function scrubText(text: string): string {
	return redactPii(scrubSecrets(text).text).text;
}

/** The plain text of one tool_result content element (a bare string, or a
 *  `{text}` block). RAW — not scrubbed (tool-I/O parity). */
function blockText(b: unknown): string {
	if (typeof b === "string") return b;
	// SAFETY: a transcript content element is untyped JSON; only the optional
	// `text` string is read, guarded by the typeof below.
	const text = (b as ContentBlock | null)?.text;
	return typeof text === "string" ? text : "";
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
		if (content.trim()) {
			out.push({ ...base, seq: 0, category: "user_prompt", role: "user", text: scrubText(content), scrubbed: true });
		}
		return out;
	}
	if (!Array.isArray(content)) return out;
	content.forEach((raw, i) => {
		// SAFETY: untyped JSON block that may legitimately contain `null`
		// elements (adversarial/malformed transcripts) — every field read
		// below is type-guarded first.
		const b = raw as ContentBlock | null;
		if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
			out.push({ ...base, seq: i, category: "user_prompt", role: "user", text: scrubText(b.text), scrubbed: true });
		} else if (b?.type === "tool_result") {
			const flat = flattenContent(b.content);
			out.push({
				...base,
				seq: i,
				category: "tool_result",
				role: "user",
				tool_use_id: b.tool_use_id,
				is_error: b.is_error === true,
				text: flat.length > 0 ? flat : undefined,
			});
		}
	});
	return out;
}

/** Records for an `assistant` entry: message text, thinking, and tool calls. */
function assistantRecords(base: RecordBase, content: unknown, model: string | undefined): TimelineRecord[] {
	const out: TimelineRecord[] = [];
	if (!Array.isArray(content)) return out;
	content.forEach((raw, i) => {
		// SAFETY: untyped JSON block that may legitimately contain `null`
		// elements (adversarial/malformed transcripts) — every field read
		// below is type-guarded first.
		const b = raw as ContentBlock | null;
		if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
			out.push({ ...base, seq: i, category: "agent_message", role: "assistant", model, text: scrubText(b.text), scrubbed: true });
		} else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
			out.push({ ...base, seq: i, category: "agent_thinking", role: "assistant", model, text: scrubText(b.thinking), scrubbed: true });
		} else if (b?.type === "tool_use") {
			out.push({ ...base, seq: i, category: "tool_use", role: "assistant", model, tool_name: b.name, tool_input: b.input, tool_use_id: b.id });
		}
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
	if (!entry || typeof entry !== "object") return [];
	// SAFETY: a transcript line is untyped JSON; TranscriptEntry covers only the
	// optional fields read here, each guarded before use.
	const e = entry as TranscriptEntry;
	if (!e.timestamp || !e.uuid || !e.sessionId) return [];
	const base: RecordBase = {
		schema: "timeline.v1",
		ts: e.timestamp,
		session: e.sessionId,
		uuid: e.uuid,
		provider: "claude-code",
		agent_id: e.agentId,
		cwd: e.cwd,
		git_branch: e.gitBranch,
		version: e.version,
		is_sidechain: typeof e.isSidechain === "boolean" ? e.isSidechain : undefined,
		prompt_id: e.promptId,
		request_id: e.requestId,
		effort: e.effort,
		permission_mode: e.permissionMode,
		attribution_agent: e.attributionAgent,
	};
	if (e.type === "user") return attachEntryExtras(userRecords(base, e.message?.content), e);
	if (e.type === "assistant") {
		return attachEntryExtras(assistantRecords(base, e.message?.content, e.message?.model), e);
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
export function readUsage(message: TranscriptEntry["message"]): TimelineUsage | null {
	const usage = message?.usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
	// SAFETY: guarded above as a non-array object; every field is typeof-checked below.
	const u = usage as Record<string, unknown>;
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
function attachEntryExtras(records: TimelineRecord[], e: TranscriptEntry): TimelineRecord[] {
	if (records.length === 0) return records;
	const capped = capToolUseResult(e.toolUseResult);
	for (const record of records) {
		if (record.category !== "tool_result") continue;
		if (e.toolDenialKind) record.tool_denial_kind = e.toolDenialKind;
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
