// ===========================================
// Per-edit coverage gate — overlay-run sub-decisions
// ===========================================
// Extracted VERBATIM from `runOverlayAndDecide` in coverage-write-guard.ts to
// keep that function under the cyclomatic cap (finding: 6 fns, max CC 17 on
// runOverlayAndDecide) and to keep the parent module under the per-file line
// cap. No behavior changed — same text, same control flow, same order of
// side effects (budget-estimate update still happens before the `!result.ok`
// branch in the caller).

import { join } from "node:path";
import { appendCrapTelemetry, type CrapTelemetryEntry } from "../crap-telemetry.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CoverageRunOpts, CoverageRunResult } from "../coverage-runner.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
	type CrapInput,
	type CrapViolation,
	DEFAULT_CRAP_THRESHOLD,
	decideCrap,
} from "./coverage-crap-decision.js";
import { formatScopeReanchorWarning } from "./coverage-scope.js";
import { blockForRedBar, type CoverageDecisionOut } from "./coverage-write-decision.js";
import {
	deferForBudget,
	loudDegrade,
	loudRunnerUnavailable,
} from "./coverage-write-guard-degrade.js";
import type { CoverageWriteDeps, GateContext } from "./coverage-write-guard.js";

/**
 * Build the overlay run options. Split out purely to keep the caller's
 * conditional-property assignment (only set `selectedTests` when non-empty)
 * off the orchestrator's branch count.
 */
export function buildOverlayRunOpts(ctx: GateContext, overlayRoot: string): CoverageRunOpts {
	const runOpts: CoverageRunOpts = {
		projectRoot: overlayRoot,
		coverageDir: `${overlayRoot}/.interlinked/coverage`,
		timeoutMs: ctx.budgetMs, // per-edit BUDGET, not the 120s suite default → an over-budget run defers (below), never hangs the daemon 2min
	};
	if (ctx.selectedTests && ctx.selectedTests.length > 0) {
		runOpts.selectedTests = ctx.selectedTests;
	}
	return runOpts;
}

/**
 * `ok:false` means the runner produced no parseable coverage — the most
 * common real cause is a missing provider. Fail LOUD, not silent.
 */
export function handleFailedOverlayRun(
	ctx: GateContext,
	event: HarnessEvent,
	result: CoverageRunResult,
): HarnessDecision | null {
	// Over-budget (suiteMs >= budgetMs): the run was killed at the per-edit
	// timeout (timeoutMs === budgetMs) before finishing - the wide-fan-in
	// SCOPED case (a correct but too-slow affected-test set). Failing open here
	// would let an edit that breaks a slow affected test through (caught only at
	// pre-push); record a commit-time obligation instead, exactly like the full
	// route's up-front budget defer, so the commit gate runs the affected tests
	// before the change can be pushed. A FAST failure (suiteMs < budgetMs) is a
	// real launch/parse failure (missing provider, ENOENT) - nothing to defer.
	if (result.suiteMs >= ctx.budgetMs) {
		return deferForBudget(ctx.projectRoot, ctx.relPath, event, result.suiteMs, ctx.budgetMs);
	}
	return loudRunnerUnavailable(ctx, result.error ?? "coverage run failed");
}

/**
 * Red bar before coverage: a FAILING suite is a harder failure than a
 * coverage gap. Only when opted in (block_on_test_failure) AND the suite
 * definitively came back red (testsPassed === false). `null` (couldn't
 * determine) falls through to the coverage decision — fail-open on the
 * pass/fail axis, exactly like the coverage block's runner-unavailable path.
 */
export function checkRedBar(ctx: GateContext, result: CoverageRunResult): HarnessDecision | null {
	if (!ctx.blockOnTestFailure || result.testsPassed !== false) return null;
	return blockForRedBar(ctx.relPath, result.failingTests, result.failingTestFiles);
}

/** `!cov` (edited file absent from the overlay's coverage report) is a loud
 *  degrade, not a block — the file was written but the suite's report never
 *  named it (unsupported extension, exclude pattern, parse gap). */
