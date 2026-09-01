// interlinked-tdd: exempt — harness type definitions plus the tiny pure
// `agentSupportsAsk` helper (a Set membership test, covered by evaluator tests).
// ===========================================
// Interlinked Harness — Event & Decision-Surface Types
// ===========================================
// Hook events from coding agents, agent classification, and the wire event.

import type { JsonObject } from "../../lib/json-types.js";
import type { WorkspaceChangeSet } from "../workspace-effects.js";

// ===========================================
// Determinism Classification
// ===========================================

/** How deterministic a check result is — gates blocking decisions.
 * - fully_deterministic: backed by an exact oracle (compiler, parser, set equality)
 * - partially_deterministic: mostly reliable but not 100% (cross-session staleness)
 * - heuristic: regex-based or scoring-based estimate (complexity, naming, suggestions)
 */
export type Determinism = "fully_deterministic" | "partially_deterministic" | "heuristic";

// ===========================================
// Events (hook script → harness)
// ===========================================

/** Hook events from all supported coding agents */
export type HookEventName =
	// Claude Code — parseable events. PostToolUseFailure remains parse-only;
	// PermissionRequest and WorktreeCreate are installed policy events.
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "SessionStart"
	| "SessionEnd"
	| "Interrupt"
	| "UserPromptSubmit"
	| "Stop"
	| "SubagentStart"
	| "SubagentStop"
	| "Notification"
	| "PreCompact"
	| "PostCompact"
	| "TaskCompleted"
	| "TeammateIdle"
	| "PermissionRequest"
	| "WorktreeCreate"
	// Gemini CLI
	| "BeforeTool"
	| "AfterTool"
	| "AfterModel"
	| "PreCompress"
	// Interlinked-internal skill marker events (CLI-posted, not agent-fired)
	| "SkillEnter"
	| "SkillLeave"
	| "SkillList"
	// Generic
	| string;

