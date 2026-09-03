// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Verification Stop-Checks Config Type
// ===========================================
//
// Split out of config.ts (2026-09-02) to keep that file under the per-file
// line cap. Re-exported from config.ts so the public surface of ./config.ts
// is unchanged for existing importers.

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
