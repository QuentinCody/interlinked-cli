// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Decision Types (harness → hook script)
// ===========================================

import type { JsonObject } from "../../lib/json-types.js";
import type { Determinism } from "./events.js";
import type { EscalationRequest } from "./policy.js";

export interface HarnessDecision {
	/**
	 * What the harness decides about this tool call.
	 * - `allow`: proceed.
	 * - `block`: refuse; `reason` is shown to the agent.
	 * - `ask`: surface a confirmation prompt to the user (Claude Code's
	 *   permission-request flow). Used for pre_block registry checks that
	 *   should be overridable per-invocation with human approval.
	 */
	decision: "allow" | "block" | "ask";
	/** Reason shown to the agent if blocked */
	reason?: string | undefined;
	/** Warnings written to stderr (agent sees these as hook output) */
	warnings?: string[] | undefined;
	/** Modified tool input — when set, the hook script should pass this to the agent instead of the original input */
	updated_input?: JsonObject;
	/** Dynamic filesystem subscriptions. Only supported native boundaries encode these. */
	watch_paths?: string[];
	/** Entries to append to the local activity log */
	log_entries?: LogEntry[];
	/** File reservation action taken (if any) */
	reservation?: ReservationAction;
	/** Guard rule ID that fired (for local persistence and server sync) */
	rule_id?: string | undefined;
	/** Severity of the matched rule */
	severity?: "critical" | "high" | "medium" | "low" | undefined;
	/** Category of the matched rule (for grouping in dashboards) */
	category?: string | undefined;
	/**
	 * Failing test FILES (repo-relative, best-effort parsed from the suite
	 * output) attached by the per-edit red-bar producers. Debt mode records
	 * these on the `red_suite` obligation as the red episode's evidence, so
	 * "related file" can be answered from the failure itself (any file the
	 * failing tests exercise) instead of filename convention alone. The typed
	 * field keeps the producer↔consumer coupling structural, like the
	 * RED_BAR_MARKER reason phrase it rides alongside.
	 */
	failing_test_files?: string[] | undefined;
	/** Structured results from all checks (quality, structural, suggestions) */
	check_results?: CheckResultEntry[];
	/** Checks that were skipped with structured reasons */
	checks_skipped?: import("../check-engine/types.js").SkipEntry[];
	/** Total elapsed time for all PostToolUse checks (ms) */
	checks_timing_ms?: number;
	/** Which checks were applicable to this file/event */
	checks_ran?: string[];
	/** Phase A.7: per-subprocess-tool elapsed/finding count, surfaced into
	 *  latency.jsonl so `interlinked harness latency --by-tool` can compute
	 *  per-tool p50/p99. */
	tool_breakdown?: Array<{ tool: string; ms: number; finding_count: number }>;
	/** Per-phase wall-clock breakdown of the PostToolUse handler. Keys are
	 *  named phases (e.g. "structural_checks", "quality_checks",
	 *  "project_wide_sweep", "tail_persist"); values are elapsed ms.
	 *  Used to attribute the residual = checks_timing_ms − Σ(tool_breakdown)
	 *  bucket to a specific phase. Set by the daemon, forwarded into
	 *  latency.jsonl. */
	phase_breakdown?: Record<string, number>;
	/** Grep acceleration statistics (when index intercepts a search) */
	grep_stats?: GrepStats;
	/** Summary line for display (e.g., "all clean (300ms)") */
	summary?: string;
	/** Internal: escalation request for the LLM policy classifier (set by evaluator, consumed by server.ts) */
	_escalation?: EscalationRequest | undefined;
	/** Internal: content-scan request for the ML content scanner (set by evaluator, consumed by server.ts) */
	_contentScan?: import("../content-scanner/types.js").ContentScanRequest | undefined;
	/**
	 * Provider-specific additional context the hook script should surface to the
	 * agent via `hookSpecificOutput.additionalContext`. Populated by the adapters
	 * (`src/harness/adapters/*.ts`) when they need to attach extra signal beyond
	 * the core decision — e.g., a cloud-escalation rationale or a classifier
	 * citation. Kept optional so adapters that don't need it can ignore the field.
	 */
	additional_context?: string | undefined;
	/**
	 * User-only message surfaced via Claude Code's top-level `systemMessage`
	 * field. Claude Code renders it in the permission UI but does NOT include
	 * it in the model's subsequent context window (hooks reference, 2026-04).
	 * This is the only place the content scanner is allowed to put raw PII
	 * span values — the agent-safe `reason` is still redacted. Capped at
	 * 10,000 chars by Claude Code; callers should stay well under.
	 */
	system_message?: string;
	/**
	 * Correlation id returned by the cloud escalation endpoint (when an
	 * escalation actually fired). Lets downstream tooling join harness
	 * telemetry with server-side records. Optional — local-only decisions
	 * never set this.
	 */
	telemetry_receipt_id?: string | undefined;
	/**
	 * Per-call findings surfaced by the unified evaluator when it needs to
	 * hand the hook script a structured list that isn't the `check_results`
	 * aggregate (e.g., an ordered list of specific rules hit for UI ranking).
	 * Optional; most decisions use `check_results` instead.
	 */
	findings?: CheckResultEntry[];
	/**
	 * Redacted copy of the user's prompt with PII/secrets masked as <LABEL>
	 * placeholders. Set by the UserPromptSubmit branch when the content scanner
	 * detected spans, so the hook persists the masked version to activity.jsonl
	 * instead of the raw prompt. Never sent back to the agent's context — purely
	 * for local storage.
	 */
	redacted_prompt?: string;
	/**
	 * Resolved concrete targets for `decision: "ask"` confirmation prompts.
	 * When a rule fires "ask" on a high-blast action, this surfaces the
	 * specific file paths, URLs, branches, tables, recipients, or packages
	 * the operation will touch so the human reviewer sees exactly what is
	 * about to happen — not just the rule description. Adapters render
	 * these as a `Targets:` bullet list after the ask reason. Values are
	 * truncated to 200 chars; arrays are capped at 5 entries.
	 */
	resolved_targets?: ResolvedTarget[];
}

