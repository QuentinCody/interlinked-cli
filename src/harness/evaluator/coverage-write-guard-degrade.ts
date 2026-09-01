// interlinked-tdd: exempt
// ===========================================
// Per-edit coverage gate — fail-open warning / degrade / defer helpers
// ===========================================
// Extracted from coverage-write-guard.ts to keep that module under the per-file
// line cap. These are the leaf decision-builders the gate uses to ALLOW while
// staying loud (every uncovered-but-allowed write emits an agent-visible
// `[interlinked:coverage]` warning) plus the budget-defer obligation recorder.
//
// RUNNER-ABSENCE notices are once-per-daemon (2026-07): a repo with no
// detectable runner/provider for a gated language otherwise repeats the
// IDENTICAL warning on every edit — measured at 70.6% of one foreign repo's
// harness output. The first occurrence per (projectRoot, language,
// reason-class) stays loud and announces the silence that follows; repeats
// allow silently. TRANSIENT degrade reasons (loudDegrade, spawn failures)
// keep per-edit loudness — each unmeasured edit still warns.

import { resolve } from "node:path";
import {
	type CoverageObligation,
	recordCoverageObligation,
} from "../coverage-obligation-ledger.js";
import { type CoverageLanguage, coverageLanguageForPath } from "../coverage-runner.js";
import { getRepoProfile } from "../repo-profile.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";

/**
 * Build an ALLOW decision that carries a single agent-visible coverage warning,
 * and ALSO mirror that exact line to the daemon's stderr (belt and suspenders:
 * the daemon log keeps a record even where the runner doesn't surface allow-time
 * warnings). The `[interlinked:coverage]` prefix is what the agent sees — the
 * Claude Code adapter routes an allow-decision's `warnings` into
 * `hookSpecificOutput.additionalContext` at PreToolUse, so this text reaches the
 * model on the same turn. Fail-open: the decision is `allow`, never a block.
 */
function allowWithCoverageWarning(warning: string): HarnessDecision {
	process.stderr.write(`${warning}\n`);
	return { decision: "allow", warnings: [warning] };
}

/**
 * Loud-degrade: ALLOW (fail-open) but emit an AGENT-VISIBLE warning so a write
 * that wasn't coverage-checked never passes silently. Returns an allow-decision
 * carrying the `[interlinked:coverage]` warning (not bare null), which the
 * pipeline propagates to the agent. The daemon-stderr line is kept too.
 */
export function loudDegrade(relPath: string, why: string): HarnessDecision {
	return allowWithCoverageWarning(
		`[interlinked:coverage] WARNING: per-edit coverage gate degraded for ${relPath} ` +
			`(${why}) — allowing the edit (fail-open). This edit was NOT coverage-checked.`,
	);
}

// ---------------------------------------------------------------------------
// Once-per-daemon runner-absence memo
// ---------------------------------------------------------------------------

const emittedAbsenceNotices = new Set<string>();

/** Clear the once-per-daemon runner-absence memo (for tests). */
export function resetDegradeMemo(): void {
	emittedAbsenceNotices.clear();
}

/** Announced on the FIRST runner-absence warning so the silence that follows is explicit. */
const NO_REPEAT_TAIL = " (further edits will not repeat this notice this session)";

/**
 * The degrade reasons that mean "this repo lacks a runner/provider for the
 * language" — a stable repo property, not a transient failure: the factory's
 * "no coverage runner for <language>" and the runners' missing-provider report
 * shape ("no parseable coverage at …" — the `@vitest/coverage-v8` / `pytest-cov`
 * absent case). Everything else (spawn failures, timeouts, a file absent from
 * the report) stays per-edit loud.
 */
const RUNNER_ABSENCE_REASONS = [/^no coverage runner for /, /no parseable coverage at /];

function isRunnerAbsenceReason(why: string): boolean {
	return RUNNER_ABSENCE_REASONS.some((re) => re.test(why));
}

/** True exactly once per (projectRoot, language, reason-class); later calls
 *  report "already announced" so the caller can go silent. */
function firstOccurrence(projectRoot: string, language: string, reasonClass: string): boolean {
	const key = `${resolve(projectRoot)}|${language}|${reasonClass}`;
	if (emittedAbsenceNotices.has(key)) return false;
	emittedAbsenceNotices.add(key);
	return true;
}

/** Where a runner-unavailable warning is anchored. The guard's `GateContext`
 *  satisfies this structurally, so its call sites pass `ctx` directly. */
export interface RunnerUnavailableSite {
	projectRoot: string;
	relPath: string;
	language: CoverageLanguage;
}

