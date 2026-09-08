import { readToolString } from "../evaluator/tool-input-values.js";
// ===========================================
// PreToolUse evaluation pipeline
// ===========================================
// The `if (isPreToolUse(event))` block extracted verbatim from
// `processEvent` in server.ts. Runs the guard evaluator, then layers on the
// policy classifier, content-scanner WebFetch proxy + scan-request handling,
// auto-coordination, learned rules, the TDD / project-wide commit gates,
// grep + tsgo acceleration, and the diff-aware pre-edit baseline capture.
//
// Behavior-preserving move: bare module-level state (`rules`, `trigramIndex`,
// …) becomes `ctx.rules`, `ctx.trigramIndex`, …; `getGraphForFile(x)` /
// `getAutoCoordState(x)` take `ctx` as the first argument.
//
// `runPreToolPipeline` is a thin orchestrator: each cohesive phase lives in an
// INTERNAL helper below (no public-surface change). Phases that can replace the
// decision return `HarnessDecision | null` (null = continue); phases that only
// annotate the running decision mutate `preDecision` in place and return void.
// Side-effect ordering is preserved exactly — see the orchestrator at the foot
// of the file.

import { readSharedConfig } from "../../lib/config.js";
import { isCoverageSuiteCommand, noteCoverageSuiteRunStart } from "../coverage-discharge.js";
import { runCommitBaselineGate } from "../evaluator/commit-baseline-gate.js";
import { runCommitFunctionTokenGate } from "../evaluator/commit-function-token-gate.js";
import { runCommitLaunderingGate } from "../evaluator/commit-laundering-gate.js";
import { evaluatePreToolUse, extractPermissionPattern } from "../evaluator.js";
import {
	baselineCallKey,
	rememberBaselineSnapshot,
} from "../evaluator/baseline-effect-guard.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	rememberWorkspaceSnapshot,
	shouldObserveWorkspaceEffects,
} from "../workspace-effects.js";
import {
	runCommitGate,
	runCoverageWriteGate as runCoverageWriteGateExtracted,
	runMutationWriteGate,
} from "./pre-tool-coverage-gates.js";
import {
	runContentScanRequest,
	runWebFetchProxy,
} from "./pre-tool-pipeline-content-scan.js";
import {
	classifySearchTool,
	emitIndexStatusWarning,
	runGrepAcceleration,
	runTsgoAcceleration,
} from "./pre-tool-pipeline-search.js";
import {
	captureDiffAwareBaseline,
	injectStructureContext,
	runProjectWideGitGateAsync,
	runTddCommitGate,
} from "./pre-tool-pipeline-stages.js";
import {
	getGraphForFile,
	type ServerRuntime,
} from "./runtime-context.js";
import {
	reportGuardBlock,
	runAutoCoordination,
	runClassifierEscalation,
} from "./pre-tool-pipeline-integrations.js";
import { appendShellSandboxAdvisory } from "./shell-sandbox-policy.js";

// ---------------------------------------------------------------------------
// Phase helpers (internal — not exported)
// ---------------------------------------------------------------------------

/**
 * Resolve the file path the tool acts on, supporting both `file_path` (Write /
 * Edit / Read) and `path` (alternate tools), falling back to "".
 */
function resolveEventFilePath(event: HarnessEvent): string {
	return readToolString(event.tool_input?.file_path) || readToolString(event.tool_input?.path);
}

/**
 * Deliver any async-deferred findings enqueued for this session as PreToolUse
 * context. Drain is exactly-once; a no-op until the first async check is wired.
 */
function drainDeferredFindings(ctx: ServerRuntime, event: HarnessEvent, preDecision: HarnessDecision): void {
	const deferredFindings = ctx.asyncFindings.drain(event.session_id);
	if (deferredFindings.length > 0) {
		preDecision.warnings = [
			...(preDecision.warnings ?? []),
			...deferredFindings.map((f) => f.message),
		];
	}
}

