// ===========================================
// Code-file-verification Stop reflection checks
// ===========================================
// Split out of lifecycle-stop-warnings.ts (line-cap pressure, 2026-09).
// Owns `buildVerificationStopWarnings` (the orchestrator) and every check*
// helper it composes, except the three TDD-cycle checks that moved to
// lifecycle-stop-warnings-tdd-cycle-checks.ts (imported back in here so the
// orchestrator still calls them in the same order).

import { readFileSync } from "node:fs";
import { checkDeadOnArrival } from "../dead-on-arrival.js";
import { formatDebtEvasionStopLine } from "../debt-evasion.js";
import { checkFixtureLeaks } from "../fixture-leak.js";
import { checkMutationKillEvidence } from "../mutation-kill-evidence-stop-check.js";
import { checkSlowTests } from "../slow-test-stop-check.js";
import {
	formatReviewFindingsWarning,
	formatSpecDriftWarning,
} from "../spec-stop-checks.js";
import { formatWorkaroundStopLine } from "../trajectory/block-fingerprint-session.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import {
	detectUntestedExports,
	formatUntestedExportsWarning,
} from "../untested-exports-stop-check.js";
import {
	countCodeFilesEdited,
	countDocFactSourcesEdited,
	countUiFilesEdited,
	countVerifyCommands,
	formatBisectNotResetWarning,
	formatDeferredCoverageWarning,
	formatDocMarkerDriftWarning,
	formatStubsIntroducedWarning,
	formatUiNotInteractedWarning,
	formatUnverifiedCodeWarning,
	formatVerifyNotRunWarning,
	readDeferredCoverageObligations,
} from "../verification-stop-checks.js";
import { openReviewFindings } from "./review-reconcile-phase.js";
import { getGraphForFile, type ServerRuntime } from "./runtime-context.js";
import {
	checkTddRegression,
	checkUnresolvedRed,
	checkWipCommits,
} from "./lifecycle-stop-warnings-tdd-cycle-checks.js";

/** Verification-before-stop nudges — thirteen independent reflection
 *  warnings keyed off `verification_observed`, `observed_checks`,
 *  `stubs_introduced`, `tdd_cycles`, `commands_run`, `files_written`,
 *  and `git_session_baseline` session fields, plus the deferred
 *  coverage-obligation ledger read by
 *  `session_id`. All stderr-only; none block. See
 *  docs/external-pulse/failproofai.md §"smarter Stop hooks" for the design
 *  rationale and docs/design/stop-event-checks.md for the tier-2/3 backlog. */
export function buildVerificationStopWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	// Nullable: see buildCommitCadenceNudge above — same pinned contract.
	session: SessionTrajectory | undefined,
): string[] {
	const vsc = ctx.rules.verification_stop_checks;
	if (!vsc?.enabled || !session) return [];
	const verificationObserved = session.verification_observed ?? new Set<string>();
	const warnings: string[] = [];
	const unverifiedCode = vsc.warn_unverified_code
		? checkUnverifiedCode(ctx, session, verificationObserved)
		: null;
	pushIfNotNull(warnings, unverifiedCode);
	// Single-nudge invariant: verify-not-run ("ran individual tools but not the
	// full suite") and unverified-code ("cadence far below floor") are both
	// [interlinked:verify-before-stop] lines; when the stronger unverified-code
	// nudge already fired, emitting both double-nudges the same concern. Defer.
	pushIfNotNull(
		warnings,
		vsc.warn_verify_not_run && unverifiedCode === null
			? checkVerifyNotRun(ctx, session, verificationObserved)
			: null,
	);
	pushIfNotNull(
		warnings,
		vsc.warn_ui_not_interacted
			? checkUiNotInteracted(ctx, session, verificationObserved)
			: null,
	);
	pushIfNotNull(
		warnings,
		vsc.warn_stubs_introduced ? checkStubsIntroduced(ctx, session) : null,
	);
	pushIfNotNull(
		warnings,
		vsc.warn_fixture_leaks ? checkFixtureLeaks(ctx, event) : null,
	);
	pushIfNotNull(warnings, checkSlowTests(ctx, event, session));
	pushIfNotNull(warnings, checkTddRegression(ctx, session));
	// Always-on like the tdd-regression nudge: fires only when the session ran
	// inline-exec (node -e / python -c) AFTER a debt-focus block (debt-evasion.ts).
	pushIfNotNull(warnings, formatDebtEvasionStopLine(session));
	// P1 trajectory continuity: fires only when a refused action resurfaced
	// through another channel this session (block-fingerprint-session.ts).
	pushIfNotNull(warnings, formatWorkaroundStopLine(session));
	pushIfNotNull(
		warnings,
		vsc.warn_unresolved_red ? checkUnresolvedRed(ctx, session) : null,
	);
	pushIfNotNull(
		warnings,
		ctx.rules.per_edit_coverage?.enabled ? checkDeferredCoverage(ctx, session) : null,
	);
	pushIfNotNull(warnings, checkBisectNotReset(ctx, session));
	pushIfNotNull(warnings, checkWipCommits(ctx, event, session));
	pushIfNotNull(warnings, checkUntestedExports(ctx, event, session));
	pushIfNotNull(warnings, checkDeadOnArrival(ctx, event, session));
	pushIfNotNull(warnings, checkMutationKillEvidence(ctx, event, session));
	pushIfNotNull(warnings, checkDocMarkerDrift(ctx, session));
	pushIfNotNull(warnings, checkSpecDrift(ctx, session));
	pushIfNotNull(warnings, checkReviewFindings(ctx));
	// Repeat-suppression is applied by the OUTERMOST assembler
	// (`buildStopWarnings`), so it covers every nudge family — commit-cadence,
	// edit-mechanics, trajectory, sequence findings — not just this one.
	return warnings;
}

