import type { JsonObject } from "../lib/json-types.js";
// ===========================================
// Unified Hook Event Envelope — cross-runner normalization
// ===========================================
// Every runner adapter translates its native hook payload into this envelope
// before it reaches the evaluator. See docs/design/cli-hook-normalization.md.
//
// Compatibility note: this coexists with the legacy Claude-shaped `HarnessEvent`
// in `./types.ts`. The adapter layer at `./adapters/` produces `UnifiedHookEvent`
// objects; the evaluator's `evaluateUnified()` entry point converts them to the
// internal representation so existing checks keep working unchanged.

export type RunnerId =
	| "claude-code"
	| "copilot-cli"
	| "codex"
	| "gemini-cli"
	| "cursor"
	| "opencode"
	| "opencode2"
	| "pi"
	| "unknown";

/** User-perception latency class. Drives per-event budgets and which checks run.
 * Distinct from `ToolConcurrencyClass` in ./types.ts (which is about concurrency
 * safety). A tool can be read-only for concurrency yet side-effect for UX. */
export type ToolClass = "read" | "modify" | "side-effect" | "long-running" | "unknown";

export type UnifiedPhase =
	| "pre-tool"
	| "post-tool"
	| "session-start"
	| "session-end"
	| "user-prompt"
	| "permission-request"
	| "worktree-create"
	| "pre-compact"
	| "post-compact"
	| "stop"
	| "subagent-start"
	| "subagent-stop"
	| "notification"
	| "error"
	| "other";

// -----------------------------------------------------------------------------
// Action variants (tagged union on `kind`)
// -----------------------------------------------------------------------------

export interface ToolCallAction {
	kind: "tool_call";
	/** Normalized lowercase_snake form (e.g., "edit", "multi_edit", "read"). */
	tool_name: string;
	tool_class: ToolClass;
	tool_input: unknown;
	tool_input_redacted: unknown;
	/** Post-phase only */
	tool_response?: unknown;
	/** Post-phase only */
	tool_error?: string | undefined;
}

export interface ShellCommandAction {
	kind: "shell_command";
	command: string;
	cwd?: string | undefined;
	tool_class: ToolClass;
}

export interface FileOperationAction {
	kind: "file_operation";
	operation: "read" | "write" | "edit" | "delete";
	path: string;
	/** For Edit — the string being replaced (enables simulated-edit type check). */
	old_string?: string;
	/** For Edit — the replacement. */
	new_string?: string;
	/** For Write — full file content. */
	content?: string;
	tool_class: ToolClass;
}

export interface UserPromptAction {
	kind: "user_prompt";
	text: string;
}

export interface SessionLifecycleAction {
	kind: "session_lifecycle";
	event: "start" | "end" | "stop";
}

export interface OtherAction {
	kind: "other";
	subkind: string;
	data: unknown;
}

export type UnifiedAction =
	| ToolCallAction
	| ShellCommandAction
	| FileOperationAction
	| UserPromptAction
	| SessionLifecycleAction
	| OtherAction;

// -----------------------------------------------------------------------------
// Envelope
// -----------------------------------------------------------------------------

export interface UnifiedHookContext {
	cwd: string;
	/** git top-level if detectable */
	workspace_root?: string | undefined;
	git_head?: string | undefined;
	branch?: string | undefined;
	model?: string | undefined;
	transcript_path?: string | undefined;
	permission_mode?: string | undefined;
	agent?:
		| { id?: string | undefined; handle?: string | undefined; role?: string | undefined }
		| undefined;
}

export interface UnifiedHookEvent {
	schema_version: "1";
	/** UUID v7 preferred; any opaque ULID-like value is acceptable. */
	event_id: string;
	/** Stable across a single CLI session. */
	session_id: string;
	/** For causality; set by adapters when a pre/post pair is emitted. */
	parent_event_id?: string | undefined;
	/** Provider turn/prompt identifier, distinct from causal parentage. */
	turn_id?: string | undefined;
	/** The runner's own id for the tool invocation, when it supplies one
	 *  (Claude Code's `tool_use_id`). Stable across the PreToolUse/PostToolUse
	 *  pair and across duplicate hook deliveries of the same call — so it is
	 *  the key for de-duplicating redundant deliveries. Absent on non-tool
	 *  events and for runners that don't supply one. */
	tool_use_id?: string | undefined;
	/** Request-owned PostTool warning-spool token minted by the hook entry.
	 * Forwarded unchanged to the daemon and never used as an identity claim. */
	post_delivery_token?: string | undefined;
	/** PID of the hook process entitled to synchronous first delivery. The
	 * spool reader uses liveness only to defer, never to authorize content. */
	post_delivery_pid?: number | undefined;
	/** ISO 8601, ms precision. */
	ts: string;

