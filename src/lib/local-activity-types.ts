// interlinked-tdd: exempt
// ===========================================
// Local Activity — shared types
// ===========================================
// Type/interface definitions for the local activity log + session/sync state,
// extracted from `local-activity.ts` to keep that module under the per-file line
// cap. Pure type surface (no runtime code) — re-exported from `local-activity.ts`
// so existing `import { ... } from "./local-activity.js"` call sites are unchanged.

export interface TokenUsage {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_creation?: number;
}

export interface EventAttribution {
	agent_lines?: number;
	human_lines?: number;
}

export interface LocalActivityEvent {
	ts: string;
	agent: string;
	workspace_key?: string | null;
	project_key?: string | null;
	type: string;
	tool?: string | null;
	summary?: string | null;
	session?: string | null;
	hook?: string | null;

	// v2 additions. schema_version is the LOG-FORMAT version, shared across
	// record families (activity events + guard telemetry). Family is keyed on
	// `type`, never on this number. Historical: 2, 3 (guard), 4 (activity); 5 unified.
	schema_version?: 2 | 3 | 4 | 5;
	trace_id?: string;
	parent_agent?: string;
	subagent_id?: string;
	tokens?: TokenUsage;
	duration_ms?: number;
	files_modified?: string[];
	attribution?: EventAttribution;
	checkpoint_id?: string;
	scrubbed?: boolean;

	// v3/v4 full-capture fields
	tool_input?: unknown;
	tool_response?: unknown;
	tool_use_id?: string;
	/** The tool_use id of the call that OWNS this one — on a spawned agent's
	 *  tool call, the Task call that spawned it. Present only when the runner
	 *  sends it; it is the sole per-tool-call marker distinguishing subagent
	 *  work from the parent session's in this log. */
	parent_tool_use_id?: string;
	/** The prompt/turn this event belongs to — correlates every event of one
	 *  turn (a spawned agent's included) back to the prompt that caused it. */
	prompt_id?: string;
	/** Reasoning-effort tier in force for this event. */
	effort?: string;
	/** Per-session monotonic event ordinal (G3). Stamped by the daemon path;
	 *  absent on cold-path records and records written before G3. */
	seq?: number;
	/** Delivery id from the framed unified path, when one existed. */
	event_id?: string;
	/** Present only on records written by the daemon. */
	writer?: "daemon";
	error?: unknown;
	is_interrupt?: boolean;
	cwd?: string;
	permission_mode?: string;
	transcript_path?: string;
	model?: string;
	thinking?: string;
	source?: string;
	agent_type?: string;
	last_assistant_message?: string;
	agent_transcript_path?: string;
	prompt?: string;
	notification_type?: string;
	notification_title?: string;
	notification_message?: string;
	task_id?: string;
	task_subject?: string;
	task_description?: string;
	teammate_name?: string;
	team_name?: string;
	trigger?: string;
	custom_instructions?: string;
	reason?: string;
	stop_hook_active?: boolean;
	permission_suggestions?: unknown;

	// v4 capture fields — error annotation, payload sizes, git context.
	// Written by the hook's appendLocal; see hook-template-chunks/.
	error_message?: string;
	error_category?: string;
	tool_input_bytes?: number;
	tool_output_bytes?: number;
	git_head?: string;
	git_branch?: string;

	// v3 guard telemetry — the persisted PreToolUse/PostToolUse decision.
	// Written daemon-side by `writeGuardDecisionRecord` (server/activity-writer.ts).
	// collection.jsonl deliberately drops `guard_*` records (lib/collection/builder.ts),
	// so activity.jsonl is the ONLY sink. This restores the 2026-06-01 regression
	// where the self-contained-.mjs → thin-daemon port dropped `appendGuardDecision`
	// and guard decisions stopped being recorded locally even though blocking
	// kept working. `tool_use_id` lets a decision be joined to its `tool_use_start`
	// (the action + the captured reasoning) for after-the-fact analysis.
	guard_decision?: "allow" | "block" | "ask";
	guard_rule_id?: string | null;
	guard_severity?: string | null;
	guard_category?: string | null;
	guard_reason?: string | null;
	guard_warnings?: string[] | null;
	guard_harness_ms?: number;
}

export interface SubagentState {
	files_touched: string[];
	tools_used: Record<string, number>;
	tool_count: number;
	tokens?: { input: number; output: number };
}

export interface SessionState {
	session_id: string;
	agent: string;
	phase: "ACTIVE" | "ENDED";
	started_at: string;
	last_event_at: string;
	tool_count: number;
	error_count: number;
	files_touched: string[];
	tools_used: Record<string, number>;

	// v2 additions
	tokens_total?: TokenUsage;
	token_events?: number;
	subagents?: Record<string, SubagentState>;

	// v3 additions: code activity tracking
	session_start_head?: string;
	edits?: CodeEdit[];
	by_agent?: Record<string, AgentContribution>;
	commits?: CommitAttribution[];
}

/** A single code edit captured from a PostToolUse event. Append-only. */
export interface CodeEdit {
	timestamp: string;
	session_id: string;
	agent_name: string;
	file: string;
	tool: "Edit" | "Write";
	lines_added: number;
	lines_removed: number;
	old_string?: string;
	new_string?: string;
	full_write?: boolean;
}

/** Per-agent aggregation within a session. Computed from CodeEdit array. */
export interface AgentContribution {
	agent_name: string;
	session_id: string;
	files_touched: string[];
	total_added: number;
	total_removed: number;
	edit_count: number;
}

/** Attribution reconciled against an actual git commit. */
export interface CommitAttribution {
	commit_hash: string;
	timestamp: string;
	message?: string;
	files: {
		file: string;
		net_added: number;
		net_removed: number;
		agents: {
			agent_name: string;
			added: number;
			removed: number;
			percentage: number;
		}[];
	}[];
	human_email?: string;
}

export interface LastSyncSummary {
	server_url: string;
	workspace_id: string | null;
	events_total: number;
	accepted: number;
	skipped: number;
	scrubbed: number;
	batches: number;
	by_type: Record<string, number>;
	by_agent: Record<string, number>;
	top_tools: [string, number][];
	sessions: number;
	time_range: { earliest: string; latest: string };
}

export interface SyncState {
	synced_through_bytes: number;
	last_sync_at: string;
	last_summary?: LastSyncSummary;
}

export interface SyncDiagnostics {
	pending_realtime_retry: number;
	sync_error_count: number;
	last_sync_success_at?: string | undefined;
	last_sync_error_at?: string | undefined;
	last_sync_error?: string | undefined;
}

export interface LocalStats {
	total_events: number;
	file_size_bytes: number;
	pending_sync: number;
	oldest_event?: string | undefined;
	newest_event?: string | undefined;
}
