// interlinked-tdd: exempt
// ===========================================
// Collection v1 — Canonical provider-agnostic tool activity schema
// ===========================================
// See docs/design/normalized-collection-layer.md for the full design.

// --- Tool Classes ---

export type ToolClass =
	| "shell_exec"
	| "file_read"
	| "file_edit"
	| "file_write"
	| "file_delete"
	| "search"
	| "mcp_call"
	| "fetch"
	| "task"
	| "notebook_edit"
	| "other";

// --- Per-class Action shapes ---

interface ShellExecAction {
	command: string;
	cwd?: string | null;
}

interface FileReadAction {
	path: string;
	offset?: number | null;
	limit?: number | null;
}

export interface FileEditAction {
	path: string;
	diff: { hunks: Array<{ old: string; new: string }>; unified?: string | null };
}

interface FileWriteAction {
	path: string;
	content?: string | null;
	content_ref?: string | null;
	is_new_file?: boolean;
}

interface FileDeleteAction {
	path: string;
}

interface SearchAction {
	pattern: string;
	path?: string | null;
	flags?: string | null;
}

interface McpCallAction {
	server?: string | null;
	tool: string;
	params?: unknown;
	params_ref?: string | null;
}

interface FetchAction {
	url: string;
	prompt?: string | null;
}

interface TaskAction {
	task: string;
	params?: unknown;
}

interface NotebookEditAction {
	path: string;
	cell?: string | null;
	diff?: unknown;
}

export interface OtherAction {
	provider_input?: unknown;
	provider_input_ref?: string | null;
}

export type CollectionAction =
	| ShellExecAction
	| FileReadAction
	| FileEditAction
	| FileWriteAction
	| FileDeleteAction
	| SearchAction
	| McpCallAction
	| FetchAction
	| TaskAction
	| NotebookEditAction
	| OtherAction;

// --- Per-class Observation shapes ---

export interface ShellExecObservation {
	stdout?: string | null;
	stderr?: string | null;
	exit_code?: number | null;
	duration_ms?: number | null;
	combined_output?: boolean;
}

export interface FileReadObservation {
	content?: string | null;
	content_ref?: string | null;
	line_count?: number | null;
	byte_count?: number | null;
}

export interface FileEditObservation {
	applied: boolean;
	result_message?: string | null;
	provider_echo_ref?: string | null;
}

export interface FileWriteObservation {
	applied: boolean;
	result_message?: string | null;
	provider_echo_ref?: string | null;
}

export interface FileDeleteObservation {
	deleted: boolean;
	result_message?: string | null;
}

export interface SearchObservation {
	matches?: unknown;
	match_count?: number | null;
	result_text?: string | null;
}

export interface McpCallObservation {
	result?: unknown;
	result_ref?: string | null;
}

export interface FetchObservation {
	status?: number | null;
	result?: unknown;
	result_ref?: string | null;
	bytes?: number | null;
}

export interface TaskObservation {
	result?: unknown;
}

export interface NotebookEditObservation {
	applied: boolean;
	result_message?: string | null;
}

export interface OtherObservation {
	provider_output?: unknown;
	provider_output_ref?: string | null;
}

export type CollectionObservation =
	| ShellExecObservation
	| FileReadObservation
	| FileEditObservation
	| FileWriteObservation
	| FileDeleteObservation
	| SearchObservation
	| McpCallObservation
	| FetchObservation
	| TaskObservation
	| NotebookEditObservation
	| OtherObservation;

// --- Fidelity ---

export type CompletenessValue =
	| "complete"
	| "provider_truncated"
	| "interlinked_capped"
	| "absent"
	| "redacted"
	| "unknown";

export interface FieldFidelity {
	source: "provider_hook";
	provider_truncated: boolean | "unknown";
	interlinked_capped: boolean;
	provider_payload_bytes: number;
	captured_bytes: number;
	completeness: CompletenessValue;
}

export interface RecordFidelity {
	source: "provider_hook";
	completeness: CompletenessValue;
}

export interface FidelityBlock {
	record: RecordFidelity;
	fields: Record<string, FieldFidelity>;
}

// --- Privacy ---

export type RedactionStatus =
	| "unscanned"
	| "regex_scrubbed"
	| "pii_scanned"
	| "redacted"
	| "quarantined"
	| "not_required";

export interface PrivacyBlock {
	redaction_status: RedactionStatus;
	redaction_passes: string[];
	sensitivity: "unknown" | "public" | "confidential" | "secret";
	contains_sensitive: "unknown" | boolean;
	allowed_for_training: boolean;
	allowed_for_cloud_upload: boolean;
}

// --- Provider Raw ---

export interface ProviderRawBlock {
	tool_input_ref: string | null;
	tool_response_ref: string | null;
	tool_input_sha256: string | null;
	tool_response_sha256: string | null;
}

// --- Git context ---

export interface GitContext {
	head: string | null;
	branch: string | null;
}

// --- The record ---

// --- Agent lifecycle events (subagents / parallel agents / teammate tasks) ---