export function pushIfNotNull(warnings: string[], value: string | null): void {
	if (value !== null) warnings.push(value);
}

/** Shared shape for the two code-file-verification warnings: count
 *  changed code files, ask the supplied formatter whether that warrants
 *  a warning, log under the given tag. Two callers differ only in their
 *  formatter and log-tag — extracted so a bug fixed in one doesn't
 *  silently survive in the other. */
export function checkCodeFileVerification(opts: {
	ctx: ServerRuntime;
	session: SessionTrajectory;
	verificationObserved: Set<string>;
	formatter: (input: {
		codeFilesEdited: number;
		verifyCommandCount: number;
		verificationObserved: Set<string>;
	}) => string | null;
	logTag: string;
}): string | null {
	const { ctx, session, verificationObserved, formatter, logTag } = opts;
	const codeFilesEdited = countCodeFilesEdited(session.files_written);
	// Raw count of correctness-grade verify commands (tsc/test/lint/build/suite)
	// — the numerator of the cadence ratio the unverified-code nudge gates on.
	// `formatVerifyNotRunWarning` ignores it; only the ratio nudge reads it.
	const verifyCommandCount = countVerifyCommands(session.commands_run);
	const warning = formatter({ codeFilesEdited, verifyCommandCount, verificationObserved });
	if (warning === null) return null;
	ctx.log(
		`Verify-before-stop: ${logTag} (${codeFilesEdited} files, signals=${[...verificationObserved].join(",") || "none"})`,
	);
	return warning;
}

/** "Agent edited code without running tsc / lint / tests in this session." */
export function checkUnverifiedCode(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	verificationObserved: Set<string>,
): string | null {
	return checkCodeFileVerification({
		ctx,
		session,
		verificationObserved,
		formatter: formatUnverifiedCodeWarning,
		logTag: "unverified-code",
	});
}

/** "Agent edited code without running `interlinked verify`." */
export function checkVerifyNotRun(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	verificationObserved: Set<string>,
): string | null {
	return checkCodeFileVerification({
		ctx,
		session,
		verificationObserved,
		formatter: formatVerifyNotRunWarning,
		logTag: "verify-suite-not-run",
	});
}

/** "Agent edited UI files without browser-MCP / dev-server interaction." */
export function checkUiNotInteracted(
	ctx: ServerRuntime,
	session: SessionTrajectory,
	verificationObserved: Set<string>,
): string | null {
	const uiFilesEdited = countUiFilesEdited(session.files_written);
	const warning = formatUiNotInteractedWarning({ uiFilesEdited, verificationObserved });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: ui-not-interacted (${uiFilesEdited} files)`);
	return warning;
}

/** Agent left incomplete-work markers in source — unresolved task tokens,
 *  disabled tests, or throw-not-implemented stubs. */
export function checkStubsIntroduced(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const stubs = session.stubs_introduced ?? [];
	const warning = formatStubsIntroducedWarning({ stubs });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: stubs-introduced (${stubs.length})`);
	return warning;
}

