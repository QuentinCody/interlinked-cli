import type { JsonObject } from "../lib/json-types.js";
// ===========================================
// Interlinked Harness — Type Definitions
// ===========================================
// Shared types for the harness server, evaluator, cohort, and reservations.

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
	// Claude Code (14 events)
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "SessionStart"
	| "SessionEnd"
	| "UserPromptSubmit"
	| "Stop"
	| "SubagentStart"
	| "SubagentStop"
	| "Notification"
	| "PreCompact"
	| "TaskCompleted"
	| "TeammateIdle"
	| "PermissionRequest"
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

export type AgentSource = "claude" | "copilot" | "codex" | "gemini" | "cursor";

/**
 * Whether a given agent runtime can surface an interactive permission prompt
 * to the user when the harness returns `decision: "ask"`. Clients that lack
 * an ask primitive get the rule's intent translated to "block" by the
 * provider-response formatter so the user still sees the reason and can
 * retry deliberately. Kept here in `types.ts` (rather than only in the
 * generated `.mjs`) so the harness evaluator and tests can reason about it.
 */
export const ASK_CAPABLE_AGENTS = new Set<AgentSource>(["claude", "cursor"]);

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
	tool_name?: string;
	tool_input?: JsonObject;
	tool_response?: unknown;
	tool_use_id?: string;
	files_modified?: string[];

	// Canonical post-event outcome fields — populated by `deriveToolOutcome`
	// in `src/lib/hook-template-chunks/event-normalizers.ts` and forwarded
	// over the harness socket. `tool_outcome` is the single source of truth
	// for failure detection across every provider (Claude / Codex / Gemini /
	// Copilot / Cursor) — `is_error` does NOT exist on our wire format.
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

	// Subagent context
	parent_agent?: string;
	subagent_id?: string;
	agent_type?: string;

	/** UserPromptSubmit payload — the raw user prompt text. The hook copies it
	 *  verbatim so the harness can scan for PII before the hook persists the
	 *  record to activity.jsonl. Absent for non-prompt events. */
	prompt?: string;

	/** Recursion guard for the metacoder subprocess path. When the harness
	 *  spawns `claude -p` to invoke Opus 4.7 (plan §2.5), the spawned
	 *  subprocess inherits the user's hooks → its first prompt fires
	 *  UserPromptSubmit back to this harness. Without this flag, the
	 *  metacoder would fire recursively on its own subprocess and never
	 *  return. The subprocess sees `INTERLINKED_METACODER_SUBPROCESS=1` in
	 *  env; the hook forwards it onto the event, and the UserPromptSubmit
	 *  branch short-circuits when true. */
	metacoder_subprocess?: boolean;

	/** Agent role for capability scoping (inferred from context if not set) */
	agent_role?: AgentRole;

	/** Path to the agent's transcript JSONL — populated by the hook script
	 *  for Claude Code events. Read at Stop time by the commit-cadence
	 *  module to compute cumulative session token usage for nudge
	 *  escalation. Absent for agents that don't expose a transcript. */
	transcript_path?: string;
}

// ===========================================
// Decisions (harness → hook script)
// ===========================================

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
	reason?: string;
	/** Warnings written to stderr (agent sees these as hook output) */
	warnings?: string[];
	/** Modified tool input — when set, the hook script should pass this to the agent instead of the original input */
	updated_input?: JsonObject;
	/** Entries to append to the local activity log */
	log_entries?: LogEntry[];
	/** File reservation action taken (if any) */
	reservation?: ReservationAction;
	/** Guard rule ID that fired (for local persistence and server sync) */
	rule_id?: string;
	/** Severity of the matched rule */
	severity?: "critical" | "high" | "medium" | "low";
	/** Category of the matched rule (for grouping in dashboards) */
	category?: string;
	/** Structured results from all checks (quality, structural, suggestions) */
	check_results?: CheckResultEntry[];
	/** Checks that were skipped with structured reasons */
	checks_skipped?: import("./check-engine/types.js").SkipEntry[];
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
	_escalation?: EscalationRequest;
	/** Internal: content-scan request for the ML content scanner (set by evaluator, consumed by server.ts) */
	_contentScan?: import("./content-scanner/types.js").ContentScanRequest;
	/**
	 * Provider-specific additional context the hook script should surface to the
	 * agent via `hookSpecificOutput.additionalContext`. Populated by the adapters
	 * (`src/harness/adapters/*.ts`) when they need to attach extra signal beyond
	 * the core decision — e.g., a cloud-escalation rationale or a classifier
	 * citation. Kept optional so adapters that don't need it can ignore the field.
	 */
	additional_context?: string;
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
	telemetry_receipt_id?: string;
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
}

