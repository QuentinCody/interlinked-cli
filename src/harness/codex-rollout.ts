// ===========================================
// Codex rollout parser — normalize an OpenAI Codex session transcript into the
// SAME `timeline.v1` records Claude sessions produce (transcript-record.ts).
// ===========================================
// Codex writes a full-fidelity session per `codex exec` / interactive run at
// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl — one JSONL entry per
// event: `session_meta` (session id, cwd, provider, git), `response_item`
// (the model I/O: developer/user/assistant `message`s, `function_call` /
// `custom_tool_call` and their `*_output`s), and `event_msg` (streamed
// `agent_message` commentary, task lifecycle). The sub review loop
// (codex-review-loop.mjs) is the driver, but this parser is provider-agnostic:
// any Codex session — human- or agent-driven — normalizes the same way, so
// every model's input+output lands in one store for later analysis /
// distillation (project ask 2026-07-18).
//
// Scrub parity with the Claude parser: natural-language text (prompt / message /
// commentary) is secret+PII scrubbed; tool input and tool-result content are
// left RAW. Dedup key `${uuid}#${seq}` uses `codex:<session>:<lineIndex>` — the
// rollout is append-only, so a line's index is stable across re-parses.

import { isJsonObject } from "../lib/json-types.js";
import { redactPii, scrubSecrets } from "../lib/secrets.js";
import type { TimelineCategory, TimelineRecord } from "./transcript-record.js";

/** Secrets + PII scrub for natural-language fields. */
function scrubText(text: string): string {
	return redactPii(scrubSecrets(text).text).text;
}

/** Structural view of a Codex rollout JSONL entry — only fields we read. */
interface CodexEntry {
	timestamp?: string;
	type?: string;
	payload?: CodexPayload;
}
interface CodexPayload {
	type?: string;
	role?: string;
	content?: unknown;
	name?: string;
	arguments?: string;
	input?: unknown;
	call_id?: string;
	id?: string;
	output?: unknown;
	source?: unknown;
	message?: string;
	model?: string;
	session_id?: string;
	cwd?: string;
}

/** Session-level context gathered from `session_meta` + the first `model` seen. */
interface CodexContext {
	session: string;
	model: string | undefined;
	cwd: string | undefined;
	agentId: string | undefined;
	attributionAgent: string | undefined;
	parentAgent: string | undefined;
	isSidechain: boolean | undefined;
}

/** Flatten a Codex content array (`[{type:"input_text"|"output_text", text}]`)
 *  or a bare string to plain text. */
function flattenCodexContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => {
			if (typeof b === "string") return b;
			// SAFETY: untyped JSON block; only the optional `text` string is read.
			const t = (b as { text?: unknown } | null)?.text;
			return typeof t === "string" ? t : "";
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

const CODEX_PAYLOAD_STRING_FIELDS = [
	"type",
	"role",
	"name",
	"arguments",
	"call_id",
	"id",
	"message",
	"model",
	"session_id",
	"cwd",
] as const satisfies ReadonlyArray<keyof CodexPayload>;

/** `content`/`input`/`output` are declared `unknown` on `CodexPayload`
 *  itself (tool input/result content is intentionally left RAW — see the
 *  file header), so they pass through with no shape check; only the string
 *  fields need validating. */
function parseCodexPayload(value: unknown): CodexPayload | undefined {
	if (!isJsonObject(value)) return undefined;
	const out: CodexPayload = {};
	for (const key of CODEX_PAYLOAD_STRING_FIELDS) {
		const v = value[key];
		if (typeof v === "string") out[key] = v;
	}
	if (value.content !== undefined) out.content = value.content;
	if (value.input !== undefined) out.input = value.input;
	if (value.output !== undefined) out.output = value.output;
	if (value.source !== undefined) out.source = value.source;
	return out;
}

/** Replaces `JSON.parse(line) as CodexEntry` — an unchecked cast. Every
 *  `CodexEntry` field is optional, so the old cast's only real gap was a
 *  wrong-TYPED `timestamp`/`type` flowing into `TimelineRecord` unchecked
 *  (e.g. a numeric timestamp landing in a `string` field); a malformed
 *  top-level value (non-object, or literal `null`) already produced zero
 *  records under the old code too, via the `if (e)` / `e?.payload` guards
 *  downstream — replayed against 12600+ real ~/.codex/sessions/**\/*.jsonl
 *  rows with zero divergences (scratch/fleet-r2/probe-b8-codex-rollout-replay.mts). */
function parseCodexEntry(value: unknown): CodexEntry | null {
	if (!isJsonObject(value)) return null;
	const out: CodexEntry = {};
	if (typeof value.timestamp === "string") out.timestamp = value.timestamp;
	if (typeof value.type === "string") out.type = value.type;
	const payload = parseCodexPayload(value.payload);
	if (payload !== undefined) out.payload = payload;
	return out;
}

/** One safe JSON.parse of a rollout line, or null. */
function parseLine(line: string): CodexEntry | null {
	try {
		return parseCodexEntry(JSON.parse(line));
	} catch {
		return null;
	}
}

/** Scan for the session id / cwd (`session_meta`) and the model slug (recorded on
 *  a later entry, not on `session_meta`). One linear pass, no records emitted. */
function codexThreadSpawn(
	source: unknown,
): {
	agentPath: string | undefined;
	nickname: string | undefined;
	parentThreadId: string | undefined;
} | null {
	if (!isJsonObject(source)) return null;
	const subagent = source.subagent;
	if (!isJsonObject(subagent)) return null;
	const threadSpawn = subagent.thread_spawn;
	if (!isJsonObject(threadSpawn)) return null;
	const agentPath = typeof threadSpawn.agent_path === "string" ? threadSpawn.agent_path : undefined;
	const nickname = typeof threadSpawn.agent_nickname === "string"
		? threadSpawn.agent_nickname
		: undefined;
	const parentThreadId = typeof threadSpawn.parent_thread_id === "string"
		? threadSpawn.parent_thread_id
		: undefined;
	return agentPath || nickname || parentThreadId
		? { agentPath, nickname, parentThreadId }
		: null;
}

function consumeSessionMeta(payload: CodexPayload, ctx: CodexContext): void {
	if (typeof payload.id === "string") ctx.session = payload.id;
	else if (typeof payload.session_id === "string") ctx.session = payload.session_id;
	if (typeof payload.cwd === "string") ctx.cwd = payload.cwd;
	const spawn = codexThreadSpawn(payload.source);
	if (!spawn) return;
	ctx.agentId = ctx.session || undefined;
	ctx.attributionAgent = spawn.agentPath ?? spawn.nickname;
	ctx.parentAgent = spawn.parentThreadId;
	ctx.isSidechain = true;
}

function scanContext(entries: (CodexEntry | null)[]): CodexContext {
	const ctx: CodexContext = {
		session: "",
		model: undefined,
		cwd: undefined,
		agentId: undefined,
		attributionAgent: undefined,
		parentAgent: undefined,
		isSidechain: undefined,
	};
	let sessionMetaSeen = false;
	for (const e of entries) {
		const p = e?.payload;
		if (!p) continue;
		if (e.type === "session_meta" && !sessionMetaSeen) {
			sessionMetaSeen = true;
			consumeSessionMeta(p, ctx);
		}
		if (ctx.model === undefined && typeof p.model === "string" && p.model) {
			ctx.model = p.model;
		}
	}
	return ctx;
}

type RecordBase = Pick<
	TimelineRecord,
	| "schema"
	| "ts"
	| "session"
	| "uuid"
	| "provider"
	| "cwd"
	| "agent_id"
	| "is_sidechain"
	| "attribution_agent"
	| "parent_agent"
>;

/** Build one record with the shared base + category-specific fields. */
function record(
	base: RecordBase,
	seq: number,
	category: TimelineCategory,
	role: "user" | "assistant",
	extra: Partial<TimelineRecord>,
): TimelineRecord {
	return { ...base, seq, category, role, ...extra };
}

/** Records for a Codex `message` response item (the model's prompt or reply). A
 *  developer/user/system role is INPUT to the model → user_prompt; assistant is
 *  the model's OUTPUT → agent_message. */
function messageRecords(base: RecordBase, p: CodexPayload, model: string | undefined): TimelineRecord[] {
	const text = flattenCodexContent(p.content);
	if (!text.trim()) return [];
	if (p.role === "assistant") {
		return [record(base, 0, "agent_message", "assistant", { model, text: scrubText(text), scrubbed: true })];
	}
	return [record(base, 0, "user_prompt", "user", { text: scrubText(text), scrubbed: true })];
}

/** Record for a tool CALL (`function_call` / `custom_tool_call`). Tool input is
 *  RAW (parity with the Claude parser). */
function toolUseRecord(base: RecordBase, p: CodexPayload, model: string | undefined): TimelineRecord[] {
	const input = p.arguments ?? p.input;
	return [
		record(base, 0, "tool_use", "assistant", {
			model,
			tool_name: p.name,
			tool_input: input,
			tool_use_id: p.call_id ?? p.id,
		}),
	];
}

/** Record for a tool RESULT (`*_output`). Content is RAW. */
function toolResultRecord(base: RecordBase, p: CodexPayload): TimelineRecord[] {
	const flat = flattenCodexContent(p.output);
	return [
		record(base, 0, "tool_result", "user", {
			tool_use_id: p.call_id,
			text: flat.length > 0 ? flat : undefined,
		}),
	];
}

/** Map one Codex entry to zero or more `timeline.v1` records. */
function entryRecords(e: CodexEntry, ctx: CodexContext, lineIndex: number): TimelineRecord[] {
	const p = e.payload;
	if (!e.timestamp || !p) return [];
	const base: RecordBase = {
		schema: "timeline.v1",
		ts: e.timestamp,
		session: ctx.session,
		uuid: `codex:${ctx.session}:${lineIndex}`,
		provider: "codex",
		cwd: ctx.cwd,
		agent_id: ctx.agentId,
		is_sidechain: ctx.isSidechain,
		attribution_agent: ctx.attributionAgent,
		parent_agent: ctx.parentAgent,
	};
	if (e.type === "response_item") {
		if (p.type === "message") return messageRecords(base, p, ctx.model);
		if (p.type === "function_call" || p.type === "custom_tool_call") return toolUseRecord(base, p, ctx.model);
		if (p.type === "function_call_output" || p.type === "custom_tool_call_output") return toolResultRecord(base, p);
		return [];
	}
	// Streamed reasoning/commentary — captured as thinking (distinct from the
	// final assistant `message` response item, so nothing is double-counted).
	if (e.type === "event_msg" && p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
		return [record(base, 0, "agent_thinking", "assistant", { model: ctx.model, text: scrubText(p.message), scrubbed: true })];
	}
	return [];
}

/**
 * Parse a whole Codex rollout file's text into `timeline.v1` records, in file
 * order. Returns [] if no `session_meta` session id is found. Never throws.
 */
export function parseCodexRolloutText(text: string): TimelineRecord[] {
	const entries = text.split("\n").map((l) => (l.trim() ? parseLine(l) : null));
	const ctx = scanContext(entries);
	if (!ctx.session) return [];
	const out: TimelineRecord[] = [];
	entries.forEach((e, i) => {
		if (e) out.push(...entryRecords(e, ctx, i));
	});
	return out;
}