	runner: RunnerId;
	runner_version?: string | undefined;
	/** The runner's own event name (e.g., "PreToolUse"). Preserved for forensics. */
	runner_native_event: string;

	phase: UnifiedPhase;
	action: UnifiedAction;
	context: UnifiedHookContext;

	/** The original native payload. Kept for forensics and debugging; never read
	 *  in the decision path. Size-capped by adapters when necessary. */
	raw: unknown;
}

// -----------------------------------------------------------------------------
// Small utilities
// -----------------------------------------------------------------------------

/** Crockford-style ULID-ish id (monotonic-ish, no external dependency). Suitable
 *  for event_id when a proper UUID v7 generator is not available in this
 *  environment (Node <20 / embedded hook binaries).
 */
export function makeEventId(): string {
	const now = Date.now();
	const rand = Math.random().toString(36).slice(2, 12);
	return `evt-${now.toString(36)}-${rand}`;
}

/** Guard that verifies the envelope conforms to the v1 schema before handing it
 *  to the evaluator. Returns a list of violations; empty = valid.
 *  Intentionally permissive: unknown fields are allowed. */
export function validateUnifiedEvent(event: unknown): string[] {
	if (event == null || typeof event !== "object") {
		return ["event must be an object"];
	}
	const e = event as JsonObject;
	const problems: string[] = [];
	if (e.schema_version !== "1") {
		problems.push(`schema_version must be "1", got ${JSON.stringify(e.schema_version)}`);
	}
	if (typeof e.event_id !== "string" || e.event_id.length === 0) {
		problems.push("event_id must be a non-empty string");
	}
	if (typeof e.session_id !== "string" || e.session_id.length === 0) {
		problems.push("session_id must be a non-empty string");
	}
	if (typeof e.ts !== "string") {
		problems.push("ts must be an ISO 8601 string");
	}
	if (typeof e.runner !== "string") {
		problems.push("runner must be a RunnerId string");
	}
	if (typeof e.runner_native_event !== "string") {
		problems.push("runner_native_event must be a string");
	}
	if (typeof e.phase !== "string") {
		problems.push("phase must be a UnifiedPhase string");
	}
	const ctx = e.context as { cwd?: unknown } | undefined;
	if (!ctx || typeof ctx !== "object" || typeof ctx.cwd !== "string") {
		problems.push("context.cwd must be a string");
	}
	const action = e.action as { kind?: unknown } | undefined;
	if (!action || typeof action !== "object" || typeof action.kind !== "string") {
		problems.push("action.kind must be a string");
	}
	return problems;
}

/** Narrow an UnifiedHookEvent to the ToolCallAction variant. Returns null otherwise. */
export function asToolCall(event: UnifiedHookEvent): ToolCallAction | null {
	return event.action.kind === "tool_call" ? event.action : null;
}

/** Narrow to a ShellCommandAction. Returns null if action kind differs. */
export function asShellCommand(event: UnifiedHookEvent): ShellCommandAction | null {
	return event.action.kind === "shell_command" ? event.action : null;
}

/** Narrow to a FileOperationAction. Returns null if action kind differs. */
export function asFileOperation(event: UnifiedHookEvent): FileOperationAction | null {
	return event.action.kind === "file_operation" ? event.action : null;
}

/** Extract the effective ToolClass from any action that carries one.
 *  Non-tool-call actions (user_prompt, session_lifecycle) return "unknown". */
export function extractToolClass(event: UnifiedHookEvent): ToolClass {
	const a = event.action;
	if (a.kind === "tool_call" || a.kind === "shell_command" || a.kind === "file_operation") {
		return a.tool_class;
	}
	return "unknown";
}