/** Structured result from a single check (quality, structural, suggestion, impact, or structure) */
export interface CheckResultEntry {
	/** Which subsystem produced this result */
	source: "quality" | "structural" | "suggestion" | "impact" | "structure";
	/** Check name (e.g., "typescript", "export_surface", "sql-injection", "public_symbol_companions") */
	name: string;
	/** Severity of the finding */
	severity: "error" | "warning" | "info";
	/** Human-readable message */
	message: string;
	/** File path the check ran against */
	file?: string;
	/** Extended detail (stack traces, diffs, etc.) */
	detail?: string;
	/** Suggestion score (0-1, for scored suggestions only) */
	score?: number;
	/** Files affected by this issue (for structural/impact checks) */
	affected_files?: string[];
	/** Line number of the finding */
	line?: number;
	/** Determinism class — gates whether this finding can block the agent */
	determinism: Determinism;
	/** Phase the originating check declared. Optional because non-registry
	 *  check sources (tsc/biome/oxlint subprocess wrappers, structural
	 *  analyzers) don't have a registry phase concept — those are implicitly
	 *  `post`. Set explicitly for inline registry checks so FP-rate
	 *  telemetry can route accurately. */
	phase?: "pre_block" | "pre_warn" | "post";
	/** Provenance class (structure findings only) */
	provenance?: "declared" | "extracted" | "inferred";
	/** Artifact kind (structure findings only) */
	artifact_kind?: string;
	/** Artifact local ID (structure findings only) */
	artifact_id?: string;
	/** Required companion updates (structure findings only) */
	required_updates?: Array<{ file: string; kind: string; reason: string }>;
	/** Confidence score 0.0-1.0 (structure findings only) */
	confidence?: number;
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

// ===========================================
// Guard Rules
// ===========================================

/** Input rewrite specification for guard rules with action: "rewrite" */
export interface InputRewrite {
	/** Field to rewrite (dot-path, e.g. "command") */
	field: string;
	/** Regex pattern to match in the field value */
	match: string;
	/** Replacement string (supports $1, $2, etc. for capture groups) */
	replace: string;
}

export interface GuardRule {
	/** Unique rule identifier */
	id: string;
	/** Whether this rule is active */
	enabled: boolean;
	/** When to evaluate: before tool execution, after, or both */
	trigger: "PreToolUse" | "PostToolUse" | "both";
	/** Tool names this rule applies to. Use "*" for all tools. */
	tool_match: string[];
	/**
	 * What to do when the rule fires.
	 * - `block`: refuse the call. Reason returned to the agent.
	 * - `warn`: allow but emit a stderr warning (visible to the agent on Claude/Codex/Gemini; logged-only on Copilot).
	 * - `rewrite`: transform the tool input via `rule.rewrite` before execution.
	 * - `soft_block`: block first attempt but allow retry — used for "are you sure?" patterns.
	 * - `ask`: surface a per-call user confirmation prompt on agents that support
	 *   it (Claude Code, Cursor). On agents that lack an ask primitive (Copilot,
	 *   Codex, Gemini) the provider-response formatter collapses this to a hard
	 *   deny so the user still sees the reason and can retry deliberately.
	 *   Used for *potentially* destructive operations where human review beats
	 *   blanket denial: REST DELETE calls, GraphQL mutations carrying delete
	 *   verbs, MCP tools whose name suggests deletion.
	 */
	action: "block" | "warn" | "rewrite" | "soft_block" | "ask";
	/** Patterns to match against tool input fields */
	patterns: RulePattern[];
	/** Human-readable reason shown to the agent */
	reason: string;
	/** Suggested alternative action */
	suggestion?: string;
	/** Severity for logging and dashboard display */
	severity: "critical" | "high" | "medium" | "low";
	/** Category for documentation grouping */
	category?: string;
	/** Agent roles this rule applies to (omit or empty = all roles) */
	applies_to_roles?: AgentRole[];
	/** Input rewrite function key — used when action is "rewrite" */
	rewrite?: InputRewrite;
	/**
	 * Keyword tokens that, when ANY of them appear in the wrapper-normalized
	 * command, gate evaluation of this rule. Empty/missing list = "always
	 * evaluate" (used for rules whose canonical pattern has no word tokens,
	 * like the fork bomb `:(){:|:&};:`). Quick-reject filter — see
	 * `evaluator/keyword-quick-reject.ts`. Tokens are matched
	 * case-insensitively against shell-tokenized command text.
	 */
	keywords?: string[];
	/**
	 * Optional ISO 8601 expiry timestamp. If set and in the past at rule-load
	 * time, the rule is silently dropped from the loaded set. Used for
	 * temporary rules ("block X until 2026-06-01") so they don't linger as
	 * forgotten allowlist entries.
	 */
	expires_at?: string;
	/**
	 * Optional duration after which the rule expires, expressed as e.g.
	 * "30d", "12h", "1w". Loader resolves to a concrete `expires_at` at the
	 * moment the rule is first loaded. Convenience for human-authored configs.
	 */
	expires_after?: string;
	/**
	 * Optional runtime scope condition. When present, the rule is dormant
	 * unless every listed axis holds (skill active, TDD phase matches,
	 * recent command in window, etc.). See `ActiveWhen` and
	 * docs/design/harness-active-when-scoping.md.
	 */
	active_when?: ActiveWhen;
	/**
	 * Optional file-extension allowlist. When set, the rule only fires if the
	 * tool input's `file_path` (or `path`) field has an extension in this
	 * list. Used by language-specific content rules so a Python regex doesn't
	 * fire on a Markdown file that *describes* the same pattern in a code
	 * block, and so a "DROP TABLE" regex doesn't trip on marketing copy
	 * mentioning what the harness blocks. Match is case-insensitive and
	 * tolerant of leading dot ('.py' and 'py' both work). Undefined =
	 * unrestricted (the existing default).
	 */
	file_extensions?: string[];
}

export interface RulePattern {
	/** Dot-path into tool_input: "command", "file_path", "content" */
	field: string;
	/** Regex pattern string */
	regex: string;
	/** Regex flags (default: "i") */
	flags?: string;
	/** If true, pattern must NOT match (exception pattern) */
	negate?: boolean;
	/**
	 * Strip wrapper prefixes (`sudo`, `doas`, `env VAR=val`, `command -p`,
	 * `\cmd`) from the matched value before testing the regex. Use on
	 * patterns that anchor to the start of the command line; harmless
	 * elsewhere. Off by default to preserve raw-text rules
	 * (`\bsudo\s+rm\b`, etc.) that depend on the prefix being visible.
	 * Plan 01 §1.1.
	 */
	strip_wrappers?: boolean;
	/**
	 * Mask non-executed spans (single/double-quoted strings, comments,
	 * heredocs) with whitespace before testing the regex. Suppresses the
	 * `git commit -m 'rm -rf /'` class of FP. Off by default to preserve
	 * rules that *want* to inspect quoted argument shape (SQL payloads,
	 * `pkill -f 'wrangler dev'` exceptions). Plan 01 §1.2.
	 */
	executed_only?: boolean;
}

// ===========================================
// Active-When Scoping
// ===========================================
//
// `active_when` lets a distilled rule stay dormant until a runtime context
// signal fires. See docs/design/harness-active-when-scoping.md for the full
// rationale. Axes are AND-ed; an omitted axis is always-on. Rules without
// `active_when` keep current always-on behavior.

export interface ActiveWhen {
	/** One or more skill names; rule is active if ANY listed skill is in the session's `active_skills` map. */
	skill?: string | string[];
	/** Phase predicate (TDD red/green, ship phase, review phase, …). */
	phase?: PhaseSpec;
	/** Rule active only if the trajectory's recent commands match `pattern` within last `window_steps`. */
	after_command?: AfterCommandSpec;
	/**
	 * Additional file_path regex AND-ed with rule.patterns. Useful when the
	 * scope axis is "only when editing files matching X" but you don't want
	 * to merge into every positive pattern. Empty/missing = no extra filter.
	 */
	file_scope?: string;
	/** One or more model-overlay names (e.g., "claude", "gpt"). */
	overlay?: string | string[];
	/**
	 * One or more agent_source names. Distinct from `applies_to_roles`:
	 * roles gate evaluation entirely; agent_source here is a scope axis
	 * (rule loads but is dormant unless source matches).
	 */
	agent_source?: AgentSource | AgentSource[];
	/** Generic escape hatch for §6.5 predicates not yet promoted to a typed axis. */
	predicate?: SessionPredicateSpec;
}

export interface PhaseSpec {
	/** Predicate name — open string keeps the vocabulary extensible. Built-in: "tdd_state", "ship_phase", "review_phase". */
	name: string;
	/** Required value (e.g., "red", "green"). */
	value: string;
	/** "file" = per-file phase (tdd_state); "session" = whole-session phase. Default "session". */
	scope?: "file" | "session";
}

export interface AfterCommandSpec {
	/** Regex matched against entries in `SessionTrajectory.commands_run`. */
	pattern: string;
	/** How many recent entries to scan; default 10. */
	window_steps?: number;
}

export interface SessionPredicateSpec {
	name: string;
	args?: Record<string, unknown>;
}

/** Per-session record of an active skill marker. Garbage-collected on every session event. */
export interface ActiveSkillRecord {
	name: string;
	/** ms-since-epoch. */
	entered_at: number;
	/** ms-since-epoch; rule lookups treat the marker as expired once `Date.now() > expires_at`. */
	expires_at: number;
	/** "cli" = explicit `interlinked skill enter`; "hook" = agent-native skill lifecycle event; "manual" = enable-side toggle. */
	source: "cli" | "hook" | "manual";
}

// ===========================================
// Guard Rules Configuration
// ===========================================

export interface ProtectedFileRule {
	/** Glob pattern for file paths */
	glob: string;
	/** Which operations to guard: "Write", "Edit", "Delete", "Read" */
	operations: string[];
	/** Optional: run secrets detection on content before allowing */
	check?: "secrets";
	/** Reason shown to agent if blocked */
	reason: string;
}

export interface FileReminder {
	/** Glob pattern for file paths (supports dir/**, exact path, extension globs) */
	glob: string;
	/** Which operations trigger the reminder (omit = any file operation) */
	operations?: string[];
	/** Message shown to agent + user as a warning */
	message: string;
	/** Only fire once per session (default: true) */
	once_per_session?: boolean;
	/** Optional stable ID for dedup (auto-derived from glob if omitted) */
	id?: string;
	/** ISO timestamp when the reminder was created */
	created_at?: string;
	/** Who created this reminder (agent name or "cli") */
	created_by?: string;
}

export interface CurlMcpConfig {
	enabled: boolean;
	/** Localhost ports that should be MCP servers */
	localhost_ports: number[];
	/** Block after this many curl calls to same port (default: 5) */
	escalate_after: number;
	/** Warning message */
	message: string;
}

export interface QualityCheckConfig {
	enabled: boolean;
	/** Shell command to run (file path appended) */
	command?: string;
	/** File extensions to check (e.g., [".ts", ".tsx"]) */
	file_types: string[];
	/** Maximum execution time in milliseconds */
	timeout_ms: number;
	/** Whether failures are errors or warnings */
	severity: "error" | "warning";
	/** Human-readable description */
	description?: string;
	/** Skip this check for test files (e.g., semgrep/gitleaks on test fixtures) */
	skip_test_files?: boolean;
	/**
	 * `dependency_audit` only: prefer osv-scanner over per-ecosystem tools
	 * (npm audit / pip-audit / cargo audit / govulncheck) when it's on PATH.
	 * Default: true. Set false to force the legacy per-ecosystem commands.
	 */
	use_osv_scanner?: boolean;
	/**
	 * `dependency_audit` only: when osv-scanner is used, pass `--offline`
	 * (requires `osv-scanner scan --download-offline-databases` to have run
	 * at least once). Avoids osv.dev network round-trips on every edit.
	 */
	offline?: boolean;
}

// ===========================================
// Diff-Aware Filtering
// ===========================================

/** Controls which checks use diff-aware filtering to suppress pre-existing issues */
export interface DiffAwareConfig {
	/** Master switch (default: true) */
	enabled: boolean;
	/** "baseline" = only report new findings; "off" = report all (default: "baseline") */
	missing_return_types?: "baseline" | "off";
	/** "edit_region" = only in edited area; "off" = report all (default: "edit_region") */
	complexity?: "edit_region" | "off";
	/** "new_files_only" = only on Write (new files); "off" = always (default: "new_files_only") */
	no_test_file?: "new_files_only" | "off";
	/** "edit_content" = only for newly-added refs; "off" = report all (default: "edit_content") */
	undefined_env_vars?: "edit_content" | "off";
}

/** Cached check results from before an edit, used for baseline subtraction and ratchet comparison */
export interface PreEditBaseline {
	/** Function signatures with missing return types (Set of trimmed signature text) */
	missingReturnTypes: Set<string>;
	/** Complex function signatures (Set of trimmed signature text) */
	complexFunctions: Set<string>;
	/**
	 * Per-file, per-function CRAP scores captured before the edit.
	 * Keyed by repo-relative file path, inner map keyed by "name@line".
	 * Consumed by filterToRisers() in the PostToolUse CRAP block.
	 * Optional — absent when coverage data is unavailable (fail-open).
	 */
	crapScores?: Map<string, Map<string, number>>;
	/** When this baseline was captured */
	capturedAt: number;
	/** Count of suppression directives (@ts-expect-error, @ts-expect-error, eslint-disable, biome-ignore) */
	suppressionCount: number;
	/** Count of `as any` casts */
	asAnyCastCount: number;
	/** Count of non-null assertions (`foo!.bar`) */
	nonNullAssertionCount: number;
	/** Count of TODO / FIXME / HACK / XXX markers (Batch 7 ratchet). */
	todoMarkerCount?: number;
	/** Count of console.* statements (Batch 7 ratchet). */
	consoleStatementCount?: number;
	/** Count of exported symbols — public API surface (Batch 7 ratchet). */
	publicApiSurfaceCount?: number;
	/** Composite type-density counters: bare `: any` / `: unknown` / `: Function` / `: {}`
	 *  annotations plus untyped exported params and missing exported return types.
	 *  Optional — older callers/tests may not capture it; the ratchet check
	 *  fails open in that case. */
	typeDensity?: import("./quality-checks/ratchet-metrics.js").TypeDensityCounts;
	/** Software/model/dependency version references captured before the edit.
	 *  Used by the PostToolUse software_version_regression check to detect
	 *  accidental downgrades caused by stale model memory. Optional so older
	 *  direct test callers continue to fail open. */
	softwareVersions?: import("./quality-checks/software-version-regression.js").SoftwareVersionReference[];
	/** Per-primitive bare-unsafe-builtin counts captured before the edit.
	 *  Keyed by wrapper name (e.g. "safeParseInt" → 3 bare parseInt
	 *  calls in this file). The discovered_primitive_ratchet check
	 *  compares the post-edit counts and warns on any increase. Optional
	 *  — older direct test callers continue to fail open. */
	discoveredPrimitiveViolations?: Record<string, number>;
}

export interface GuardRulesConfig {
	version: 1;
	enabled: boolean;

