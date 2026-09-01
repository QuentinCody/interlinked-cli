// ===========================================
// PostToolUse evaluation pipeline
// ===========================================
// The `if (isPostToolUse(event))` block extracted verbatim from
// `processEvent` in server.ts. Runs after a tool call completes: the guard
// post-evaluator, failure-recovery channels, content-scanner post-scan,
// tool-response checks, then the per-file structural / quality / suggestion /
// structure / behavioral pipeline (fanned out via `runPerFileChecks` in
// `post-tool-file-checks.ts`), and finally the per-tool latency breakdown +
// required-tool coverage + all-clean summary.
//
// Behavior-preserving move: bare module-level state (`rules`, `trigramIndex`,
// …) becomes `ctx.rules`, `ctx.trigramIndex`, ….

import { runPostToolScan } from "../content-scanner/post-scan.js";
import { evaluatePostToolUse } from "../evaluator.js";
import { runFailureChannels } from "../failure-channels.js";
import type { ToolBreakdownEntry } from "../quality-checks.js";
import { shouldSkipPath } from "../skip-paths.js";
import {
	checkContextBloat,
	checkSilentFailure,
	consecutiveFailureWarning,
	formatBloatWarning,
	formatSilentFailureWarning,
} from "../tool-result-checks.js";
import type {
	CheckResultEntry,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { isWorkspaceControlPath } from "../workspace-effects.js";
import { type PerFileCheckCtx, runPerFileChecks } from "./post-tool-file-checks.js";
import { appendFlakeCheckWarning } from "./post-tool-flake-phase.js";
import { appendMutationHarvestWarning } from "./post-tool-mutation-harvest.js";
import { appendBashEditObligationWarnings } from "../bash-edit-obligations.js";
import { resolveEditedPaths } from "./post-tool-pipeline-paths.js";
import {
	dischargeCoverageOnGreenRun,
	pushWarnings,
	trackTestRun,
	trackVerificationOutcome,
	updateTrigramDirtyLayer,
} from "./post-tool-pipeline-tracking.js";
import type { ServerRuntime } from "./runtime-context.js";
import { prerefreshSpecLedger } from "./spec-ledger-phase.js";
import { withPostToolWarningSpool } from "./post-tool-pipeline-spool.js";
import {
	appendBaselineEffect,
	appendRequiredToolWarnings,
	attachObservedChangeSet,
	attachTailResults,
	emitAllCleanSummary,
} from "./post-tool-pipeline-tail.js";

export { POST_TOOL_PIPELINE_FAILURE_WARNING } from "./post-tool-pipeline-spool.js";

function observedSkipDecision(
	event: HarnessEvent,
	rules: ServerRuntime["rules"],
): HarnessDecision | null {
	const paths = event.change_set?.files.map((effect) => effect.path) ?? [];
	if (
		paths.length === 0 ||
		paths.some(isWorkspaceControlPath) ||
		!paths.every((path) => shouldSkipPath(path, rules))
	) return null;
	return {
		decision: "allow",
		summary: `skip_paths matched all ${paths.length} observed filesystem effect(s) — post-event pipeline skipped`,
	};
}

/**
 * Daemon-side mirror of the hook's `skip-paths` chunk: when the edited path
 * matches a configured `skip_paths` glob, short-circuit the whole post-event
 * pipeline. Returns the early `allow` decision, or `null` to continue.
 */
function skipPathsShortCircuit(
	event: HarnessEvent,
	rules: ServerRuntime["rules"],
): HarnessDecision | null {
	if (event.change_set?.files.length) return observedSkipDecision(event, rules);
	// tool_input crosses a process boundary, so its field types are a claim rather
	// than a guarantee; `as string` would pass a non-string on to path handling
	// that assumes otherwise.
	const namedPath = event.tool_input?.file_path ?? event.tool_input?.path;
	const editedFilePathRaw = typeof namedPath === "string" ? namedPath : "";
	if (editedFilePathRaw && shouldSkipPath(editedFilePathRaw, rules)) {
		return {
			decision: "allow",
			summary: `skip_paths matched (${editedFilePathRaw}) — post-event pipeline skipped`,
		};
	}
	return null;
}

/**
 * Phase 1 Failure-Recovery Channels (1, 2, 3, 5, 6). Gated on the canonical
 * `tool_outcome === "error"`. Fails open: a channel-orchestrator crash must
 * not abort the PostToolUse response — it just goes silent for this event.
 */
function appendFailureChannelWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
): void {
	if (event.tool_outcome !== "error") return;
	try {
		const channelsOutput = runFailureChannels({ event, session, cwd: ctx.cwd });
		if (channelsOutput) pushWarnings(postDecision, ...channelsOutput.warnings);
	} catch (e) {
		ctx.log(`Failure-recovery channels error: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Content Scanner: scan Read/Grep results and ratchet `session.sensitivity_level`
 * on PII. Never blocks (we're already past the read) but raises sensitivity so
 * downstream PreToolUse taint rules fire. No-op when the scanner is disabled.
 */
async function appendContentScanWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
): Promise<void> {
	if (!ctx.contentScanner || !ctx.rules.content_scanner?.enabled) return;
	const postScanResult = await runPostToolScan({
		event,
		session,
		rules: ctx.rules,
		scanner: ctx.contentScanner,
		compiledAllowlist: ctx.compiledAllowlist,
	});
	if (postScanResult.warnings.length > 0) {
		pushWarnings(postDecision, ...postScanResult.warnings);
	}
}

/**
 * Tool-response checks (run for ALL PostToolUse events, not just file edits):
 * silent-failure lint, context-bloat warning, and consecutive-error feedback.
 * Each is recorded once per tool on the session. Appends to `checksRan`.
 */
function appendToolResponseChecks(
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
	checksRan: string[],
): void {
	// `session` is typed as required `SessionTrajectory`, but the
	// "falsy-session guard" test proves a caller can genuinely pass a null
	// session. Read it through `unknown` so the guard stays real instead
	// of being lint-dead.
	const sessionPresent: unknown = session;
	if (!sessionPresent || !event.tool_name) return;
	const toolName = event.tool_name;

	// Silent-failure lint: tool returned 200/success but body signals error.
	if (!session.silent_failure_warned.has(toolName)) {
		const silentHit = checkSilentFailure(event.tool_response);
		if (silentHit) {
			pushWarnings(postDecision, formatSilentFailureWarning(toolName, silentHit));
			session.silent_failure_warned.add(toolName);
			checksRan.push("silent-failure");
		}
	}

	// Context-bloat warning: tool_response exceeds ~8K-token budget.
	if (!session.bloat_warned.has(toolName)) {
		const bloatHit = checkContextBloat(event.tool_response);
		if (bloatHit) {
			pushWarnings(postDecision, formatBloatWarning(toolName, bloatHit));
			session.bloat_warned.add(toolName);
			checksRan.push("context-bloat");
		}
	}

	// Consecutive-error feedback: 3+ same-tool failures in a row. Counter is
	// maintained in session-state.ts (increment on failure, reset on success).
	const failureCount = session.consecutive_tool_failures.get(toolName) || 0;
	const consecutiveMsg = consecutiveFailureWarning(failureCount, toolName);
	if (consecutiveMsg) {
		pushWarnings(postDecision, consecutiveMsg);
		checksRan.push("consecutive-errors");
	}
}

/**
 * Run the per-file quality / structural / TDD / suggestion pipeline for every
 * edited file. Codex `apply_patch` can carry multiple file sections, so the
 * fan-out iterates; a single-file event collapses to one iteration. The outer
 * PostTool pipeline owns late-warning persistence so tail findings are covered
 * along with these per-file phases.
 */
async function runFileChecks(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	postDecision: HarnessDecision,
	editedFilePath: string,
	editedFilePaths: string[],
	acc: PerFileCheckCtx,
): Promise<void> {
	// Per-file fan-out: for non-multi events `editedFilePaths` collapses to a
	// single-element list; the empty-string fallback keeps a check pass running
	// even when no concrete path was resolved (direct-edit with no paths).
	const pathsToCheck =
		editedFilePaths.length > 0
			? editedFilePaths
			: editedFilePath.length > 0
				? [editedFilePath]
				: [""];
	acc.editedFilePaths = pathsToCheck;
	// Phase mark — everything before this point was tool-response checks
	// (silent-failure, context-bloat) plus paths-to-check setup.
	acc.markPhase("tool_response_checks");
	// Refresh the spec ledger for ALL edited markdown paths before per-file
	// drift is computed — a multi-file patch must be evaluated against its
	// final state, not a half-applied one (deep-round #3).
	prerefreshSpecLedger(ctx, pathsToCheck);
	for (const currentEditedPath of pathsToCheck) {
		await runPerFileChecks(ctx, event, session, currentEditedPath, postDecision, acc);
	}
	// Phase mark — covers behavioral-checks + the recurrence log appender.
	acc.markPhase("recurrence_aggregate");
}

async function runPostToolPipelineInner(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	const { rules } = ctx;
	const CWD = ctx.cwd;
	attachObservedChangeSet(event, CWD);
	// --- Phase B.2: skip_paths short-circuit ---
	// The hook reads `.interlinked/config.json#skip_paths` and exits early on
	// excluded paths, but on installs that rely on DEFAULT_CONFIG (no shared
	// file written) the hook's list is empty and the event still reaches the
	// daemon. Consult the merged `rules.skip_paths` here so the configured
	// globs short-circuit regardless of install path.
	const skip = skipPathsShortCircuit(event, rules);
	if (skip) return skip;

	// --- Dirty layer: track file edits for trigram index freshness ---
	updateTrigramDirtyLayer(ctx, event);

	// --- Test run tracking: detect test runner commands and record pass/fail ---
	// Returns a warning when the run produced no usable evidence (B3) — an
	// uncounted run is invisible to the TDD gate, and staying silent about it
	// is what let repeated green runs fail to clear a wedged cycle.
	const testEvidenceWarning = trackTestRun(event, session, CWD);

	// --- Observed-check outcome tracking: tsc/build/lint red/green for the
	// Stop unresolved-red nudge (non-test analogue of trackTestRun). ---
	trackVerificationOutcome(event, session);

	// --- Deferred-coverage discharge: a coverage-suite run observed GREEN
	// discharges the session's open obligations its fresh report measured —
	// the relief path the Stop nudge promises (finding 2026-06: only the
	// commit gate ever recorded discharges, so following the nudge's "run the
	// suite + coverage" instruction changed nothing). ---
	dischargeCoverageOnGreenRun(event, CWD);

	const postDecision = evaluatePostToolUse(event, rules, session, ctx.reservations, ctx.cohort);

	if (testEvidenceWarning) pushWarnings(postDecision, testEvidenceWarning);

	// --- Phase 1 Failure-Recovery Channels (Channels 1, 2, 3, 5, 6) ---
	// Both delivery shapes converge in the helper — folded failures
	// (Claude/Codex/Gemini/Copilot deliver tool failures on the regular
	// PostToolUse / AfterTool / postToolUse) and the dedicated
	// PostToolUseFailure (Cursor's postToolUseFailure event) — because the
	// per-provider normalizers populate `tool_outcome` consistently. Output
	// flows into postDecision.warnings, surfaced by the .mjs per existing wiring.
	appendFailureChannelWarnings(ctx, event, session, postDecision);

	// --- Content Scanner: scan Read/Grep results, ratchet session sensitivity on PII ---
	await appendContentScanWarnings(ctx, event, session, postDecision);

	// --- Flake double-run (DW P0.2): opt-in. On a test-file edit, re-run the
	// affected scoped suite twice and warn on divergence. Fast no-op when off. ---
	await appendFlakeCheckWarning(ctx, event, postDecision);
	// Second mutation window: claim any run the PreToolUse budget abandoned.
	await appendMutationHarvestWarning(ctx, event, postDecision);

	const postStartMs = Date.now();
	const checksRan: string[] = [];
	const allCheckResults: CheckResultEntry[] = [];
	// Phase A.7: per-subprocess-tool breakdown — quality-checks pushes one
	// entry per `engine.runChecksAsync` invocation (one per tool). The
	// daemon forwards this into latency.jsonl so the latency CLI can show
	// per-tool p50/p99.
	const postToolMetrics: ToolBreakdownEntry[] = [];

	// Per-phase wall-clock breakdown. Lets us see which phase of the
	// PostToolUse handler is responsible for the residual ms not
	// attributed to a subprocess tool. `markPhase(name)` records the
	// delta from the previous mark; the closing `closePhase()` captures
	// anything between the last mark and end-of-handler.
	const phaseBreakdown: Record<string, number> = {};
	let phaseCursor = postStartMs;
	const markPhase = (name: string): void => {
		const now = Date.now();
		phaseBreakdown[name] = (phaseBreakdown[name] ?? 0) + (now - phaseCursor);
		phaseCursor = now;
	};

	// --- Tool-response checks (run for ALL PostToolUse events, not just file edits) ---
	// These inspect tool_response payloads, so they apply equally to MCP tools,
	// Bash JSON output, and any other tool that returns structured data.
	markPhase("pre_tool_response");
	appendToolResponseChecks(event, session, postDecision, checksRan);

	// Run quality checks (synchronous, with timeouts per check). Resolve which
	// file(s) this event edited (direct edit declared paths, or a path scanned
	// out of a Bash command) and whether any checks should run at all.
	const { editedFilePath, editedFilePaths, isDirectFileEdit, shouldRunChecks } = resolveEditedPaths(event);
	// Ring-2 equalizer (gap 6): bash-channel edits judged post-state → obligations.
	appendBashEditObligationWarnings(event, ctx.cwd, isDirectFileEdit, editedFilePaths, postDecision);
	if (shouldRunChecks) {
		// The accumulator carries every cross-iteration / cross-phase value:
		// the once-per-event project-wide-sweep guard, the recurrence cursor,
		// the structured-result and checks-ran lists, the tool-latency
		// breakdown, and the `markPhase` recorder. `runPerFileChecks` mutates
		// it (and `postDecision`) in place per file.
		const acc: PerFileCheckCtx = {
			postStartMs,
			allCheckResults,
			checksRan,
			postToolMetrics,
			markPhase,
			projectWideSweepFired: false,
			recurrenceCursor: 0,
		};
		await runFileChecks(
			ctx,
			event,
			session,
			postDecision,
			editedFilePath,
			editedFilePaths,
			acc,
		);
	}

	// Phase mark — covers the final warnings-marker write +
	// any tail bookkeeping outside the inner block.
	markPhase("session_persist");

	// Attach structured check results and timing to the decision.
	const elapsedMs = Date.now() - postStartMs;
	attachTailResults({
		postDecision,
		allCheckResults,
		checksRan,
		postToolMetrics,
		phaseBreakdown,
		elapsedMs,
	});

	// Required-tool coverage: warn once per session if required tools are missing.
	appendRequiredToolWarnings(ctx, session, postDecision);

	// Emit a positive summary line when all checks pass (the detailed warnings
	// carry the signal otherwise).
	emitAllCleanSummary({ postDecision, rules, checksRan, elapsedMs });
	// Effect-based baseline integrity: compare the water-lines against the
	// pre-call snapshot. Warn-only — the loosening is already reversible (undo
	// record) and inert (trusted value), so blocking adds nothing here.
	appendBaselineEffect(event, postDecision, CWD);

	return postDecision;
}

/**
 * Run one PostTool request inside its own late-warning spool lifecycle. The
 * ready record is published only after every warning-producing tail phase has
 * completed; cleanup is request-owned and runs even when a phase throws.
 */
export async function runPostToolPipeline(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	return withPostToolWarningSpool(ctx, event, () =>
		runPostToolPipelineInner(ctx, event, session),
	);
}
