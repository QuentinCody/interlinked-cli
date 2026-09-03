// ===========================================
// TDD-cycle Stop reflection checks
// ===========================================
// Split out of lifecycle-stop-warnings.ts (line-cap pressure, 2026-09).
// Owns every Stop-time check that reads `session.tdd_cycles` /
// `session.observed_checks` / commit history: the green→red regression
// nudge, the stayed-red nudge, and the WIP-commit cleanup nudge. Same
// name/signature as before the split — co-located with the constants and
// helpers only these checks need.

import { isSuiteSourcedRed } from "../behavioral-checks-tdd-red-evidence.js";
import { collectWipCommitSubjects, formatWipCommitsNudge } from "../commit-cadence.js";
import { ALL_TESTS_SENTINEL } from "../server-tdd-cycle.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import {
	formatTddRegressionWarning,
	formatUnresolvedRedWarning,
} from "../verification-stop-checks.js";
import type { ServerRuntime } from "./runtime-context.js";

/** TDD-cycle state value that signals "test went green earlier this session
 *  and is now red again." Extracted constant so the conditional reads as
 *  intent, not a magic string. */
const TDD_CYCLE_REGRESSION = "regression";

/** TDD-cycle state value for a test that failed and has not (yet) gone
 *  green — the "stayed red" case the unresolved-red nudge surfaces.
 *  Distinct from `regression` (green→red), which `checkTddRegression`
 *  owns, so the two nudges never double-fire on the same cycle. */
const TDD_CYCLE_RED = "red";

/** Observed-check status value for a non-test check (tsc/build/lint) that
 *  ended the session red. */
const OBSERVED_CHECK_RED = "red";

/** A Bash command that plausibly created a commit — the cheap pre-gate that
 *  keeps the WIP-commit git shell-out off read-only sessions. Loose on
 *  purpose (a false match just costs one `git log` whose range is empty). */
const GIT_COMMIT_CMD_RE = /\bgit\b[^\n|]*\bcommit\b/;

/** TDD regression — a test that was green earlier this session is now red,
 *  so this session's edits broke working behavior. */
export function checkTddRegression(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const tddRegressions: Array<{ sourceFile: string }> = [];
	for (const cycle of session.tdd_cycles.values()) {
		if (
			cycle.state === TDD_CYCLE_REGRESSION &&
			!isSuiteSourcedRed(session, cycle)
		) {
			tddRegressions.push({ sourceFile: cycle.source_file });
		}
	}
	const warning = formatTddRegressionWarning({ regressions: tddRegressions });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: tdd-regression (${tddRegressions.length})`);
	return warning;
}

/** A TDD cycle that ended the session in the stayed-red case: state `red`
 *  (NOT `regression` — that's `checkTddRegression`'s) and the red has not
 *  been cleared by a later green (`green_at` absent, or it predates the
 *  current `red_at`). */
function isStayedRedCycle(cycle: {
	state: string;
	red_at?: number | undefined;
	green_at?: number | undefined;
}): boolean {
	if (cycle.state !== TDD_CYCLE_RED) return false;
	return cycle.green_at === undefined || cycle.green_at < (cycle.red_at ?? 0);
}

/** Unresolved-red reflection nudge — a check or test went red this session
 *  and the session ended without it going green again. redChecks come from
 *  `observed_checks` (non-test tsc/build/lint); redTests are stayed-red TDD
 *  cycles (the green→red regression case is excluded — `checkTddRegression`
 *  covers it). Reflection only; never blocks. */
function collectRedChecks(
	session: SessionTrajectory,
): Array<{ kind: string; detail?: string | undefined }> {
	const redChecks: Array<{ kind: string; detail?: string | undefined }> = [];
	for (const observed of (session.observed_checks ?? new Map()).values()) {
		if (observed.status === OBSERVED_CHECK_RED) {
			redChecks.push({ kind: observed.kind, detail: observed.detail });
		}
	}
	const suiteRun = (session.test_runs as SessionTrajectory["test_runs"] | undefined)?.get(ALL_TESTS_SENTINEL);
	if (
		suiteRun?.status === "fail" &&
		!redChecks.some((check) => check.kind === "test-suite")
	) {
		redChecks.push({ kind: "test-suite" });
	}
	return redChecks;
}

function collectStayedRedTests(session: SessionTrajectory): Array<{ sourceFile: string }> {
	const redTests: Array<{ sourceFile: string }> = [];
	for (const cycle of session.tdd_cycles.values()) {
		if (isStayedRedCycle(cycle) && !isSuiteSourcedRed(session, cycle)) {
			redTests.push({ sourceFile: cycle.source_file });
		}
	}
	return redTests;
}

export function checkUnresolvedRed(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const redChecks = collectRedChecks(session);
	const redTests = collectStayedRedTests(session);
	const warning = formatUnresolvedRedWarning({ redChecks, redTests });
	if (warning === null) return null;
	ctx.log(
		`Verify-before-stop: unresolved-red (${redChecks.length} checks, ${redTests.length} tests)`,
	);
	return warning;
}

/** WIP-commit cleanup nudge (Stop backlog 3B) — the session created commits
 *  whose subjects read as scratch (`wip` / `fixup` / `tmp` / …). The range is
 *  `git_session_baseline.head_sha..HEAD` (session-start HEAD), so only THIS
 *  session's commits count; autosquash `fixup!`/`squash!` markers are
 *  excluded in the detector. Gated to sessions that ran a git-commit-shaped
 *  command so read-only Stops never shell out. Reflection only; never
 *  blocks, never suggests pushing. */
export function checkWipCommits(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	const baselineSha = session.git_session_baseline?.head_sha;
	if (!baselineSha) return null;
	if (!session.commands_run.some((c) => GIT_COMMIT_CMD_RE.test(c))) return null;
	const wipSubjects = collectWipCommitSubjects(event.cwd || ctx.cwd, baselineSha);
	const warning = formatWipCommitsNudge({ wipSubjects });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: wip-commits (${wipSubjects.length})`);
	return warning;
}