	/** Custom guard rules (merged with built-in) */
	rules: GuardRule[];
	/** File path protection rules */
	protected_files: ProtectedFileRule[];
	/** File-scoped reminders (non-blocking warnings when files are touched) */
	file_reminders: FileReminder[];
	/** Detect curl to localhost when MCP tools should be used */
	curl_mcp_detection: CurlMcpConfig;
	/** PostToolUse quality checks (tsc, lint, secrets, etc.) */
	quality_checks: Record<string, QualityCheckConfig>;
	/** PostToolUse structural integrity checks (export surface, imports, cycles, etc.) */
	structural_checks: StructuralChecksConfig;
	/** Cross-session error memory */
	error_memory: ErrorMemoryConfig;
	/** Trajectory-level taint tracking (IFC) */
	taint_tracking: TaintTrackingConfig;
	/** Post-execution output scanning */
	output_scanning: OutputScanningConfig;
	/** Project-specific protected paths */
	project_specific?: {
		protected_paths: string[];
		protected_reason: string;
	};
	/**
	 * Path globs to skip the entire PostToolUse check pipeline (mirrors
	 * `SharedConfig.skip_paths`). When the touched file matches any entry,
	 * `runChecksAsync` returns an empty report with `skipped: [{check: "*",
	 * reason: "skip_paths matched", category: "config_disabled"}]`. Matched
	 * via `matchesAnyGlob` from `src/lib/path-glob.ts`.
	 */
	skip_paths?: string[];

