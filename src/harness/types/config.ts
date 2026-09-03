// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Guard Rules Configuration Types
// ===========================================

import type {
	ErrorMemoryConfig,
	ProjectWideCheckConfig,
	StructuralChecksConfig,
} from "./config-structural.js";
import type { PerEditCoverageConfig } from "./config-per-edit-coverage-config.js";
import type { VerificationStopChecksConfig } from "./config-verification-stop-checks-config.js";
import type { ClassifierConfig } from "./policy.js";
import type { GuardRule } from "./rules.js";
import type { OutputScanningConfig, TaintTrackingConfig } from "./taint.js";

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
	/** `dependency_audit` only: prefer osv-scanner over per-ecosystem tools (npm audit / pip-audit / cargo audit / govulncheck) when it's on PATH. Default: true. Set false to force the legacy per-ecosystem commands. */
	use_osv_scanner?: boolean;
	/**
	 * `transient_debt` only: enforcement strength for the deferred-finding
	 * ledger. `block` (default) refuses a write that walks away from an open
	 * deferred finding once its slack is spent; `warn` runs the whole lifecycle
	 * but never refuses; `off` disables it. Note `warn` reproduces the old
	 * permanent-demotion behaviour — a finding nobody ever comes back for.
	 */
	mode?: "block" | "warn" | "off";
	/**
	 * `transient_debt` only: how many edits to UNRELATED files a deferred
	 * finding tolerates before the gate blocks. Default 1 — see
	 * `DEFAULT_TRANSIENT_SLACK` for why zero is wrong.
	 */
	slack?: number;
	/** `dependency_audit` only: when osv-scanner is used, pass `--offline` (requires `osv-scanner scan --download-offline-databases` to have run at least once). Avoids osv.dev network round-trips on every edit. */
	offline?: boolean;
	/** `affected_tests` only: direct-importer companion-test cap (default DEFAULT_MAX_DEPENDENT_TESTS in quality-checks/test-dispatchers.ts). */
	max_dependent_tests?: number;
}

// ===========================================
// Diff-Aware Filtering
// ===========================================

/** Controls which checks use diff-aware filtering to suppress pre-existing issues */
export interface DiffAwareConfig {
	/** Master switch — true = suppress pre-existing findings; false = report all (default: false) */
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
	/** Sibling project roots that compose this workspace. Agents may write to
	 *  these in addition to the primary root. Relative paths resolve against the
	 *  project root (e.g., "../interlinked-cloud"). Distinct from
	 *  repo_confinement_allowlist (absolute escape hatches like ~/.claude):
	 *  linked_projects are declared, auditable workspace members — the
	 *  multi-repo workspace model. Confinement stays bounded to this explicit
	 *  set; it is never "write anywhere". */
	linked_projects?: string[];
	/** Tools that must be available. Missing required tools cause warnings instead of silent skips. */
	required_tools?: import("../check-engine/types.js").ToolId[];
	/** When true, unknown skip reasons (not in skip_allowlist) cause exit code 1 in verify */
	strict_skips?: boolean;
	/** Skip reason categories that are acceptable in strict mode */
	skip_allowlist?: string[];
	/** Diff-aware filtering: when enabled, only report newly-introduced issues (default: disabled) */
	diff_aware?: DiffAwareConfig;
	/** LLM policy classifier for ambiguous PreToolUse cases */
	policy_classifier?: ClassifierConfig;
	/** ML content scanner (OpenAI privacy-filter etc.) for PreToolUse diff/command/egress content + PostToolUse Read/Grep taint */
	content_scanner?: import("../content-scanner/types.js").ContentScannerConfig | undefined;
	/** Auto-coordination: periodic read-only check-in with MCP server */
	auto_coordination?: import("../auto-coordinate.js").AutoCoordinationConfig;
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
	 * loaded, but with substitution off its only live consumer is
	 * PostToolUse sibling expansion (sibling-expansion.ts); it is also
	 * read for the SessionStart freshness warning. Impact analysis, the
	 * project graph, and structural checks build their own dependency
	 * graphs and do NOT use it. Re-enable via this flag or
	 * `INTERLINKED_GREP_ACCELERATOR=1`.
	 */
	grep_acceleration?: {
		/** Default: false. Set to true to restore the block-and-answer path. */
		substitution_enabled?: boolean;
	};
	/** Plan-capture (PB&J Free-CLI item #2) — detects TaskCreate / ExitPlanMode /
	 *  structured `## Plan` user prompts. See PlanCaptureConfig. */
	plan_capture?: PlanCaptureConfig;
	/** Git session-scope gate (PB&J Free-CLI item #7) — asks before git add/
	 *  commit/push touches files outside session.files_written ∪ baseline. */
	git_session_scope_gate?: GitSessionScopeGateConfig;
	tsc_overlay?: { mode: "sidecar" | "in-process" | "off" }; // RSS-isolation fix; DEFAULT "sidecar"
	/** Per-edit coverage enforcement (apply-before-disk overlay + budget-gate).
	 *  DEFAULT ON — opt-OUT per repo (enabled:false). See PerEditCoverageConfig and
	 *  `evaluator/coverage-write-guard.ts`. */
	per_edit_coverage?: PerEditCoverageConfig;
	/** Per-edit mutation gate (DEFAULT OFF; capability-aware — spec §12; see mutation/gate.ts). */
	per_edit_mutation?: import("../mutation/gate.js").PerEditMutationConfig;
	/** Next-gen trajectory engine in SHADOW mode (DEFAULT ON): every firing rule
	 *  surfaces as a non-blocking `[interlinked:trajectory]` metric, never blocks.
	 *  See `server/trajectory-shadow.ts`. Set enabled:false to silence. */
	trajectory_shadow?: { enabled: boolean };
	/** Session-scratchpad write policy (the host-provisioned
	 *  `<temp-root>/…/<session-id>/scratchpad`). `code_write_mode` governs
	 *  agent-AUTHORED code-extension writes there: "block" (default) redirects
	 *  them to <repo>/scratch/ — gated, searchable, durable — "warn" nudges
	 *  only, "off" disables. Non-code writes (downloads, extractions, outputs)
	 *  are always allowed; the mandatory tmp-secrets scan is separate and not
	 *  governed by this mode. See `evaluator/scratchpad-write-guard.ts`. */
	scratchpad_guard?: { code_write_mode?: "block" | "warn" | "off" };
	/** Cross-file spec fact ledger + drift warnings on markdown edits
	 *  (docs/design/spec-audit-runtime-checks.md §3.2). Default on. */
	spec_checks?: { enabled?: boolean };
	/** Edit-contract checks (edit-contract-hardening.md LG-3/LG-4).
	 *  `stale_read` (default "warn"): content-hash drift warning when an edit
	 *  targets a file changed since this session last displayed it.
	 *  `blind_edit` (default "measure"): edits anchored on never-displayed
	 *  lines — "measure" records recurrence rows only; "warn" also surfaces
	 *  the warning; "off" disables. Promotion path is measured FP rate. */
	edit_contract?: {
		stale_read?: "warn" | "off";
		blind_edit?: "measure" | "warn" | "off";
	};
	/** SessionEnd scratchpad archive sweep (DEFAULT ON) — see `scratchpad-archive.ts`. */
	scratchpad_archive?: ScratchpadArchiveConfig;
	/** SessionEnd baseline auto-fold, tighten-only (DEFAULT ON) — `baseline-autofold.ts`. */
	baseline_autofold?: { enabled?: boolean };
}

