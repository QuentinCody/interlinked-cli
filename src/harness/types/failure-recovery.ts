// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Phase 1 Failure Recovery Channel Types
// ===========================================
// Types for the local failure-recovery channels (Channels 1, 2, 3, 5, 6).
// See docs/design/pre-post-pipelined-cloud-checks-and-failure-recovery.md.

import type { JsonObject } from "../../lib/json-types.js";

/** Triage label assigned to a tool failure. Drives downstream behavior. */
export type TriageLabel =
	| "agent-error"
	| "environmental"
	| "transient"
	| "unrecoverable"
	| "unknown";

/** Phase 1 failure event — what the harness handler dispatches on when a
 *  PostToolUse / Cursor postToolUseFailure arrives with `tool_outcome === "error"`.
 *  Pure data — every channel reads it; channels never mutate. */
export interface ToolFailureEvent {
	session_id: string;
	agent_source: string;
	tool_name: string;
	tool_input?: JsonObject | undefined;
	tool_use_id?: string | undefined;
	cwd?: string | undefined;
	timestamp: string;
	/** Canonical diagnostic text. Populated from the most-specific provider field. */
	error_message?: string | undefined;
	exit_code?: number | undefined;
	stderr?: string | undefined;
	stdout?: string | undefined;
	/** Set when Cursor's dedicated postToolUseFailure delivered the event. */
	is_interrupt?: boolean | undefined;
}

/** Local-tier triage rule. Pattern → classification. */
export interface TriageRule {
	/** Regex matched against the failure's error_message + stderr. */
	match: RegExp;
	/** Optional restriction to specific tool names. Omit to match every tool. */
	tools?: readonly string[];
	classify: TriageLabel;
	/** Sub-category used for recovery + explanation lookup
	 *  (e.g. "missing-import", "type-mismatch", "rate-limit"). */
	category: string;
}

/** Output of the triage classifier — Channel 2's contract. */
export interface TriageResult {
	label: TriageLabel;
	category: string;
	confidence: number;
	source: "local-heuristic" | "cloud-classifier";
	matched_rule?: string;
}

/** Local-tier recovery suggestion. Lookup keyed on `${label}/${category}`. */
export interface RecoverySuggestion {
	template: (ctx: RecoveryContext) => string;
	/** Optional extractor — pulls structured fields out of the error message
	 *  before the template runs. Returning null means "no rich context, but
	 *  still emit the template with empty fields." */
	extract?: (errorMessage: string) => RegExpExecArray | null;
}

export interface RecoveryContext {
	tool: string;
	error: string;
	symbol?: string;
	module?: string;
	file?: string;
	[k: string]: string | undefined;
}

/** Channel 5 — rollback feasibility assessment. */
export interface RollbackAssessment {
	safe: boolean;
	/** argv-style; caller may stringify for display, never executes via shell. */
	command?: readonly string[];
	reason: string;
	/** True only if we have positive evidence Interlinked caused this change. */
	caused_by_us: boolean;
}

/** Local-tier failure-cause explanation template. */
export interface ExplanationTemplate {
	template: (ctx: RecoveryContext) => string;
}

/** Phase 1 disk record — `.interlinked/failures/<failure_id>.json`.
 *  Phase 2 cloud receipts reference this via `receipt.post.failure_id`
 *  rather than duplicating the contents. */
export interface FailureRecord {
	failure_id: string;
	session_id: string;
	agent_source: string;
	tool_name: string;
	tool_input?: JsonObject | undefined;
	tool_use_id?: string | undefined;
	cwd?: string | undefined;
	timestamp: string;
	signature: string;
	error_message?: string | undefined;
	exit_code?: number | undefined;
	stderr?: string | undefined;
	stdout?: string | undefined;
	triage?: TriageResult | undefined;
	recurrence?: {
		count: number;
		distinct_sessions: number;
	} | undefined;
	recovery?: string | undefined;
	explanation?: string | undefined;
	rollback?: RollbackAssessment | undefined;
}
