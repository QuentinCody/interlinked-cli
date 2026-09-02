// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Session Trajectory & TDD-Cycle Types
// ===========================================

import type { ActiveSkillRecord } from "./rules.js";
import type { SensitivityLevel, TaintSource } from "./taint.js";
import type { TddCycle, TddCycleState } from "./tdd-cycle.js";

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
	/** Durable, non-expiring subset of `commands_run`: only commands
	 *  `isTestRunnerCommand` recognizes as a test-runner invocation, kept at
	 *  full text (up to 2000 chars — a file-path argument must not fall past
	 *  the cut) so a test run recorded early in a long session still reads
	 *  as a signal after `commands_run`'s 100-entry ring buffer has aged it
	 *  out under unrelated Bash traffic. Bounded to `TEST_COMMANDS_RUN_CAP`
	 *  entries, oldest dropped first. Populated in
	 *  `session-state-mutators.ts::trackCommand`; consulted by
	 *  `characterize-campaign-target.ts::hasTestSignalFor`. Optional so a
	 *  session hydrated from a pre-fix snapshot reads as `[]`. */
	test_commands_run?: string[];
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
	active_skills?: Map<string, ActiveSkillRecord> | undefined;
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
	trajectoryDetector?: import("../trajectory.js").TrajectoryDetector;
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
	/** Set (ms epoch) when this session receives a debt-focus wander block —
	 *  arms the inline-exec evasion counter (`debt-evasion.ts`). */
	debt_wander_blocked_at_ms?: number;
	/** Bash inline-exec commands (`node -e`, `python -c`, piped/heredoc'd
	 *  interpreter input) run AFTER the block above. Surfaced once in the Stop
	 *  reflection; visibility only — never blocks. */
	inline_exec_after_debt_block?: number;
	/**
	 * Armed block fingerprints (P1 trajectory) — one per PreToolUse block
	 * finalized this session, each with a time-boxed arming window. A later
	 * candidate event is matched against these to spot a refused action
	 * resurfacing through another channel. IN-MEMORY only (not serialized to
	 * the session snapshot) — a stale block should not survive a daemon
	 * restart. Managed by `trajectory/block-fingerprint-session.ts`.
	 */
	block_fingerprints?: import("../trajectory/block-fingerprint.js").BlockFingerprint[];
	/** Workaround signals observed this session (deduped by detector+rule),
	 *  surfaced once in the Stop reflection. Detection is shadow — never blocks. */
	workaround_signals?: import("../trajectory/block-fingerprint-session.js").WorkaroundSignal[];
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
	 * Observed-outcome tracking for verification commands (typecheck /
	 * build / lint, plus `test-suite` for whole-suite test runs the
	 * per-file TDD cycle can't key), keyed by check kind. Distinct from
	 * `verification_observed` (which records intent — "the agent ran a
	 * typechecker") — this records the *result* — "the typechecker went
	 * red and never went green again." Populated by
	 * `trackVerificationOutcome` in `server/post-tool-pipeline.ts` from a
	 * completed Bash PostToolUse; read at Stop by the `unresolved-red`
	 * reflection nudge (the check-level analogue of the TDD stayed-red /
	 * regression nudges, which cover per-file test reds). Optional so
	 * hand-built test fixtures and older snapshots hydrate cleanly. See
	 * `verification-stop-checks.ts::formatUnresolvedRedWarning`.
	 */
	observed_checks?: Map<string, ObservedCheck>;
	/**
	 * Verification-before-stop tracking. Stubs / TODOs / disabled tests /
	 * not-implemented throws introduced via Write/Edit `content` /
	 * `new_string` this session. Populated by the post-tool evaluator's
	 * stub scanner (`scanForStubs`); read at Stop by
	 * `formatStubsIntroducedWarning`. Capped at `STUB_INTRODUCED_CAP`
	 * entries to keep long-session memory bounded.
	 */
	stubs_introduced?: Array<{ file: string; kind: string; snippet: string }>;
	/**
	 * Cross-file spec-drift findings outstanding as of the session's most
	 * recent markdown edit (captured at PostToolUse by the spec-ledger phase,
	 * consumed by the Stop nudge). Replaced per edit, capped at 10 entries.
	 */
	spec_drift_outstanding?: Array<{ file: string; line: number; message: string }>;
	/**
	 * Most recently captured plan declared by the agent — populated by
	 * `plan-capture.ts` on PreToolUse (TaskCreate / ExitPlanMode) or
	 * UserPromptSubmit (structured `## Plan` markdown, behind the
	 * `plan_capture.parse_userprompt` config flag). Each capture is
	 * separately persisted append-only to
	 * `.interlinked/plans/<session_id>.jsonl`; this field mirrors the
	 * newest entry for fast in-memory access. Optional so test fixtures
	 * with bare-bones session shapes don't need to wire it in. Read by
	 * the shipped plan-drift Stop nudge (`plan-drift.ts`, wired via
	 * `server/lifecycle-events.ts`); the Tier 2 cloud Plan/Policy
	 * Approver is the remaining future consumer.
	 */
	declared_plan?: import("./plan.js").CapturedPlan | undefined;
	/**
	 * Git working-tree snapshot captured at the first event of the session.
	 * Used by the `git-session-scope-gate` PreToolUse Bash check to
	 * distinguish files this session wrote from files that were already
	 * dirty/staged/untracked when the agent started — the latter are
	 * "pre-existing" and trigger an ask before a commit/push/add subsumes
	 * them. Cached for the lifetime of the session and never re-snapshotted.
	 * Set to `{ head_sha: "", modified/staged/untracked: empty }` when the
	 * cwd is not a git repo (the gate then degrades to allow-with-warning).
	 * Optional so older snapshots / bare test fixtures hydrate cleanly.
	 */
	git_session_baseline?: {
		modified: Set<string>;
		staged: Set<string>;
		untracked: Set<string>;
		head_sha: string;
	} | undefined;
	/**
	 * Per-file ring buffer of recent line edits. Consumed by
	 * `add_then_revert_loop` (sequence-checks §3.21) to detect content-hash
	 * cycling within the same file/line-range. Capped at
	 * RECENT_LINE_EDITS_PER_FILE_CAP entries per file (drop oldest on
	 * overflow). Optional so older snapshots and bare test fixtures hydrate
	 * cleanly; detectors return [] when undefined. Population logic lives
	 * in `session-state.ts::recordEvent` and is best-effort.
	 */
	recent_line_edits?: Map<
		string,
		Array<{
			range: { start: number; end: number };
			content_hash: string;
			at_step: number;
		}>
	> | undefined;
	/**
	 * Session-scoped mapping from literal hash to the set of files where
	 * the literal was introduced this session. Consumed by
	 * `magic_literal_cross_file_proliferation` (sequence-checks §3.18) at
	 * Stop to surface cross-file repetition the per-file
	 * `magic_literal_in_conditional` check can't see. Optional for
	 * hydration safety.
	 */
	literal_occurrences?: Map<string, Set<string>> | undefined;
	/**
	 * LG-3 read-view snapshots (edit-contract-hardening.md): per file, the
	 * content state this session last DISPLAYED — full-content sha256, 32-bit
	 * per-line hashes (for locating where drift begins without retaining the
	 * text), the step it was seen, and the displayed line ranges (null = whole
	 * file). In-memory best-effort like `recent_line_edits`: not snapshotted,
	 * absent ⇒ every consumer fails open. Populated in `read-provenance.ts`.
	 */
	file_views?: Map<string, FileView> | undefined;
	/**
	 * LG-5 edit-mechanics accounting for the Stop reflection: doomed-edit
	 * blocks, one-round-trip rescues (a successful write to the doomed file
	 * within 2 steps), stale-read and blind-edit observations, plus the
	 * repeat gate for stale warnings. In-memory best-effort; absent ⇒ zero.
	 */
	edit_mechanics?: EditMechanics | undefined;
}

/** One file's last-displayed content state (LG-3). */
export interface FileView {
	/** sha256 hex of the full content as displayed/refreshed. */
	hash: string;
	/** FNV-1a 32-bit hash per line — drift localization without text retention. */
	line_hashes: Uint32Array;
	/** `tool_call_count` at capture time. */
	at_step: number;
	/** Displayed 1-based inclusive line ranges; null = whole file seen. */
	ranges: Array<[number, number]> | null;
}

/** Session edit-mechanics counters (LG-5). */
export interface EditMechanics {
	doomed: number;
	rescued: number;
	stale_reads: number;
	blind_edits: number;
	/** Last doom, for rescue attribution. */
	last_doom?: { file: string; step: number } | undefined;
	/** Stale-read repeat gate: `${path}::${liveHash}` already warned. */
	stale_warned: Set<string>;
}

// ===========================================
// Observed verification-check outcomes
// ===========================================

/**
 * Last observed red/green outcome of one verification check this session:
 * the non-test axes (typecheck / build / lint) plus `test-suite` — a
 * whole-suite test run (`vitest run` / `npm test` with no file argument),
 * which the per-file {@link TddCycle} tracker cannot key (no target file).
 * Stored in `SessionTrajectory.observed_checks` keyed by `kind`; read at
 * Stop by `formatUnresolvedRedWarning` to nudge when a check went red and
 * the session ended without it going green.
 *
 * Per-file test runs are deliberately NOT tracked here — the TDD cycle
 * (`tdd_cycles`) owns per-file red/green, and double-tracking would make
 * the unresolved-red nudge report the same red twice.
 *
 * `last-status-wins`: a later green clears a prior red (sets `status:
 * "green"`, records `green_at`); a later red after a green re-reds it.
 * All `*_at` step counters and `detail` are optional and omitted (per
 * exactOptionalPropertyTypes) when absent.
 */
export interface ObservedCheck {
	/** Which verification axis this entry tracks. */
	kind: "typecheck" | "build" | "lint" | "test-suite";
	/** Last observed outcome: `red` (failed) or `green` (passed). */
	status: "red" | "green";
	/** tool_call_count when the check most recently went red. */
	red_at?: number;
	/** tool_call_count when the check most recently went green. */
	green_at?: number;
	/** Short human-readable detail (the command, truncated) for logs. */
	detail?: string;
}

// ===========================================
// TDD Cycle Tracking
// ===========================================
// Shapes live in ./tdd-cycle.js (this file is at the per-file line cap);
// re-exported here so existing importers keep working unchanged.

export type { TddCycle, TddCycleState };

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
	/**
	 * Line numbers where this check most recently fired on this file.
	 * Used by `checkPersistentWarningEscalation` (refinement 2026-05) to
	 * suppress escalation when the agent's current edit didn't touch any
	 * line near a persistent finding — the canonical FP shape, where a
	 * pre-existing warning at line N re-fires on every unrelated edit to
	 * the same file. Empty array means "no line info on file-level checks
	 * like export_surface"; absent means "legacy record predating this
	 * field". Both are treated as fall-back-to-issue_count-only.
	 */
	last_lines?: number[] | undefined;
	/**
	 * Whether a persistent-warning escalation has been emitted for this
	 * record. Rate-limit: at most one escalation per (file, check) per
	 * session, so a stale FP does not amplify across an edit storm.
	 */
	escalation_emitted?: boolean;
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

// ===========================================
// Endpoint / Route-Map Types
// (moved to ./session-endpoint.ts; re-exported here so existing
//  `types/session.js` importers keep resolving them unchanged)
// ===========================================

export type {
	AuthChainEntry,
	Endpoint,
	EndpointFramework,
	ParamSpec,
	RouteInfo,
} from "./session-endpoint.js";

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