function runnerUnavailableWarning(site: RunnerUnavailableSite, why: string): string {
	const provider = site.language === "python" ? "pytest-cov" : "@vitest/coverage-v8";
	return (
		`[interlinked:coverage] WARNING: coverage/red-green/CRAP gate is ON for ${site.language} ` +
		`but could not run for ${site.relPath} (${why}) — install the coverage provider ` +
		`(${provider} for js/ts, pytest-cov for python) to enforce; this edit was NOT ` +
		"coverage-checked."
	);
}

/**
 * The fail-LOUD path for "the gate is ON for this language but the runner could
 * not establish a result" — no runner, an `ok:false` run, or a `testsPassed`/report
 * the runner could not produce. The single most common real cause is a MISSING
 * COVERAGE PROVIDER (`@vitest/coverage-v8` / `pytest-cov`), so we name it. Allows
 * the edit (fail-open — "can't measure" is not "deny") but NEVER silently: it
 * returns an allow-decision carrying an AGENT-VISIBLE warning (not bare null) so
 * the operator is told to install the provider; the daemon-stderr line is kept too.
 *
 * When the cause is RUNNER ABSENCE (see {@link RUNNER_ABSENCE_REASONS} — a stable
 * repo property, not a transient failure) the warning is once-per-daemon: the
 * first occurrence per (projectRoot, language) carries the no-repeat tail, and
 * repeats return a bare allow with NO warning line. Transient causes warn on
 * every edit, unchanged.
 */
export function loudRunnerUnavailable(site: RunnerUnavailableSite, why: string): HarnessDecision {
	if (!isRunnerAbsenceReason(why)) {
		return allowWithCoverageWarning(runnerUnavailableWarning(site, why));
	}
	if (!firstOccurrence(site.projectRoot, site.language, "runner-absent")) {
		return { decision: "allow" };
	}
	return allowWithCoverageWarning(runnerUnavailableWarning(site, why) + NO_REPEAT_TAIL);
}

/** Repo-profile runner key for a coverage language (one Vitest process serves js+ts). */
function profileRunnerKey(language: CoverageLanguage): "js" | "python" {
	return language === "python" ? "python" : "js";
}

/**
 * EARLY repo-profile fast-path for `checkCoverageWrite`: when the edited file's
 * language is gated (`cfg.languages`) but the detected repo profile has NO
 * supported test runner for it, an overlay run could only ever end in the
 * per-edit "runner unavailable" warning — so skip the overlay entirely and say
 * so ONCE per daemon (same memo + reason-class as {@link loudRunnerUnavailable}).
 *
 * Returns:
 *   - `undefined` — no fast-path: ungated language / unresolvable path, or a
 *     DETECTED runner. A profile detection error yields the conservative
 *     runners-true profile (see repo-profile.ts), so it also lands here and the
 *     caller proceeds exactly as before (fail toward current behavior);
 *   - an allow decision carrying the loud notice — first occurrence;
 *   - `null` — silent allow (the notice already ran this daemon).
 */
export function profileRunnerFastPath(
	event: HarnessEvent,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
	projectRoot: string,
): HarnessDecision | null | undefined {
	const input = event.tool_input ?? {};
	const rawPath = (input.file_path as string) || (input.path as string) || "";
	const language = coverageLanguageForPath(rawPath);
	if (!language || !cfg.languages.includes(language)) return undefined;
	if (getRepoProfile(projectRoot).runners[profileRunnerKey(language)]) return undefined;
	if (!firstOccurrence(projectRoot, language, "runner-absent")) return null;
	const runner = language === "python" ? "pytest (+pytest-cov)" : "vitest or jest";
	return allowWithCoverageWarning(
		`[interlinked:coverage] WARNING: per-edit coverage gate is ON for ${language} but no ` +
			`supported test runner (${runner}) was detected in this repo — skipping the gate for ` +
			`${rawPath}; this edit was NOT coverage-checked.${NO_REPEAT_TAIL}`,
	);
}

/** Record a deferred coverage obligation and allow (budget exceeded). */
export function deferForBudget(
	projectRoot: string,
	relPath: string,
	event: HarnessEvent,
	estimateMs: number,
	budgetMs: number,
): null {
	const obligation: CoverageObligation = {
		kind: "coverage",
		file: relPath,
		reason: "budget_exceeded",
		estimated_suite_ms: estimateMs,
		budget_ms: budgetMs,
		session_id: event.session_id,
		timestamp: new Date(Date.now()).toISOString(),
	};
	recordCoverageObligation(projectRoot, obligation);
	return null;
}