	// Personal overrides (from guard-rules.local.json)
	/** Rule IDs to disable */
	disabled_rules?: string[];
	/** Additional exception patterns per rule ID */
	extra_exceptions?: Record<string, string[]>;
	/** Maximum suggestions to show per PostToolUse event (default: 3) */
	suggestion_limit?: number;
	/** Minimum score to show a suggestion (default: 0.5) */
	suggestion_threshold?: number;
	/** Paths outside repo root that agents are allowed to write to (e.g., ~/.claude/) */
	repo_confinement_allowlist?: string[];
	/** Tools that must be available. Missing required tools cause warnings instead of silent skips. */
	required_tools?: import("./check-engine/types.js").ToolId[];
	/** When true, unknown skip reasons (not in skip_allowlist) cause exit code 1 in verify */
	strict_skips?: boolean;
	/** Skip reason categories that are acceptable in strict mode */
	skip_allowlist?: string[];
	/** Diff-aware filtering: only report newly-introduced issues (default: enabled) */
	diff_aware?: DiffAwareConfig;
	/** LLM policy classifier for ambiguous PreToolUse cases */
	policy_classifier?: ClassifierConfig;
	/** Per-prompt metacoder that emits a session-scoped overlay before the
	 *  coding agent's first tool call. Plan: docs/design/metacoding-agent-plan.md.
	 *  When undefined or `enabled: false`, the metacoder never fires and the
	 *  agent runs against floor rules only. */
	metacoder?: import("./metacoder/types.js").MetacoderConfig;
	/** ML content scanner (OpenAI privacy-filter etc.) for PreToolUse diff/command/egress content + PostToolUse Read/Grep taint */
	content_scanner?: import("./content-scanner/types.js").ContentScannerConfig;
	/** Auto-coordination: periodic read-only check-in with MCP server */
	auto_coordination?: import("./auto-coordinate.js").AutoCoordinationConfig;
	/** Project-wide checks: periodic cross-file tsc/biome sweep */
	project_wide_checks?: ProjectWideCheckConfig;
	/** Commit-cadence nudges (Stop-hook + mid-session backstop). See CommitCadenceConfig. */
	commit_cadence?: CommitCadenceConfig;
	/** Verification-before-stop nudges (unverified-code, ui-not-interacted, stubs-introduced). See VerificationStopChecksConfig. */
	verification_stop_checks?: VerificationStopChecksConfig;
	/**
	 * Grep accelerator substitution (block-and-answer for rg/grep/Grep).
	 * Disabled by default — the substitution bypasses content scanners,
	 * can serve stale results from a SessionStart-only refreshed index,
	 * and the partially-formed hookSpecificOutput envelopes have hit
	 * Claude Code's hook validator. The trigram index itself stays
	 * loaded and is still used by other consumers (impact analysis,
	 * project graph, structural checks). Re-enable via this flag or
	 * `INTERLINKED_GREP_ACCELERATOR=1`.
	 */
	grep_acceleration?: {
		/** Default: false. Set to true to restore the block-and-answer path. */
		substitution_enabled?: boolean;
	};
}

/** Verification-before-stop nudge configuration. Four independent
 *  Stop / SessionEnd warnings, all stderr-only, all opt-out per-kind:
 *    - warn_unverified_code:   code-file edits with no tsc/test/lint/build
 *    - warn_verify_not_run:    code edits with partial verification —
 *                              tsc/test/etc. ran but `interlinked verify`
 *                              (the canonical local CI mirror) did not.
 *                              Fires only when individual tools ran but
 *                              the suite didn't (no double-nudge with
 *                              warn_unverified_code).
 *    - warn_ui_not_interacted: UI-file edits with no dev-server / browser MCP
 *    - warn_stubs_introduced:  TODO/FIXME/disabled-test/not-impl-throw
 *                              surfaced via Write/Edit content during the session
 *  Master `enabled` switch gates all four together. */
export interface VerificationStopChecksConfig {
	enabled: boolean;
	warn_unverified_code: boolean;
	warn_verify_not_run: boolean;
	warn_ui_not_interacted: boolean;
	warn_stubs_introduced: boolean;
}

/** Commit-cadence nudge configuration. Two triggers: (a) at Stop /
 *  SessionEnd when the count of distinct non-doc files edited since the
 *  last commit exceeds `stop_threshold`, and (b) a mid-session backstop
 *  one-shot when the same count crosses `mid_session_threshold`. */
export interface CommitCadenceConfig {
	enabled: boolean;
	/** File-count threshold above which the Stop-hook nudge fires. */
	stop_threshold: number;
	/** File-count threshold for the one-shot mid-session backstop. */
	mid_session_threshold: number;
	/** Cumulative session token count (input+output) above which the Stop nudge wording escalates to "long session". */
	token_band_low: number;
	/** Cumulative session token count above which the Stop nudge wording escalates further to "very long session" / "context window degrading". */
	token_band_high: number;
	/** Glob list whose matches are excluded from the count (markdown,
	 *  /docs, /plans, /notes, CLAUDE.md, AGENTS.md, PLAN*.md). Override
	 *  to add project-specific scratch areas (e.g., RFC drafts). */
	doc_globs: string[];
}

// ===========================================
// Project-Wide Checks (cross-file sweep)
// ===========================================

export interface ProjectWideCheckConfig {
	/** Enable project-wide check sweeps (default: true) */
	enabled: boolean;
	/** Run project-wide checks every N file edits (default: 5) */
	edit_interval: number;
	/** Always run project-wide checks when export surface changes (default: true) */
	on_export_change: boolean;
	/** Which tools to run in project mode (default: ["tsc", "biome"]) */
	tools: import("./check-engine/types.js").ToolId[];
	/** Timeout per tool in ms (default: 30000) */
	timeout_ms: number;
	/** Severity for cross-file findings (default: "warning") */
	severity: "error" | "warning";
	/** Maximum findings to report per sweep (default: 20) */
	max_findings: number;
}

// ===========================================
// Agent Cohort
// ===========================================

export type AgentStatus = "active" | "idle" | "lost";

export interface CohortAgent {
	/** Agent name (from MCP registration or config) */
	name: string;
	/** Session ID from the coding agent */
	session_id: string;
	/** Which coding agent runtime */
	source: AgentSource;
	/** Current status */
	status: AgentStatus;
	/** If subagent, who spawned it */
	parent_agent?: string;
	/** When the agent joined the cohort */
	joined_at: string;
	/** Last event timestamp */
	last_event_at: string;
	/** Files currently reserved by this agent */
	files_reserved: string[];
	/** Current task description (if known from MCP) */
	current_task?: string;
}

// ===========================================
// File Reservations
// ===========================================

export interface ReservationEntry {
	/** File path or glob pattern */
	file_pattern: string;
	/** Agent holding the reservation */
	agent_name: string;
	/** Whether this agent belongs to the local developer or a remote one */
	cohort: "local" | "remote";
	/** When the reservation was created */
	reserved_at: string;
	/** When the reservation expires */
	expires_at: string;
}

export interface ReservationConflict {
	agent_name: string;
	cohort: "local" | "remote";
	expires_at: string;
	human?: string;
}

// ===========================================
// Sensitivity / Taint Tracking
// ===========================================

export type SensitivityLevel = "Public" | "Internal" | "Confidential" | "HighlyConfidential";

export interface TaintSource {
	file: string;
	level: SensitivityLevel;
	at_step: number;
}

export interface TaintTrackingConfig {
	enabled: boolean;
	/** File patterns → sensitivity level mappings */
	file_sensitivity: Array<{ glob: string; level: SensitivityLevel }>;
	/** Step limits per sensitivity level */
	step_limits: Record<SensitivityLevel, number>;
	/** Block outbound network at this level and above */
	network_block_at: SensitivityLevel;
}

// ===========================================
// Output Scanning Configuration
// ===========================================

export interface OutputScanningConfig {
	enabled: boolean;
	/** Scan Bash output for leaked secrets */
	scan_bash_secrets: boolean;
	/** Scan WebFetch results for prompt injection */
	scan_web_injection: boolean;
	/** Scan file read results for indirect injection */
	scan_file_injection: boolean;
	/** Maximum bytes to scan per response (default: 100KB) */
	max_scan_bytes: number;
}

// ===========================================
// Session Trajectory
// ===========================================

/**
 * Per-test-file counts of `it()`/`test()` blocks and `expect()`/`assert*()`
 * calls. Captured on every PostToolUse Write/Edit of a test file; the
 * delta between successive captures is what the assertion-density
 * behavioral check fires on. Declared here (not in `behavioral-checks.ts`)
 * because `SessionTrajectory` lives in this module — moving the definition
 * out would create an import cycle.
 */
export interface AssertionCounts {
	blocks: number;
	assertions: number;
}

export interface SessionTrajectory {
	session_id: string;
	agent_name: string;
	started_at: string;
	tool_call_count: number;
	error_count: number;
	files_read: Set<string>;
	files_written: Set<string>;
	commands_run: string[];
	/** Track curl-to-localhost frequency per port */
	curl_localhost_count: Record<number, number>;
	last_checkpoint_at?: string;
	/** Count of MCP tool calls (agent is using MCP correctly) */
	mcp_tools_used: number;
	/** Count of non-MCP tool calls */
	local_tools_used: number;
	/** Timestamp of last write per file (for cross-agent staleness detection) */
	file_write_times: Map<string, string>;
	/** Files that had check failures this session (file → entry) */
	failed_files: Map<string, FailedFileEntry>;
	/** Pending follow-through after export changes (source_file → completion) */
	pending_completions: Map<string, PendingCompletion>;
	/** Tool call count when each file was last read (for redundant re-read detection) */
	file_read_at: Map<string, number>;
	/** Recent tool call sequence for pattern detection (last 20: "Edit:src/foo.ts") */
	tool_sequence: string[];
	/** Current sensitivity taint level (ratchets up, never down) */
	sensitivity_level: SensitivityLevel;
	/** Files that caused sensitivity escalation (audit trail) */
	taint_sources: TaintSource[];
	/** Maximum allowed tool calls at current sensitivity level */
	step_limit: number;
	/** Consecutive similar tool patterns for permission suggestion (pattern → count) */
	consecutive_pattern: { pattern: string; count: number } | null;
	/** Permission patterns already suggested this session (avoid duplicates) */
	suggested_permissions: Set<string>;
	/**
	 * Acknowledged check warnings this session (file::checkName pairs).
	 * When a PostToolUse warning is shown and the user allows the agent to
	 * continue, the pair is recorded here. Subsequent PostToolUse events for
	 * the same file+check skip re-firing the warning (warnings only, not errors).
	 * Cleared per-file when a new edit touches that file.
	 */
	acknowledged_checks: Set<string>;
	/** File reminder IDs that have already fired this session (dedup for once_per_session) */
	fired_reminders: Set<string>;
	/** Soft-blocked command hashes — blocked first attempt, allowed on retry */
	soft_blocks: Set<string>;
	/** Tool call counts where prompt injection was detected in PostToolUse file reads */
	injection_detected_steps: number[];
	/** Tool call counts where the ML content-scanner flagged PII/secrets in PostToolUse Read/Grep results */
	pii_detected_steps: number[];
	/** tool_call_count at last auto-coordination check-in (init: 0) */
	last_coordination_at: number;
	/** Date.now() at last auto-coordination check-in (init: Date.now()) */
	last_coordination_ts: number;
	/** Test files executed this session with their last pass/fail status */
	test_runs: Map<string, { status: "pass" | "fail"; at_step: number }>;
	/** Per-file edit count this session (for repeated-edit-without-test detection) */
	file_edit_counts: Map<string, number>;
	/** Warnings issued per file::check (for escalation + effectiveness tracking) */
	warnings_issued: Map<string, WarningRecord>;
	/** TDD red/green cycle tracking per source file */
	tdd_cycles: Map<string, TddCycle>;
	/** Consecutive PostToolUseFailure count per tool_name (reset on any success for the same tool). */
	consecutive_tool_failures: Map<string, number>;
	/**
	 * Skills currently active for this session, keyed by skill name. Populated
	 * by `skill_enter` events; cleared by `skill_leave` or TTL expiry. Read by
	 * the active-when predicate evaluator. Optional so test fixtures and older
	 * call sites that don't care about scope can omit it; the evaluator treats
	 * undefined identically to an empty map. See harness-active-when-scoping.md.
	 */
	active_skills?: Map<string, ActiveSkillRecord>;
	/** Tool names that have already received a silent-failure warning this session (dedup). */
	silent_failure_warned: Set<string>;
	/** Tool names that have already received a context-bloat warning this session (dedup). */
	bloat_warned: Set<string>;
	/**
	 * Phase D.2 trajectory state machine. Lazy-instantiated on first
	 * PreToolUse event for the session when any `harness.trajectory.*`
	 * feature flag is enabled. Detects tool_loop / destructive_sequence /
	 * unbackedoff_retry / silent_stall anti-patterns. Findings surface as
	 * PreToolUse warnings, never as block decisions. Optional so tests
	 * with bare-bones session fixtures don't have to wire it in.
	 */
	trajectoryDetector?: import("./trajectory.js").TrajectoryDetector;
	/**
	 * Commit-cadence tracking — set of distinct non-doc files edited
	 * since the last `git commit`. Cleared on every `git commit` Bash
	 * invocation. Used by the Stop nudge and the mid-session backstop
	 * to count "uncommitted code-file work" without inflating on
	 * re-edits to the same file. Optional so tests that hand-build a
	 * session fixture don't have to wire it in — readers default to
	 * an empty set when absent.
	 */
	non_doc_files_edited_since_commit?: Set<string>;
	/**
	 * Number of doc/plan files (markdown, /docs, /plans, /notes,
	 * CLAUDE.md, AGENTS.md, PLAN*.md) edited since the last commit —
	 * surfaced in the nudge wording so the agent knows we're aware
	 * of the doc churn but excluded it on purpose.
	 */
	doc_files_edited_since_commit?: number;
	/** One-shot guard for the mid-session backstop nudge — set when it fires. */
	mid_session_nudge_emitted?: boolean;
	/** One-shot guard for the Stop-hook nudge — set when it fires. */
	stop_nudge_emitted?: boolean;
	/**
	 * Per-test-file `(blocks, assertions)` counts captured on the previous
	 * PostToolUse for each test file the agent has touched this session.
	 * The assertion-density behavioral check compares the post-edit count
	 * against this prior value to fire on `dBlocks > 0 && dAssertions <= 0`.
	 * First-sight of any test file silently establishes baseline.
	 */
	assertion_counts: Map<string, AssertionCounts>;
	/**
	 * Verification-before-stop tracking. Set of `VerificationSignal` kinds
	 * observed during the session — populated by `session-state.ts` from
	 * Bash commands (typecheck/test/lint/build/dev-server) and MCP browser
	 * tool names. Read at Stop by the three verify-before-stop nudges in
	 * `verification-stop-checks.ts`. Optional so hand-built test fixtures
	 * don't need to wire it.
	 */
	verification_observed?: Set<string>;
	/**
	 * Verification-before-stop tracking. Stubs / TODOs / disabled tests /
	 * not-implemented throws introduced via Write/Edit `content` /
	 * `new_string` this session. Populated by the post-tool evaluator's
	 * stub scanner (`scanForStubs`); read at Stop by
	 * `formatStubsIntroducedWarning`. Capped at `STUB_INTRODUCED_CAP`
	 * entries to keep long-session memory bounded.
	 */
	stubs_introduced?: Array<{ file: string; kind: string; snippet: string }>;
}

// ===========================================
// TDD Cycle Tracking
// ===========================================

/** State of the TDD red/green cycle for a single source file */
export type TddCycleState = "no_test" | "red" | "green" | "regression";

/** Tracks the red/green TDD cycle for a source file and its corresponding test */
export interface TddCycle {
	/** Absolute path to the source file being tested */
	source_file: string;
	/** Absolute path to the corresponding test file (null if none found) */
	test_file: string | null;
	/** Current state of the TDD cycle */
	state: TddCycleState;
	/** tool_call_count when the test file was first written/edited this session */
	test_written_at?: number;
	/** tool_call_count when tests first failed (entered RED) */
	red_at?: number;
	/** tool_call_count when tests first passed after being red (entered GREEN) */
	green_at?: number;
	/** Number of impl edits before any test interaction (writing test or running test) */
	impl_edits_before_test: number;
	/** Previous state — used to detect transitions (e.g., green→red = regression) */
	previous_state?: TddCycleState;
}

/** Record of a warning issued to the agent for a specific file + check */
export interface WarningRecord {
	/** Check name that produced the warning */
	check_name: string;
	/** How many times this warning has been issued for this file */
	issue_count: number;
	/** tool_call_count when first issued */
	first_issued_at: number;
	/** tool_call_count when last issued */
	last_issued_at: number;
	/** Whether the warning was resolved (next edit passed the check) */
	resolved: boolean;
}

/** Aggregate effectiveness stats for a single check across the session */
export interface CheckEffectivenessStats {
	check_name: string;
	times_issued: number;
	times_resolved: number;
	resolution_rate: number;
}

/** Per-session feedback effectiveness summary */
export interface FeedbackEffectivenessSummary {
	per_check: CheckEffectivenessStats[];
	overall_resolution_rate: number;
	total_issued: number;
	total_resolved: number;
}

// ===========================================
// Project Graph — Import/Export Indexing
// ===========================================

export interface ExportedSymbol {
	/** Symbol name ("default" for default exports) */
	name: string;
	/** What kind of export */
	kind:
		| "function"
		| "class"
		| "const"
		| "let"
		| "var"
		| "interface"
		| "type"
		| "enum"
		| "default"
		| "re-export"
		| "namespace";
	/** Whether this is a type-only export */
	isTypeOnly: boolean;
	/** Line number (1-based) */
	line: number;
}

export interface ImportEdge {
	/** File that contains the import statement */
	fromFile: string;
	/** Resolved absolute path of the imported module */
	toFile: string;
	/** Raw import specifier (e.g., "./utils", "../types") */
	specifier: string;
	/** Imported symbol names (empty for side-effect or namespace imports) */
	symbols: string[];
	/** Whether this is a type-only import */
	isTypeOnly: boolean;
}

// ===========================================
// Structural Check Results
// ===========================================

export interface StructuralCheckResult {
	/** Which check produced this result */
	check: string;
	/** Severity level */
	severity: "error" | "warning" | "info";
	/** Human-readable message for the agent */
	message: string;
	/** The file that was edited */
	file: string;
	/** Additional detail (affected files, diff, etc.) */
	detail?: string;
	/** Files affected by this issue */
	affectedFiles?: string[];
}

// ===========================================
// Module Role Classification
// ===========================================

/** Classification based on import/export connectivity */
export type ModuleRole = "leaf" | "internal" | "hub" | "root";

// ===========================================
// Impact Analysis
// ===========================================

export type ImpactSeverity = "low" | "medium" | "high" | "critical";

export interface ImpactAnalysisResult {
	/** The file that was edited */
	file: string;
	/** Overall severity classification */
	severity: ImpactSeverity;
	/** Module role from ProjectGraph */
	moduleRole: ModuleRole;
	/** Total number of direct dependents */
	dependentCount: number;
	/** Files that would break from export surface changes */
	breakingFiles: string[];
	/** Test files that cover the edited file */
	testFiles: string[];
	/** Files that need follow-up updates */
	followUpFiles: string[];
	/** Whether exports actually changed (vs internal-only edit) */
	exportSurfaceChanged: boolean;
	/** Human-readable summary for the agent */
	summary: string;
}

// ===========================================
// Session-level Tracking Types
// ===========================================

/** Tracks files that had check failures (Feature: recently-failed-here) */
export interface FailedFileEntry {
	/** Number of failures on last check */
	failure_count: number;
	/** Check names that failed */
	checks: string[];
	/** When the failures were recorded */
	recorded_at: string;
	/** Tool call count when recorded */
	tool_call_count: number;
}

/** Tracks pending follow-through after export changes (Feature: completion tracking) */
export interface PendingCompletion {
	/** The file whose export surface changed */
	source_file: string;
	/** Files that import from source and need updating */
	affected_files: string[];
	/** Files the agent has already visited (read/edited) since the change */
	resolved_files: Set<string>;
	/** Tool call count when the completion was recorded */
	recorded_at_tool_call: number;
	/** What changed */
	description: string;
}

/** Route information detected from source code (Feature: route mapping) */
export interface RouteInfo {
	/** HTTP method or "TOOL" for MCP tools */
	method: string;
	/** URL path pattern or tool name */
	path: string;
	/** File that handles this route */
	handler_file: string;
	/** Line number of the route definition */
	line?: number;
}

// ===========================================
// Structural Checks Configuration
// ===========================================

export interface StructuralChecksConfig {
	enabled: boolean;
	/** Detect removed/renamed exports and warn about affected importers */
	export_surface: boolean;
	/** Verify all imports in edited files resolve to existing files/exports */
	import_resolution: boolean;
	/** Warn when a new export collides with an existing symbol name */
	duplicate_symbols: boolean;
	/** Warn when editing a file whose dependents were recently read by another agent */
	co_dependency_staleness: boolean;
	/** Detect circular dependency introduction */
	import_cycles: boolean;
	/** Warn when interface/type shape changes affect other files */
	interface_change_impact: boolean;
	/** Warn when edited source file has no corresponding test file */
	test_proximity: boolean;
	/** Only run full tsc when export surface changes (skip for internal-only edits) */
	smart_tsc: boolean;
	/** PreToolUse: show import count when editing high-connectivity files */
	blast_radius: boolean;
	/** PreToolUse: warn when reading a file recently modified by another agent */
	stale_read_warning: boolean;
	/** PreToolUse: list sibling files when creating a new file */
	sibling_awareness: boolean;
	/** Staleness window in seconds (default: 300 = 5 minutes) */
	staleness_window_s: number;
	/** Blast radius threshold — warn when file has >= this many dependents */
	blast_radius_threshold: number;
	/** PreToolUse: warn when reading/editing a file that had recent check failures */
	recently_failed: boolean;
	/** PreToolUse: remind agent about pending follow-through after export changes */
	completion_tracking: boolean;
	/** PreToolUse: inject route/handler context when editing API files */
	route_context: boolean;
	/** PreToolUse: warn when re-reading a file that hasn't changed */
	redundant_reread: boolean;
	/** PostToolUse: detect unused imports after editing */
	dead_imports: boolean;
	/** Completion tracking reminder threshold (tool calls since export change, default: 10) */
	completion_reminder_threshold: number;
	/** Detect exports with zero importers in the project graph */
	dead_exports: boolean;
	/** Detect bare-specifier imports not in package.json dependencies */
	hallucinated_imports: boolean;
	/** Detect relative imports that cross a package.json boundary */
	cross_package_imports: boolean;
	/** Detect process.env.FOO where FOO isn't in .env.example */
	undefined_env_vars: boolean;
	/** Detect imports that violate configured layer rules */
	layer_violations: boolean;
	/** Layer rules: "files matching from_glob cannot import from cannot_import_glob" */
	layer_rules?: Array<{ from_glob: string; cannot_import_glob: string; reason: string }>;
	/** PostToolUse: run impact analysis on file edits */
	impact_analysis: boolean;
	/** Impact analysis: dependent count threshold for "high" severity (default: 4) */
	impact_high_threshold: number;
	/** PreToolUse: nudge agent to write/run tests before editing source files */
	test_first: boolean;
	/** TDD enforcement mode: "nudge" (info), "warn" (warning), "enforce" (blocks commit) */
	test_first_mode: "nudge" | "warn" | "enforce";
	/** Detect duplicate switch discriminant (x.kind) across files */
	cross_file_switch_discriminant?: boolean;
	/** Detect interfaces with exactly one implementor (premature abstraction) */
	single_implementation_interface?: boolean;
}

// ===========================================
// Error Memory — Cross-session error tracking
// ===========================================

/** A single error record persisted in .interlinked/error-history.jsonl */
export interface ErrorRecord {
	/** When the error was detected */
	timestamp: string;
	session_id: string;
	agent_name: string;
	/** Relative file path */
	file: string;
	/** Module role at time of error */
	file_role: ModuleRole;
	/** Which check caught it */
	check_name: string;
	severity: "error" | "warning";
	/** Human-readable error message */
	message: string;
	/** Context: diff, surrounding code, file role */
	diff_context: string;
	/** Files affected by the error */
	affected_files?: string[];
	/** The subsequent edit that fixed the issue (populated retroactively) */
	fix_context?: string;
	/** Line range where the error occurred (for region-level tracking) */
	line_start?: number;
	line_end?: number;
	/** Other files edited in the same session when this error occurred */
	co_edited_files?: string[];
	/** Tool call sequence leading up to this error (last 15 calls) */
	pre_error_sequence?: string[];
}

/** Error memory configuration */
export interface ErrorMemoryConfig {
	enabled: boolean;
	/** Maximum age of error records to consider in seconds (default: 7 days) */
	max_age_s: number;
	/** Maximum number of records to keep in history (default: 5000) */
	max_records: number;
}

// ===========================================
// Language Profiles — Multi-language support
// ===========================================

export type LanguageId =
	| "typescript"
	| "python"
	| "rust"
	| "go"
	| "c_cpp"
	| "java"
	| "swift"
	| "cuda"
	| "opencl"
	| "metal"
	| "hlsl"
	| "wgsl";

export interface LanguageProfile {
	id: LanguageId;
	display_name: string;
	file_extensions: string[];
	project_root_markers: string[];
	type_check: LanguageCheckDef | null;
	linter: LanguageCheckDef | null;
	test_runner: LanguageTestDef | null;
	inline_checks: InlineCheckDef[];
}

export interface LanguageCheckDef {
	command: string;
	append_file: boolean;
	config_files?: string[];
	timeout_ms: number;
	severity: "error" | "warning";
	description: string;
}

export interface LanguageTestDef {
	command: string;
	timeout_ms: number;
	severity: "error" | "warning";
	description: string;
}

export interface InlineCheckDef {
	name: string;
	description: string;
	file_types: string[];
	severity: "error" | "warning";
	skip_test_files?: boolean;
	fix_instruction: string;
	/** Regex source matched (after comment/string stripping) against each line.
	 *  Runner uses `new RegExp(pattern, pattern_flags ?? "gm")`. */
	pattern: string;
	/** Optional regex flags; default "gm". */
	pattern_flags?: string;
	/** Optional per-line exemption regex. If set and the raw (un-stripped) line
	 *  matches, the finding on that line is dropped. Useful for // SAFETY:
	 *  comments above an unsafe block, or @IBOutlet on implicitly-unwrapped. */
	exempt_if_line_matches?: string;
}

// ===========================================
// Tool Concurrency Classification
// ===========================================

/** Whether a tool call is safe to run concurrently with other calls */
export type ToolConcurrencyClass = "read_only" | "state_changing" | "unknown";

// ===========================================
// Session Turn End Summary
// ===========================================

/** Summary produced at end of an agent turn (SessionTurnEnd event) */
export interface TurnEndSummary {
	session_id: string;
	agent_name: string;
	/** Total tool calls in this turn */
	tool_call_count: number;
	/** Files written during this turn */
	files_written: string[];
	/** Files read during this turn */
	files_read: string[];
	/** Commands run during this turn */
	commands_run: string[];
	/** Warnings emitted during this turn */
	warning_count: number;
	/** Blocks emitted during this turn */
	block_count: number;
	/** Patterns detected across the turn (e.g., "edit-without-test", "repeated-failure") */
	turn_patterns: string[];
	/** Current sensitivity level at turn end */
	sensitivity_level: SensitivityLevel;
	/** Elapsed time since session start (ms) */
	turn_duration_ms: number;
}

// ===========================================
// Cross-Session Learned Rules
// ===========================================

/** A rule learned from repeated agent behavior, persisted across sessions */
export interface LearnedRule {
	/** The permission pattern (e.g., "Bash(npm test *)") */
	pattern: string;
	/** How many times this pattern was observed before learning */
	observation_count: number;
	/** "allow" — only safe patterns are learned */
	decision: "allow";
	/** When this rule was first observed */
	first_seen: string;
	/** When the threshold was crossed and the rule was persisted */
	learned_at: string;
	/** Session ID where the rule was learned */
	learned_in_session: string;
}

// ===========================================
// Env Var Safety Classification
// ===========================================

/**
 * Environment variables known to be safe as command prefixes.
 * These don't alter code execution semantics — they only control
 * output, locale, or build-tool behavior.
 */
export const SAFE_ENV_VARS = new Set([
	// Build/runtime flags
	"NODE_ENV",
	"NODE_OPTIONS",
	"CI",
	"DEBUG",
	"VERBOSE",
	"LOG_LEVEL",
	"RUST_LOG",
	"RUST_BACKTRACE",
	"GOEXPERIMENT",
	"GOFLAGS",
	"CGO_ENABLED",
	"PYTHONDONTWRITEBYTECODE",
	"PYTHONUNBUFFERED",
	"PIP_DISABLE_PIP_VERSION_CHECK",
	// Locale/terminal
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"COLORTERM",
	"FORCE_COLOR",
	"NO_COLOR",
	"TZ",
	"COLUMNS",
	"LINES",
	// Common tool configs
	"EDITOR",
	"VISUAL",
	"PAGER",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	// Package managers
	"NPM_CONFIG_LOGLEVEL",
	"YARN_SILENT",
	"CARGO_TERM_COLOR",
]);

/**
 * Environment variables that are DANGEROUS as command prefixes.
 * These can alter execution, inject code, or hijack library loading.
 * If ANY of these appear, the command is flagged regardless of what follows.
 */
export const DANGEROUS_ENV_VARS = new Set([
	"PATH",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"RUBYLIB",
	"RUBYOPT",
	"PERL5LIB",
	"PERL5OPT",
	"NODE_PATH",
	"HOME",
	"USER",
	"SHELL",
	"DOCKER_HOST",
	"KUBECONFIG",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"NPM_TOKEN",
]);

// ===========================================
// Escalation Request (evaluator → server.ts → policy classifier)
// ===========================================

/** Escalation request set by the evaluator when deterministic result is "allow"
 * but escalation criteria match. Consumed by server.ts to invoke the LLM classifier. */
export interface EscalationRequest {
	/** Trigger ID: "tainted_network_internal" | "external_url" | "high_step_budget" | "post_injection_action" */
	trigger: string;
	/** Human-readable summary (no secrets) */
	summary: string;
	/** Tool that triggered the escalation */
	tool_name: string;
	/** Redacted tool input (URLs redacted, file paths kept, content stripped) */
	tool_input_redacted: Record<string, string>;
	/** Current session sensitivity level */
	sensitivity_level: SensitivityLevel;
	/** Current tool call count */
	step_number: number;
	/** Last 10 entries from session.tool_sequence */
	recent_tool_sequence: string[];
}

// ===========================================
// LLM Policy Classifier Configuration
// ===========================================

/** Configuration for the LLM policy classifier */
export interface ClassifierConfig {
	/** Whether the classifier is enabled (default: false) */
	enabled: boolean;
	/** Operating mode — v1 supports only "shadow" */
	mode: "shadow" | "enforce";
	/** Inference provider type */
	provider: "groq" | "huggingface" | "openai_compatible" | "anthropic" | "claude_code";
	/** Full endpoint URL for chat completions */
	endpoint: string;
	/** Environment variable name containing the API key (never stored in config) */
	api_key_env: string;
	/** Model identifier */
	model: string;
	/** Request timeout in milliseconds (default: 3000) */
	timeout_ms: number;
	/** Maximum input tokens for evidence serialization (default: 800) */
	max_input_tokens: number;
	/** Confidence threshold for enforcement mode (default: 0.8) */
	confidence_threshold: number;
	/** Maximum classifier calls per session — tracked for metrics, NOT enforced (default: 50) */
	max_calls_per_session: number;
}

/** Classification result from the LLM policy classifier */
export interface PolicyClassification {
	/** Whether the action should be allowed or denied */
	label: "allow" | "deny";
	/** Confidence score 0.0 - 1.0 */
	confidence: number;
	/** One-sentence reasoning */
	reasoning: string;
	/** Which policy was violated (if any) */
	policy_id?: string;
}

/** Structured evidence envelope sent to the classifier (redacted, no raw content) */
export interface PolicyEvidence {
	// What's happening
	tool: string;
	action_class: string;
	target_summary: string;

