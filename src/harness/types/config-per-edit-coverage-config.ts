// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Per-Edit Coverage Config Type
// ===========================================
//
// Split out of config.ts (2026-09-02) to keep that file under the per-file
// line cap. Re-exported from config.ts so the public surface of ./config.ts
// is unchanged for existing importers.

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