export function missingCoverageDegrade(relPath: string): HarnessDecision {
	return loudDegrade(relPath, "edited file absent from coverage report");
}

/**
 * Coverage allowed → the 4th per-edit gate. Only when opted in (block_on_crap);
 * uses the SAME overlay coverage just computed. It runs BEFORE the baseline is
 * persisted, so a CRAP block never poisons it with rejected content (finding 8).
 */
/**
 * Telemetry `onShown` hook for {@link decideCrap} — fires exactly once, only
 * for the single worst violation that actually drives a returned block (this
 * is the ONE site in the codebase where a CRAP finding is both COMPUTED and
 * SHOWN to the agent as a PreToolUse block reason; the `snapshotCrap` call in
 * `pre-tool-pipeline-stages.ts` is a different, earlier thing — an unconditional
 * PRE-edit baseline snapshot used for diff-aware comparison, not a shown
 * finding, and it runs on every write whether or not `block_on_crap` is even
 * on). Honors `event.dry_run` per the repo-wide contract that a simulated
 * `interlinked harness test` event must never persist state — a dry run
 * exercises this exact code path with a synthetic threshold and would
 * otherwise pollute the calibration stream with fictional findings.
 */
interface RecordCrapShownParams {
	ctx: GateContext;
	event: HarnessEvent;
	threshold: number;
	/** Injected wall clock — same `deps.clock` the estimate update above uses,
	 *  so telemetry timestamps stay deterministic under the same test seam. */
	clock: () => number;
}

function recordCrapShown(
	params: RecordCrapShownParams,
	relPath: string,
	worst: CrapViolation,
): void {
	const { ctx, event, threshold, clock } = params;
	if (event.dry_run) return;
	const entry: CrapTelemetryEntry = {
		ts: new Date(clock()).toISOString(),
		session_id: event.session_id,
		...(event.agent_name ? { agent_name: event.agent_name } : {}),
		phase: "pre_tool_use",
		file: relPath,
		function: worst.function,
		line: worst.line,
		complexity: worst.cyclomatic,
		coverage_pct: worst.coverage_pct,
		crap_score: worst.crap_score,
		stale: false,
		shown: true,
		threshold,
	};
	appendCrapTelemetry(join(ctx.projectRoot, ".interlinked"), [entry]);
}

export function evaluateCrapGate(
	ctx: GateContext,
	deps: CoverageWriteDeps,
	cov: PerFileCoverage,
	event: HarnessEvent,
): HarnessDecision | null {
	if (!ctx.blockOnCrap) return null;
	const threshold = ctx.crapThreshold ?? DEFAULT_CRAP_THRESHOLD;
	const crapInput: CrapInput = {
		relPath: ctx.relPath,
		proposed: ctx.proposed,
		cov,
		editedLines: ctx.editedLines,
		threshold,
		analyzer: deps.cyclomaticFor(ctx.language),
	};
	return decideCrap(crapInput, loudDegrade, (relPath, worst) =>
		recordCrapShown({ ctx, event, threshold, clock: deps.clock }, relPath, worst),
	);
}

/**
 * EVERY per-target gate passed → STAGE the new baseline (never persist
 * in-loop: a later target or residual-language run can still block the whole
 * atomic patch — finding 2026-06; see GateContext.recordBaseline), then
 * build the final allow result. A cross-scope re-anchor is a loud ALLOW: the
 * recorded high-water was measured under a different affected-test set, so
 * the gate reseeded at today's measurement rather than blocking. Surface it
 * — the commit-time full-suite gate still holds the real line.
 */
export function finalizeAllow(
	ctx: GateContext,
	covOut: CoverageDecisionOut,
	scopeId: string,
): HarnessDecision | null {
	if (covOut.now !== undefined) {
		ctx.recordBaseline?.(ctx.relPath, covOut.now, scopeId);
	}
	if (covOut.scopeChanged) {
		return {
			decision: "allow",
			warnings: [
				formatScopeReanchorWarning(ctx.relPath, covOut.scopeChanged.priorFraction, covOut.now ?? 0, scopeId),
			],
		};
	}
	return null;
}