/** SessionEnd scratchpad archive sweep settings. Caps exist so a session that
 *  extracted a package tree can't bloat `.interlinked/` — everything skipped
 *  is recorded in the manifest (no silent truncation). */
export interface ScratchpadArchiveConfig {
	/** Default: true. */
	enabled?: boolean;
	/** Per-file size ceiling in bytes (default 1 MiB). */
	max_file_bytes?: number;
	/** Total copied-bytes budget per session (default 24 MiB). */
	max_total_bytes?: number;
	/** Maximum files archived per session (default 2000). */
	max_files?: number;
	/** Extra path globs (relative to the scratchpad root) excluded from the
	 *  sweep, on top of the built-in dir/extension excludes and the
	 *  foreign-project-root rule. Use when a bulk tree carries no
	 *  `package.json`/`.git` marker of its own. */
	archive_excludes?: string[];
}

/** Plan-capture configuration. Master toggle + structured-userprompt parser
 *  (default off — false-positive risk). */
export interface PlanCaptureConfig {
	enabled: boolean;
	parse_userprompt: boolean;
}

/** Config for the PreToolUse Bash git-session-scope gate. See
 *  `evaluator/git-session-scope-gate.ts` for the parser + verdict logic. */
export interface GitSessionScopeGateConfig {
	/** Master switch. Default: false (off until proven on real sessions). */
	enabled: boolean;
	/** What to do when the operation includes files outside the session's
	 *  writes + baseline: "ask" (confirmation), "block" (refuse), "off"
	 *  (loaded-but-disabled — same effect as enabled=false). */
	mode: "ask" | "block" | "off";
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

// Pre-edit baseline / per-edit-coverage / verification-stop-checks config
// types live in sibling modules to keep this file under the per-file line
// cap. Re-exported here so the public surface of ./config.ts is unchanged.
export type { PerEditCoverageConfig } from "./config-per-edit-coverage-config.js";
export type { PreEditBaseline } from "./config-pre-edit-baseline.js";
export type { VerificationStopChecksConfig } from "./config-verification-stop-checks-config.js";

// Structural / project-wide / error-memory config types live in a sibling
// module (config-structural.ts) to keep this file under the per-file line
// cap. Re-exported here so the public surface of ./config.ts is unchanged.
export type {
	ErrorMemoryConfig,
	ErrorRecord,
	ProjectWideCheckConfig,
	StructuralChecksConfig,
} from "./config-structural.js";
