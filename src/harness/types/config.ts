// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Guard Rules Configuration Types
// ===========================================

import type {
	ErrorMemoryConfig,
	ProjectWideCheckConfig,
	StructuralChecksConfig,
} from "./config-structural.js";
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
	crapScores?: Map<string, Map<string, number>> | undefined;
	/**
	 * Code-clone similarity pairs captured before the edit.
	 * Consumed by the PostToolUse code_clones block so old duplication in a
	 * touched file is not reported as a new agent warning.
	 */
	dryCloneBaseline?: import("../checks/dry-baseline.js").DryBaseline | undefined;
	/** When this baseline was captured */
	capturedAt: number;
	/** Count of suppression directives (@ts-expect-error, @ts-expect-error, eslint-disable, biome-ignore) */
	suppressionCount: number;
	/** Count of `as any` casts */
	asAnyCastCount: number;
	/** Count of non-null assertions (`foo!.bar`) */
	nonNullAssertionCount: number;
	/** Count of unjustified casts (as X without a // SAFETY: comment) */
	unjustifiedCastCount?: number;
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
	typeDensity?: import("../quality-checks/ratchet-metrics.js").TypeDensityCounts;
	/** Software/model/dependency version references captured before the edit. Used by
	 *  software_version_regression to detect stale-memory downgrades. Optional — older direct test callers fail open. */
	softwareVersions?: import("../quality-checks/software-version-regression.js").SoftwareVersionReference[];
	/** Per-primitive bare-unsafe-builtin counts before the edit, keyed by wrapper name; discovered_primitive_ratchet warns on any increase. Optional — older direct test callers fail open. */
	discoveredPrimitiveViolations?: Record<string, number> | undefined;
	/** Ambient-seam counts before the edit (plan 25 lane 2); seam_ratchet warns on any rise. Optional — fails open. */
	ambientSeams?: import("../quality-checks/ratchet-metrics.js").AmbientSeamCounts | undefined;
	/** Assertion-strength counts before the edit (plan 25 lane 4); assertion_strength_ratchet warns on pure weakening. Optional — fails open. */
	assertionStrength?: import("../quality-checks/ratchet-metrics.js").AssertionStrengthCounts | undefined;
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

/**
 * Per-edit coverage enforcement (apply-before-disk overlay + budget-gate). See
 * `evaluator/coverage-write-guard.ts` and
 * `docs/design/per-edit-coverage-enforcement.md`.
 *
 * **DEFAULT ON (opt-OUT per repo).** Every repo enforces unless it sets
 * `"per_edit_coverage": { "enabled": false }` in .interlinked/guard-rules.local.json.
 * A fast suite (e.g. wardotapp, ~1-2s) enforces in-band per edit; a big suite
 * (this repo, ~16k tests) exceeds budget_ms and DEFERS to the commit-intercept
 * gate (full suite+coverage+CRAP at `git commit`), so enforcement still holds at
 * commit cadence; a repo with no test tooling fail-opens (loud warning, no block).
 */