export const AGENT_SOURCES = [
	"claude",
	"copilot",
	"codex",
	"gemini",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

/**
 * Whether a given agent runtime can surface an interactive permission prompt
 * to the user when the harness returns `decision: "ask"`. Clients that lack
 * an ask primitive get the rule's intent translated to "block" by the
 * provider-response formatter so the user still sees the reason and can
 * retry deliberately. Kept here in `types.ts` (rather than only in the
 * generated `.mjs`) so the harness evaluator and tests can reason about it.
 */
export const ASK_CAPABLE_AGENTS = new Set<AgentSource>(["claude", "cursor", "pi"]);

/** True when the agent runtime supports a per-call user confirmation flow. */
export function agentSupportsAsk(source: AgentSource | string | undefined): boolean {
	if (!source) return false;
	return ASK_CAPABLE_AGENTS.has(source as AgentSource);
}

/** Role classification for agent capability scoping */
export type AgentRole = "lead" | "worker" | "subagent" | "unknown";

/** Event sent from the hook script to the harness server */
export interface HarnessEvent {
	/** Which hook fired */
	hook_event: HookEventName;
	/** Session identifier from the coding agent */
	session_id: string;
	/** Which coding agent produced this event */
	agent_source: AgentSource;
	/** Resolved agent name (from config or MCP registration) */
	agent_name?: string;

	// Tool context (PreToolUse / PostToolUse)
	tool_name?: string | undefined;
	tool_input?: JsonObject | undefined;
	tool_response?: unknown;
	tool_use_id?: string | undefined;
	/** Generated-hook delivery token for the request-owned PostTool warning
	 * spool. The daemon never trusts it as identity; it is only a filesystem
	 * correlation key validated to a bounded filename-safe alphabet. */
	post_delivery_token?: string | undefined;
	/** Local hook process holding the synchronous first-delivery right. */
	post_delivery_pid?: number | undefined;
	/** Per-session monotonic event ordinal, minted by the daemon at observe
	 *  time (G3). The one total-ordering key — `timestamp` is ms-precision and
	 *  collides for parallel tool calls. Absent on the daemon-down cold path
	 *  and on events recorded before G3 landed. */
	seq?: number;
	/** Per-delivery unified-event id, carried through when the framed path
	 *  supplied one (raw hook payloads have none). Complements `seq`: `seq`
	 *  orders, `event_id` identifies a delivery. */
	event_id?: string;
	files_modified?: string[];
	/** Canonical observed filesystem effects for this completed tool call.
	 * Populated by the daemon from before/after repository snapshots; unlike
	 * `files_modified`, it is evidence rather than a runner declaration. */
	change_set?: WorkspaceChangeSet;
	/** Sandbox evidence visible to the hook. Configured is intentionally weaker
	 * than per-call attestation. */
	sandbox_evidence?: "attested" | "configured" | "disabled" | "unknown";

	// Canonical post-event outcome fields — populated by `deriveToolOutcome`
	// in `src/lib/hook-template-chunks/event-normalizers.ts` and forwarded
	// over the harness socket. `tool_outcome` is the single source of truth
	// for failure detection across every provider (Claude / Codex / Gemini /
	// Copilot / Cursor / OpenCode / Pi) — `is_error` does NOT exist on our wire format.
	tool_outcome?: "success" | "error" | "interrupted";
	/** Canonical diagnostic text for the failure. Populated from the most-
	 *  specific provider field (Claude `tool_response.message`, Cursor
	 *  `error_message`, Copilot `toolResult.error`/`error`, Gemini
	 *  `tool_response.error`), falling back to truncated `stderr` when no
	 *  provider field is present. Channels 2/3/6 classify on this. */
	error_message?: string;
	exit_code?: number;
	stderr?: string;
	stdout?: string;
	tool_response_sha256?: string;

	// Session context
	cwd?: string;
	model?: string;
	timestamp: string;
	/** SIMULATION marker. Set only by `interlinked harness test` (the synthetic
	 *  event it fires at the daemon). The verdict is computed and displayed
	 *  normally; what changes is that no evaluator may PERSIST anything from it —
	 *  no obligation-ledger txn, no ephemeral-write record. A read-only probe
	 *  that moves the gate is worse than no probe: on 2026-08-04 three
	 *  `harness test --write` calls opened a real transient debt on a file they
	 *  never wrote, which then blocked an unrelated edit. */
	dry_run?: boolean;

	// Subagent context
	parent_agent?: string;
	subagent_id?: string;
	agent_type?: string;
	/** SubagentStop payload — the subagent's final assistant message (its
	 *  RESULT text). Claude Code sends this on SubagentStop; absent elsewhere. */
	last_assistant_message?: string;
	/** SubagentStop/SubagentStart payload — path to the SUBAGENT's own
	 *  transcript JSONL (`<session-dir>/subagents/agent-<id>.jsonl`), distinct
	 *  from `transcript_path` (the parent session's transcript). */
	agent_transcript_path?: string;
	/** Tool-event payload — the tool_use id of the call that OWNS this one.
	 *  On a spawned agent's tool call it points at the Task call that spawned
	 *  it, which is the only live per-tool-call agent attribution: a subagent's
	 *  Pre/PostToolUse events otherwise carry the parent's session id and no
	 *  agent marker at all. Absent when the runner does not send it. */
	parent_tool_use_id?: string;
	/** Runner payload — the prompt/turn this event belongs to. Correlates every
	 *  hook event (including a spawned agent's) back to the turn that caused it. */
	prompt_id?: string;
	/** Runner payload — reasoning-effort tier in force (`effort.level`). */
	effort?: string;
	/** Runner payload (Stop / SubagentStop) — the live roster of work running
	 *  outside the main loop. A background agent has NO per-agent hook, so this
	 *  is the only report that it exists; see `background-task-log.ts`. */
	background_tasks?: unknown;

	/** UserPromptSubmit payload — the raw user prompt text. The hook copies it
	 *  verbatim so the harness can scan for PII before the hook persists the
	 *  record to activity.jsonl. Absent for non-prompt events. */
	prompt?: string;

	/** Agent role for capability scoping (inferred from context if not set) */
	agent_role?: AgentRole;

	/** Path to the agent's transcript JSONL — populated by the hook script
	 *  for Claude Code events. Read at Stop time by the commit-cadence
	 *  module to compute cumulative session token usage for nudge
	 *  escalation. Absent for agents that don't expose a transcript. */
	transcript_path?: string;
}
