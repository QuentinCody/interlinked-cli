// ===========================================
// agent-io.v1 — durable sub-agent I/O record shape
// ===========================================
// Spec: docs/design/agent-io-capture.md §4.1. A PROJECTION store, in the same
// sense collection.jsonl is one for tool events: it does not replace the
// sources (activity.jsonl, collection.jsonl, timeline.jsonl), it is the one
// place a reader goes for "what was agent X told, and what did it return",
// with provenance back to whichever source supplied each row.
//
// Why a separate store rather than a wider `AgentEventRecord`: that record is
// a LIFECYCLE row (one per hook event, three kinds, already carrying a metrics
// blob). Sub-agent I/O has a different cardinality (one row per direction,
// several output rows per agent) and a different size class (multi-KB, often
// blob-referenced), and a spawn-tool row exists BEFORE any `subagent_id` does.
//
// Why not timeline.jsonl: it is transcript-derived and keyed `uuid#seq`, so it
// can only ever hold what a Claude-shaped transcript contains. Codex spawn
// rows, Cursor task text and background rosters have no transcript and hence
// no uuid — a store that structurally excludes three of five runners cannot be
// the cross-runner store.

/** Which way the content flowed relative to the sub-agent. */
export type AgentIoDirection = "input" | "output";

/** What the row holds. `task_label` is the Codex case: a plaintext task NAME
 *  when the task TEXT is encrypted at the runner boundary. */
export type AgentIoKind =
	| "spawn_prompt"
	| "task_label"
	| "interim_message"
	| "final_message"
	| "structured_result";

/** Which capture surface supplied the row. */
export type AgentIoSource = "spawn_tool" | "payload" | "transcript" | "structured_output";

/**
 * Whether the content is really here.
 *
 * This is the field that makes an off-boundary runner REPRESENTABLE rather
 * than silently absent. A Codex `spawn_agent` writes a `task_label` row with
 * the plaintext name AND a `spawn_prompt` row with `content: null` and
 * `content_status: "encrypted_by_runner"`. Absence is then recorded as a fact,
 * the same discipline `metrics: null` already uses on `AgentEventRecord`
 * ("not measured" ≠ "did nothing").
 */
export type AgentIoContentStatus = "captured" | "encrypted_by_runner" | "unavailable";

/** How `agent_label` was resolved. Superset of collection's `AgentTypeSource`
 *  — a label can also come from the spawn CALL, which fires before any
 *  SubagentStart exists. */
export type AgentIoLabelSource = "payload" | "start_event" | "spawn_tool";

/** Token totals carried over from the transcript metrics, when they were
 *  read. Null when the transcript was unreachable — never zeroed. */
export interface AgentIoTokens {
	input: number;
	output: number;
	cache_read: number;
	cache_creation: number;
}

/** One durable sub-agent I/O record. */
export interface AgentIoRecord {
	schema: "agent-io.v1";
	ts: string;
	/** Per-session ordinal minted by the daemon; null off the daemon path. */
	seq: number | null;
	/** The session the hook was delivered under. */
	session: string | null;
	/** Set only when the runner distinguishes it; null on Claude, whose
	 *  sidechain entries reuse the parent session id. */
	parent_session: string | null;
	/** subagent_id / agent_id / timeline agent_id — one id space. */
	agent_id: string | null;
	/** The spawn CALL's tool_use id — the bridge between the spawn row and the
	 *  lifecycle rows (design F6). Null when unknown. */
	spawn_tool_use_id: string | null;
	agent_label: string | null;
	agent_label_source: AgentIoLabelSource | null;
	/** claude-code | codex | cursor | copilot | gemini-cli */
	runner: string;
	direction: AgentIoDirection;
	role: "user" | "assistant";
	kind: AgentIoKind;
	source: AgentIoSource;
	/** Inline when the scrubbed content is <= INLINE_MAX_BYTES; else null and
	 *  `content_ref` points at the blob. */
	content: string | null;
	/** `blobs/<sha256>`, relative to the agent-io directory. */
	content_ref: string | null;
	/** sha256 of the bytes actually STORED (scrubbed, post-truncation). Always
	 *  set — it is the dedup + integrity key a projection store otherwise
	 *  lacks, and it is what makes re-drain and backfill idempotent. */
	content_sha256: string;
	/** Size of the scrubbed content BEFORE any truncation. */
	content_bytes: number;
	truncated: boolean;
	content_status: AgentIoContentStatus;
	/** HONEST-BOUNDARY marker. False when this direction is structurally
	 *  unreachable for the runner (Codex encrypts the spawn message; Gemini and
	 *  Copilot fire no subagent hook). The row still exists so the observability
	 *  gap is visible in the store rather than hidden by an absent row. */
	input_capturable: boolean;
	/** Why `input_capturable` is false. Null when it is true. */
	uncapturable_reason: string | null;
	scrubbed: boolean;
	redaction_passes: string[];
	tokens: AgentIoTokens | null;
	/** Output rows only — the join key back to activity.jsonl (a sub-agent's
	 *  tool calls reach the guard under the PARENT session id). */
	tool_use_ids: string[] | null;
	tool_use_ids_truncated: boolean;
	cwd: string | null;
	/** Always false on a PERSISTED row: a dry-run event writes nothing at all
	 *  (design §4.1, CLAUDE.md "a dry run must not move the gate"). The field is
	 *  kept so a reader never has to infer it from absence. */
	dry_run: boolean;
}

/** Inline ceiling — parity with `FINAL_MESSAGE_MAX_CHARS`. */
export const INLINE_MAX_BYTES = 65_536;

/** HEAD read of an agent transcript when hunting the first user message. The
 *  mirror of `FINAL_MESSAGE_TAIL_BYTES`, and the fix for the design's F3: the
 *  spawn prompt is the transcript's FIRST entry, so a tail read loses exactly
 *  the longest agents' prompts. */
export const PROMPT_HEAD_BYTES = 256 * 1024;

/** Cap on `tool_use_ids` per row — mirrors `agent-metrics.ts`. */
export const MAX_TOOL_USE_IDS = 2_000;

/** One agent's return must not become a second transcript. */
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** Terminal tool calls that ARE the agent's return value. `lastAssistantText`
 *  walks back for `type:"text"` only, so an agent that returns through one of
 *  these has its real return dropped (design F4: captured final-message p50 is
 *  56 chars while the actual return is ~3 KB). */
export const RETURN_VERB_TOOLS: ReadonlySet<string> = new Set([
	"StructuredOutput",
	"ReportFindings",
]);

/** Tool names that SPAWN a sub-agent, per runner. The prompt is on the
 *  PreToolUse payload of these calls and nowhere else at spawn time. */
export const SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set([
	"Agent",
	"Task",
	"collaborationspawn_agent",
	"collaborationfollowup_task",
	"spawn_agent",
	"followup_task",
]);

// `isEncryptedByRunner` (Fernet-token detection) and `runnerForSource`
// (agent_source -> runner label) were removed 2026-09-02: both existed only
// to support the now-deleted capture.ts, and had zero other callers. Rebuild
// from docs/design/agent-io-capture.md when the capture rollout resumes.