/**
 * A concrete target value extracted from a tool invocation when a rule fires
 * `decision: "ask"`. Used to populate the user-facing confirmation prompt
 * with specific files / URLs / branches rather than just the rule reason.
 *
 * Values must already be truncated by the producer to ≤200 chars to keep
 * the per-adapter rendering bounded.
 */
export interface ResolvedTarget {
	/** What kind of resource this target refers to. */
	kind: "file" | "table" | "url" | "branch" | "recipient" | "package";
	/** Concrete value (path, URL, branch name, table id, etc.) — ≤200 chars. */
	value: string;
}

/** Structured result from a single check (quality, structural, suggestion, impact, or structure) */
export interface CheckResultEntry {
	/** Which subsystem produced this result */
	source:
		| "quality"
		| "structural"
		| "suggestion"
		| "impact"
		| "structure"
		| "spec"
		| "registry_parity";
	/** Check name (e.g., "typescript", "export_surface", "sql-injection", "public_symbol_companions") */
	name: string;
	/** Severity of the finding */
	severity: "error" | "warning" | "info";
	/** Human-readable message */
	message: string;
	/** File path the check ran against */
	file?: string | undefined;
	/** Extended detail (stack traces, diffs, etc.) */
	detail?: string | undefined;
	/** Suggestion score (0-1, for scored suggestions only) */
	score?: number | undefined;
	/** Files affected by this issue (for structural/impact checks) */
	affected_files?: string[] | undefined;
	/** Line number of the finding */
	line?: number | undefined;
	/** Determinism class — gates whether this finding can block the agent */
	determinism: Determinism;
	/** Phase the originating check declared. Optional because non-registry
	 *  check sources (tsc/biome/oxlint subprocess wrappers, structural
	 *  analyzers) don't have a registry phase concept — those are implicitly
	 *  `post`. Set explicitly for inline registry checks so FP-rate
	 *  telemetry can route accurately. */
	phase?: "pre_block" | "pre_warn" | "post" | undefined;
	/** Provenance class (structure findings only) */
	provenance?: "declared" | "extracted" | "inferred" | undefined;
	/** Artifact kind (structure findings only) */
	artifact_kind?: string | undefined;
	/** Artifact local ID (structure findings only) */
	artifact_id?: string | undefined;
	/** Required companion updates (structure findings only) */
	required_updates?: Array<{ file: string; kind: string; reason: string }> | undefined;
	/** Confidence score 0.0-1.0 (structure findings only) */
	confidence?: number | undefined;
}

/** Grep acceleration statistics */
export interface GrepStats {
	/** Number of candidate files from trigram index */
	candidates: number;
	/** Total files in the index */
	total_files: number;
	/** Selectivity percentage (candidates/total * 100) */
	selectivity_pct: number;
	/** Number of actual matches found */
	match_count: number;
	/** Whether acceleration was applied (vs pass-through) */
	accelerated: boolean;
}

export interface LogEntry {
	type: string;
	summary: string;
	detail?: string;
}

export interface ReservationAction {
	action: "reserved" | "conflict" | "extended" | "released";
	file: string;
	holder?: string;
	expires_at?: string;
}