/** Which lifecycle hook produced an `agent_event` record. */
export type AgentEventName = "subagent_start" | "subagent_stop" | "task_completed";

/** Where a subagent's final message was recovered from: the hook payload's
 *  `last_assistant_message`, or a tail-read of the agent's own transcript
 *  when the payload omitted it. */
export type AgentMessageSource = "payload" | "transcript";

/** Where a subagent's `agent_type` label came from. The SubagentStop payload
 *  usually omits it (measured 2026-08-07: 1439/1507 stop events unlabeled),
 *  so the daemon reuses the label its SubagentStart carried. Recording the
 *  source keeps a remembered label distinguishable from a delivered one. */
export type AgentTypeSource = "payload" | "start_event";

/** Token totals summed over every assistant turn of one agent transcript. */
export interface AgentTokenTotals {
	input: number;
	output: number;
	cache_read: number;
	cache_creation: number;
}

/** What one spawned agent did and cost, derived from its own transcript —
 *  the only place this exists (SubagentStop carries no usage field). */
export interface AgentTranscriptMetrics {
	assistant_turns: number;
	tool_calls: number;
	tools: Record<string, number>;
	/** The agent's own tool_use ids — the join key back to activity.jsonl,
	 *  whose rows carry the PARENT session id and no agent marker. */
	tool_use_ids: string[];
	tool_use_ids_truncated: boolean;
	models: string[];
	tokens: AgentTokenTotals;
	/** Both counts are recorded: Claude Code persists thinking blocks with an
	 *  EMPTY `thinking` string, so a zero-with-text is an upstream fact rather
	 *  than a capture failure — and stays auditable if that changes. */
	thinking_blocks: number;
	thinking_blocks_with_text: number;
	first_ts: string | null;
	last_ts: string | null;
	duration_ms: number | null;
	transcript_entries: number;
}

/**
 * A subagent / parallel-agent lifecycle record. This is the durable copy of
 * what a spawned agent RETURNED — background-agent results are delivered to
 * the parent over a queue-notification channel that fires no hook, so the
 * SubagentStop payload (or the agent's transcript) is the only capturable
 * copy. `agent_transcript_path` points at the full per-agent transcript
 * (`~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl`).
 */
export interface AgentEventRecord {
	schema: "collection.v1";
	kind: "agent_event";
	ts: string;
	session_id: string | null;
	agent_name: string | null;
	provider: string;
	event: AgentEventName;
	subagent_id: string | null;
	agent_type: string | null;
	parent_agent: string | null;
	agent_transcript_path: string | null;
	/** The subagent's final assistant message — its result text. Secrets +
	 *  PII scrubbed (natural-language field, parity with prompt/thinking). */
	last_assistant_message: string | null;
	message_source: AgentMessageSource | null;
	/** How `agent_type` was resolved; null when the label is unknown. */
	agent_type_source: AgentTypeSource | null;
	/** Cost + activity metrics read off the agent's own transcript. Set on
	 *  `subagent_stop` (null on start / task_completed, and null when the
	 *  transcript was unreachable). */
	metrics: AgentTranscriptMetrics | null;
	/** TaskCompleted context (teammate/task-list lifecycle); null otherwise. */
	task: {
		task_id: string | null;
		task_subject: string | null;
		teammate_name: string | null;
		team_name: string | null;
	} | null;
	cwd: string | null;
}

export interface CollectionRecord {
	schema: "collection.v1";
	kind: "tool_event";
	ts: string;
	session_id: string | null;
	/** Resolved agent name for multi-agent attribution (from config / MCP
	 *  registration). Null when only the provider is known — e.g. a historical
	 *  record written before this field existed. */
	agent_name: string | null;
	/** Acting subagent when provider hooks remain grouped under a parent session. */
	subagent_id?: string | null;
	parent_agent?: string | null;
	model?: string | null;
	turn_id: string | null;
	tool_use_id: string | null;
	/** Per-session monotonic event ordinal (G3,
	 *  docs/design/reproducibility/g3-event-ordinal.md). The total-ordering
	 *  key across activity/collection for one session — `ts` collides for
	 *  parallel calls. Absent on cold-path/pre-G3 records. */
	seq?: number;
	provider: string;
	phase: "pre" | "post";
	/**
	 * For a `post` event, whether the tool call SUCCEEDED (`"ok"`) or FAILED
	 * (`"error"`, derived from a `tool_use_error` / `PostToolUseFailure`
	 * discriminator). Absent on `pre` events (no outcome yet). This is what
	 * preserves the success/failure distinction across the canonical round-trip:
	 * without it every post event collapses to `tool_use` and a reader can no
	 * longer surface failures (finding 5). Optional for backward-compat — records
	 * written before this field existed read as `"ok"`.
	 */
	outcome?: "ok" | "error";
	tool_class: ToolClass;
	provider_tool: string | null;
	cwd: string | null;
	git: GitContext | null;
	action: CollectionAction | null;
	observation: CollectionObservation | null;
	fidelity: FidelityBlock;
	privacy: PrivacyBlock;
	provider_raw: ProviderRawBlock;
}