export interface PerEditCoverageConfig {
	/** Master switch. Default: true (opt-out via local config). Short-circuits to allow when off. */
	enabled: boolean;
	/**
	 * What a coverage regression does:
	 *   - "block": refuse the edit before the real write (strict TDD).
	 *   - "warn":  loaded-but-non-blocking (the guard returns allow even when it
	 *     finds an uncovered added line; reserved for a future warn surface).
	 * Only "block" runs the overlay+suite today; "warn" is a no-op gate.
	 */
	mode: "block" | "warn";
	/**
	 * Per-edit sync budget in ms. When the rolling suite-runtime estimate is at
	 * or above this, the guard does NOT run the suite per-edit — it records a
	 * deferred coverage obligation and allows (commit-time enforcement is a later
	 * step). Default: 25_000 (the documented PreToolUse cloud-sync budget).
	 */
	budget_ms: number;
	/**
	 * Languages the overlay coverage run covers. **Default: `["js", "ts", "python"]`**
	 * — JS/TS via vitest + v8, Python via pytest + coverage.py. A `.py` edit reaches
	 * the gate exactly like a `.ts` edit (affected-test selection keeps both fast).
	 */
	languages: string[];
	/**
	 * Red-bar (per-edit TDD) enforcement. **Default: true (opt-out).** When true,
	 * an edit whose overlay run leaves the test suite RED — i.e. the suite ran and
	 * one or more tests FAILED (`CoverageRunResult.testsPassed === false`) — is
	 * BLOCKED before the real write, naming the failing test(s). This is a HARDER
	 * failure than a coverage gap, so it is checked BEFORE the uncovered-line /
	 * coverage-drop decision. The agent satisfies it by writing code + the test
	 * that keeps the suite green together in one MultiEdit; you cannot save a
	 * transiently-red state. A runner that cannot establish pass/fail
	 * (`testsPassed === null` — runner unavailable / errored) fail-opens exactly
	 * as the coverage block does. When false (opt-out) the red-bar check is a
	 * pure no-op and behavior is identical to the coverage-only gate.
	 */
	block_on_test_failure?: boolean;
	/** Flake double-run (DW P0.2): opt-in, default off. A test-file edit re-runs
	 *  the affected scoped suite at PostToolUse; a pass↔fail flip or a changed
	 *  failing-set fires a non-blocking `[interlinked:flake]` warning (doubles
	 *  latency — hence opt-in). See `evaluator/test-flake-guard.ts`. */
	flake_check?: boolean;
	/**
	 * CRAP (Change Risk Anti-Patterns) per-edit enforcement. **Default: true
	 * (opt-out).** CRAP(fn) = cyclomatic² · (1 − coverage)³ + cyclomatic — a
	 * function is "CRAPpy" when it is BOTH complex AND under-covered. When true,
	 * an edit that leaves any function it ADDED or TOUCHED with a CRAP score at or
	 * above {@link crap_threshold} is BLOCKED before the real write, naming the
	 * function + its CRAP / cyclomatic / coverage and advising "reduce complexity
	 * or add coverage". Computed from the SAME apply-before-disk overlay run as the
	 * coverage block (no second suite run), and checked AFTER the uncovered-added-
	 * line / coverage-drop decision (a flat coverage gap is the more basic failure;
	 * CRAP is the "complex AND under-covered" escalation). A runner that cannot
	 * measure coverage (`ok:false`) or an unavailable cyclomatic analyzer fail-opens
	 * exactly as the coverage block does. When false (an explicit opt-out) the CRAP check is
	 * a pure no-op and behavior is identical to the coverage-only gate.
	 */
	block_on_crap?: boolean;
	/**
	 * **Debt mode (pair-scoped TDD).** **Default: true since 2026-06 (opt-OUT
	 * — shipped in `rules/default-config.ts`; this doc previously said opt-in,
	 * a doc↔code drift fixed 2026-07-17).** When on, the uncovered-added-line
	 * block is replaced by the coverage-debt lifecycle (`coverage-debt.ts` +
	 * `obligation-ledger-io.ts`): a first uncovered edit OPENS debt and is
	 * ALLOWED; the agent may keep editing that source or its companion test
	 * freely; an edit that wanders to an unrelated file while debt is open is
	 * BLOCKED. Ownership-scoped (2026-07-17): only debts the SAME session
	 * opened can block its wander — another session's debt surfaces as a
	 * once-per-session heads-up note instead. Discharge is optimistic on a
	 * companion-test edit; `commit-gate.ts` stays the ground-truth backstop.
	 * Setting false restores strict uncovered/red blocking (repo-owner lever;
	 * deliberately NOT advertised in the block message). See
	 * `docs/design/coverage-debt-tdd.md`.
	 */
	debt_mode?: boolean;
	/**
	 * Max concurrently-open coverage debts before an out-of-pair edit blocks
	 * (only consulted when {@link debt_mode} is on). **Default: 1** (strict pair
	 * rule); a larger value relaxes toward the commit backstop. Counts only the
	 * CURRENT session's open debts (ownership scoping, 2026-07-17) — foreign
	 * debts inform but never wall. This is the scoped escape the wander block
	 * message names.
	 */
	debt_wip_limit?: number;
	/** CRAP score at/above which a touched function blocks when
	 *  {@link block_on_crap} is on. Default 30 (McCabe/SonarQube cutoff).
	 *  Ignored when `block_on_crap` is off. */
	crap_threshold?: number;
	/** %-drop backstop tolerance (Class-2 knob, plan 25). Default 0.005;
	 *  raise only for float/scope wobble, never to permit real regressions. */
	drop_epsilon?: number;
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

/** Verification-before-stop nudge configuration. Six independent
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
 *    - warn_fixture_leaks:     untracked src/**\/_*.ts-shaped files whose
 *                              basename appears in a writeFixture()-shaped
 *                              call in a test — afterAll cleanup didn't run
 *    - warn_unresolved_red:    a check/test OBSERVED red this session that
 *                              never went green again (non-test tsc/build/lint
 *                              from observed_checks, plus stayed-red TDD
 *                              cycles; the green→red regression case is
 *                              handled by the always-on tdd-regression nudge).
 *  Master `enabled` switch gates all six together. */
export interface VerificationStopChecksConfig {
	enabled: boolean;
	warn_unverified_code: boolean;
	warn_verify_not_run: boolean;
	warn_ui_not_interacted: boolean;
	warn_stubs_introduced: boolean;
	warn_fixture_leaks: boolean;
	warn_unresolved_red: boolean;
	/** Stop nudge for outstanding cross-file spec drift (ledger findings
	 *  captured at PostToolUse; optional for config back-compat, default on). */
	warn_spec_drift?: boolean;
	/** Stop nudge for ingested review findings with neither a touching edit
	 *  nor an ack (optional for config back-compat, default on). */
	warn_review_findings?: boolean;
	/** Stop nudge for tests observed running slower than expected this
	 *  session (measurement integrity — a slow test can time out Stryker's
	 *  mutation dry run and poison kill-measurement for its whole file; see
	 *  slow-test-stop-check.ts). Optional for config back-compat, default on. */
	warn_slow_tests?: boolean;
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

// Structural / project-wide / error-memory config types live in a sibling
// module (config-structural.ts) to keep this file under the per-file line
// cap. Re-exported here so the public surface of ./config.ts is unchanged.
export type {
	ErrorMemoryConfig,
	ErrorRecord,
	ProjectWideCheckConfig,
	StructuralChecksConfig,
} from "./config-structural.js";