// checkFixtureLeaks relocated to fixture-leak.ts (line-cap pressure) — same
// name/signature, co-located with its own detect/format pair.

/** Deferred-coverage reflection nudge — the session deferred one or more
 *  per-edit coverage checks (the budget-gate path in coverage-write-guard.ts)
 *  that were NEVER enforced; only the commit gate enforces them. Sibling of
 *  `checkUnresolvedRed`: RED is "you saw it fail", deferred is "you never ran
 *  it". The ledger is append-only with no resolution marker, so every row
 *  recorded for THIS session counts as unmet (the formatter says so). Reads the
 *  ledger by `session_id` so another session's obligations never leak in.
 *  Gated by the caller on `per_edit_coverage.enabled` (the producer flag — no
 *  obligations exist unless per-edit coverage is on). Reflection only; never
 *  blocks. */
export function checkDeferredCoverage(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const obligations = readDeferredCoverageObligations(ctx.cwd, session.session_id);
	const warning = formatDeferredCoverageWarning({ obligations });
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: deferred-coverage (${obligations.length} unmet)`);
	return warning;
}

/** Untested-exports reflection nudge (Stop backlog 3D) — a source file
 *  written this session whose exported symbols no test file references,
 *  cross-referenced through the daemon's cached project graph. The graph
 *  provider is LAZY: the detector only asks for it when the session wrote at
 *  least one eligible code file, so read-only Stops never pay graph-build
 *  cost. Every "can't tell" path (file not indexed, unreadable test
 *  dependent, graph init failure) fails open to silence — and the warning
 *  itself names the TDD carve-out. Reflection only; never blocks. */
export function checkUntestedExports(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string | null {
	const cwd = event.cwd || ctx.cwd;
	const hits = detectUntestedExports({
		filesWritten: session.files_written,
		cwd,
		getGraph: () => getGraphForFile(ctx, cwd),
		readFile: (path) => {
			try {
				return readFileSync(path, "utf-8");
			} catch {
				return null; // unreadable dependent → detector fails open
			}
		},
	});
	const warning = formatUntestedExportsWarning(hits, cwd);
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: untested-exports (${hits.length} files)`);
	return warning;
}

/** Unfinished git bisect — a bisect start/op with no reset after it leaves
 *  the repo in detached-HEAD bisect state. */
export function checkBisectNotReset(
	ctx: ServerRuntime,
	session: SessionTrajectory,
): string | null {
	const warning = formatBisectNotResetWarning({ commandsRun: session.commands_run });
	if (warning === null) return null;
	ctx.log("Verify-before-stop: bisect-not-reset");
	return warning;
}

// checkDeadOnArrival relocated to dead-on-arrival.ts (line-cap pressure) —
// same name/signature, co-located with its own detect/format pair.

/** Outstanding cross-file spec drift stashed by the spec-ledger phase
 *  (docs/design/spec-audit-runtime-checks.md §3.5). */
export function checkSpecDrift(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const vsc = ctx.rules.verification_stop_checks;
	if (!vsc?.enabled || vsc.warn_spec_drift === false) return null;
	return formatSpecDriftWarning(session.spec_drift_outstanding);
}

/** Ingested review findings never touched or acked (memo §4). The corpus
 *  read is Stop-latency-grade (tree scans are allowed at Stop). */
export function checkReviewFindings(ctx: ServerRuntime): string | null {
	const vsc = ctx.rules.verification_stop_checks;
	if (!vsc?.enabled || vsc.warn_review_findings === false) return null;
	const open = openReviewFindings(ctx.cwd).map((f) => ({
		id: f.id,
		file: f.file,
		line: f.line,
		message: f.message,
	}));
	return formatReviewFindingsWarning(open);
}

export function checkDocMarkerDrift(ctx: ServerRuntime, session: SessionTrajectory): string | null {
	const docSourcesEdited = countDocFactSourcesEdited(session.files_written);
	const warning = formatDocMarkerDriftWarning({
		docSourcesEdited,
		commandsRun: session.commands_run,
	});
	if (warning === null) return null;
	ctx.log(`Verify-before-stop: doc-marker-drift (${docSourcesEdited} source files)`);
	return warning;
}