/**
 * Inject any pending findings from background async analysis as tagged
 * warnings on `preDecision`. No-op when there is no file path or no findings.
 */
function injectAsyncAnalysisFindings(
	ctx: ServerRuntime,
	filePath: string,
	preDecision: HarnessDecision,
): void {
	if (!filePath) return;
	const asyncFindings = ctx.asyncAnalysis.consume(filePath);
	if (asyncFindings.length > 0) {
		const warnings = preDecision.warnings || [];
		for (const f of asyncFindings) {
			warnings.push(`[interlinked:async] ${f.name}: ${f.message}`);
		}
		preDecision.warnings = warnings;
		ctx.log(`Injected ${asyncFindings.length} async finding(s) for ${filePath}`);
	}
}

/**
 * Cross-session learned rules: observe allowed patterns and warn when a
 * pattern crosses the recurrence threshold. Mutates `preDecision.warnings`.
 */
function observeLearnedRules(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): void {
	if (!(preDecision.decision === "allow" && event.tool_name)) return;
	const pat = extractPermissionPattern(event.tool_name, event.tool_input || {});
	if (pat && !ctx.learnedRules.has(pat)) {
		const learned = ctx.learnedRules.observe(pat, event.session_id);
		if (learned) {
			const warnings = preDecision.warnings || [];
			warnings.push(
				`[interlinked:learned] Pattern "${pat}" observed ${learned.observation_count} times across sessions — saved as learned rule.`,
			);
			preDecision.warnings = warnings;
			ctx.log(`Learned rule: ${pat}`);
		}
	}
}

/**
 * Combine the two per-edit metric gates into one verdict.
 *
 * Both gates run unconditionally; only their RESULTS are combined here. Coverage
 * stays the returned verdict when both fire (it is the stronger gate), but the
 * mutation warnings are carried onto it so a single edit reports every metric
 * regression at once — the endgame seam's "fix them in one pass" contract.
 */
function combineMetricGateDecisions(
	coverage: HarnessDecision | null,
	mutation: HarnessDecision | null,
): HarnessDecision | null {
	if (coverage && mutation) {
		coverage.warnings = [...(coverage.warnings ?? []), ...(mutation.warnings ?? [])];
		return coverage;
	}
	return coverage ?? mutation;
}

/** Remember pre-call water-lines before any gate can short-circuit. */
function rememberPreToolEffects(ctx: ServerRuntime, event: HarnessEvent): void {
	if (event.dry_run) return;
	rememberBaselineSnapshot(
		baselineCallKey({
			toolUseId: event.tool_use_id,
			sessionId: event.session_id,
			timestamp: event.timestamp,
		}),
		ctx.cwd,
	);
	if (shouldObserveWorkspaceEffects(event.tool_name)) {
		rememberWorkspaceSnapshot({
			toolUseId: event.tool_use_id,
			sessionId: event.session_id,
			root: ctx.cwd,
		});
	}
}

/** Record the start of a coverage-suite command for later discharge binding. */
function observeCoverageRunStart(event: HarnessEvent): void {
	const command =
		typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
	if (command && isCoverageSuiteCommand(command)) {
		noteCoverageSuiteRunStart(event.session_id, event.timestamp);
	}
}

/** Run both per-edit metric gates before combining their decisions. */
async function runMetricGates(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	const coverageDecision = await runCoverageWriteGateExtracted(ctx, event, preDecision);
	// Mutation must run even when coverage returns a decision: otherwise a
	// coverage finding silently disables mutation measurement for the edit.
	const mutationDecision = await runMutationWriteGate(ctx, event, preDecision);
	return combineMetricGateDecisions(coverageDecision, mutationDecision);
}

interface CommitGateInput {
	ctx: ServerRuntime;
	event: HarnessEvent;
	session: SessionTrajectory;
	preDecision: HarnessDecision;
	now: () => number;
}