	// Why it's uncertain
	trigger: string;
	trigger_reason: string;

	// Session context (aggregated, not raw)
	session_sensitivity: SensitivityLevel;
	step_number: number;
	taint_source_count: number;
	taint_source_levels: string[];
	recent_actions: string[];
	agent_role: AgentRole;
	files_written_count: number;
	errors_this_session: number;

	// Intent scope (if assigned)
	intent_goal?: string;
	intent_file_patterns?: string[];

	// Injection context
	injection_detected_in_session: boolean;
	steps_since_injection?: number;

	// Active policies to evaluate
	policies: PolicyRule[];
}

/** Declarative policy rule for the classifier to evaluate */
export interface PolicyRule {
	/** Unique policy identifier */
	id: string;
	/** Human-readable policy name */
	name: string;
	/** Natural language description for the LLM to evaluate against */
	description: string;
	/** Which escalation triggers this policy applies to */
	applies_to_triggers: string[];
	/** Which agent roles this policy applies to (omit for all) */
	applies_to_roles?: AgentRole[];
}

// ===========================================
// Phase 1 — Failure Recovery Channel
// ===========================================
// Types for the local failure-recovery channels (Channels 1, 2, 3, 5, 6).
// See docs/design/pre-post-pipelined-cloud-checks-and-failure-recovery.md.

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
	agent_source: AgentSource;
	tool_name: string;
	tool_input?: JsonObject;
	tool_use_id?: string;
	cwd?: string;
	timestamp: string;
	/** Canonical diagnostic text. Populated from the most-specific provider field. */
	error_message?: string;
	exit_code?: number;
	stderr?: string;
	stdout?: string;
	/** Set when Cursor's dedicated postToolUseFailure delivered the event. */
	is_interrupt?: boolean;
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
	agent_source: AgentSource;
	tool_name: string;
	tool_input?: JsonObject;
	tool_use_id?: string;
	cwd?: string;
	timestamp: string;
	signature: string;
	error_message?: string;
	exit_code?: number;
	stderr?: string;
	stdout?: string;
	triage?: TriageResult;
	recurrence?: {
		count: number;
		distinct_sessions: number;
	};
	recovery?: string;
	explanation?: string;
	rollback?: RollbackAssessment;
}