/** Run cheap commit backstops before the full commit-time quality gate. */
async function runCommitQualityGates({
	ctx,
	event,
	session,
	preDecision,
	now,
}: CommitGateInput): Promise<HarnessDecision | null> {
	const baselineDecision = runCommitBaselineGate(event, preDecision);
	if (baselineDecision) return baselineDecision;
	const tokenDecision = runCommitFunctionTokenGate(event, preDecision);
	if (tokenDecision) return tokenDecision;
	const launderingDecision = runCommitLaunderingGate(event, session, { nowMs: now() });
	if (launderingDecision) return launderingDecision;
	return runCommitGate(ctx, event, preDecision);
}

export async function runPreToolPipeline(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	const { rules } = ctx;
	const CWD = ctx.cwd;
	// --- Effect arm: remember the water-lines BEFORE anything can return ---
	// Must run at the entry, not the exit: the pipeline has many early returns
	// (guard blocks, fast-path allows), and a snapshot taken at the tail is
	// skipped for exactly the commands most worth watching. Snapshotting a call
	// that later blocks is harmless — the entry is bounded and simply expires
	// unconsumed. Dry runs never snapshot (CLAUDE.md: a dry run must not move
	// the gate). Pairs with consumeBaselineSnapshot in the post-tool pipeline.
	rememberPreToolEffects(ctx, event);
	// Resolve graph for the file being edited (supports cross-repo edits)
	const filePath = resolveEventFilePath(event);
	const activeGraph = getGraphForFile(ctx, filePath || CWD);

	// `sharedConfig` carries Phase D.2 trajectory feature flags
	// (`harness.trajectory.tool_loop`, etc.). Without passing it through,
	// `isFeatureEnabled` falls back to the defaults map (every flag false)
	// and the trajectory detector silently no-ops even after the user
	// explicitly enables it in `.interlinked/config.json`. Reading per
	// event is cheap (small JSON, fs cache) and matches what the hook
	// script does for mode resolution.
	const preDecision = evaluatePreToolUse(
		event,
		rules,
		session,
		ctx.reservations,
		ctx.cohort,
		activeGraph,
		ctx.sessions,
		ctx.routeMap,
		ctx.errorHistory,
		readSharedConfig(CWD),
	);
	appendShellSandboxAdvisory(event, session, preDecision, CWD);

	// Async-deferred findings — deliver anything an off-critical-path
	// check enqueued for this session as PreToolUse context.
	drainDeferredFindings(ctx, event, preDecision);

	// --- Coverage-discharge run-window observation (finding 2026-06, round 6) ---
	// Note when a coverage-suite shell command STARTS so the PostToolUse
	// discharge pass can bind report freshness to THIS run's window instead of
	// only the obligation's age (a failed earlier run's report is not this
	// run's evidence). Pure observation over total string ops — never affects
	// the decision.
	observeCoverageRunStart(event);

	// --- Per-edit coverage gate (config-gated; shipped default is ON since 2026-06) ---
	// The expensive apply-before-disk overlay+suite check. Placed after the
	// synchronous cheap checks; short-circuits the rest of the async pipeline on
	// a coverage block. A no-op (returns null immediately) when the repo opts
	// out via guard-rules.local.json (`per_edit_coverage.enabled: false`).
	const metricDecision = await runMetricGates(ctx, event, preDecision);
	if (metricDecision) return metricDecision;

	// --- Commit-time quality gate (config-gated; shipped default is ON since 2026-06) ---
	// The hard gate for repos whose suite is too big for per-edit enforcement:
	// on a real `git commit` Bash call it runs the FULL suite + coverage on the
	// working tree and blocks a red bar / uncovered changed line / CRAP-over /
	// cyclomatic-over. A pure no-op (returns null immediately) for non-commit
	// commands and when the repo opts out via `per_edit_coverage.enabled: false`.
	// Commit-time baseline-integrity backstop (ALWAYS ON) — block a commit that
	// stages a loosened git-tracked ratchet baseline. Cheap; runs before the
	// config-gated coverage commit gate.
	const commitDecision = await runCommitQualityGates({
		ctx,
		event,
		session,
		preDecision,
		now: Date.now,
	});
	if (commitDecision) return commitDecision;

	// --- LLM Policy Classifier: escalation check (shadow mode) ---
	await runClassifierEscalation({
		ctx,
		event,
		session,
		preDecision,
		now: Date.now,
		timestamp: () => new Date().toISOString(),
	});

	// --- Content Scanner: WebFetch proxy (3-way human review) ---
	const webFetchDecision = await runWebFetchProxy(ctx, event, preDecision);
	if (webFetchDecision) return webFetchDecision;

	// --- Content Scanner: run ML PII detection on the scan request (if present) ---
	await runContentScanRequest(ctx, event, preDecision);

	// Clean up _escalation and _contentScan from the decision before returning to hook script
	// (internal fields, not part of the hook protocol)
	delete preDecision._escalation;
	delete preDecision._contentScan;

	// --- Auto-coordination: periodic read-only check-in with MCP server ---
	await runAutoCoordination({ ctx, event, session, preDecision, now: Date.now });

	// Inject any pending findings from background async analysis
	injectAsyncAnalysisFindings(ctx, filePath, preDecision);

	// Cross-session learned rules: observe allowed patterns
	observeLearnedRules(ctx, event, preDecision);

	// Report blocks/warns to server for team visibility
	reportGuardBlock({ ctx, event, session, preDecision });

	// --- TDD commit gate: check for unresolved test failures before git commit ---
	runTddCommitGate(ctx, event, session, preDecision);

	// --- Project-wide typecheck gate (commit + push) + push-only test tier ---
	await runProjectWideGitGateAsync(ctx, event, session, preDecision);

	// --- Grep acceleration: intercept search tools via trigram index ---
	// Substitution path (block-and-answer) is DISABLED by default. Reason:
	//   - Bypasses the content scanner — substituted output reaches the
	//     model via permissionDecisionReason, an envelope the OPF scanner
	//     and checks/pii.ts weren't designed to inspect.
	//   - Index can be stale: incrementalUpdate uses `git diff baseCommit
	//     ..HEAD`, refresh fires on SessionStart only, external file edits
	//     are invisible until next session.
	//   - Partially-formed hookSpecificOutput envelopes have hit Claude
	//     Code's "(root): Invalid input" validator failure (fail-closed
	//     on a safety boundary, contradicts feedback_safety_continuity).
	// The trigram index itself stays loaded, but with substitution off its
	// only live consumer is PostToolUse sibling expansion (sibling-expansion.ts);
	// it is also read for the freshness warning below. Impact analysis, the
	// project graph, and structural checks build their own dependency graphs
	// and do NOT use it.
	// Re-enable: set INTERLINKED_GREP_ACCELERATOR=1 OR set
	// guard-rules.json `grep_acceleration.substitution_enabled: true`.
	const searchFlags = classifySearchTool(event, rules);
	const grepDecision = runGrepAcceleration(ctx, event, preDecision, searchFlags);
	if (grepDecision) return grepDecision;

	// For applicable searches backed by a loaded index, add health status as a
	// warning. Missing/disabled indexes silently fall through to native search.
	emitIndexStatusWarning(ctx, event, preDecision, searchFlags);

	// --- tsgo acceleration: rewrite tsc → tsgo when available ---
	const tsgoDecision = runTsgoAcceleration(ctx, event, preDecision);
	if (tsgoDecision) return tsgoDecision;

	// --- Diff-aware: capture pre-edit baseline for file write tools ---
	captureDiffAwareBaseline(ctx, event, filePath);

	// --- Structure context injection (non-blocking) ---
	injectStructureContext(ctx, event, session, preDecision, filePath);

	return preDecision;
}
