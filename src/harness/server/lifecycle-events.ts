// ===========================================
// Lifecycle event handling
// ===========================================
// The `switch (event.hook_event)` dispatcher extracted from `processEvent`
// in server.ts. Handles every non-tool hook event — SessionStart,
// SessionEnd, Stop, UserPromptSubmit, Subagent*, Skill*.
//
// 2026-05/06 refactors: the original ~400-line switch body became per-event
// handlers + `handleStop` helpers, and the stop verification helpers moved to
// lifecycle-stop-warnings.ts. The dispatcher is a short switch and each handler
// is independently testable; buildStopWarnings and its wiring imports stay here
// so source-text regression tests continue to pass.
//
// `handleLifecycleEvent` returns:
//   - a `HarnessDecision` when the lifecycle branch produced an early
//     return (the original `switch` had `return { … }` arms);
//   - `null` when the original `switch` arm fell through with `break`,
//     i.e. the caller should continue into the Pre/Post evaluation path.

import { scanUserPrompt } from "../content-scanner/prompt-scan.js";
import { buildEditMechanicsStopNudge } from "../edit-mechanics-stop.js";
import { buildGateReachStopWarning } from "../gate-reach-collect.js";
import { deleteLiveSnapshot } from "../live-snapshot.js";
import {
	maybeCaptureFromPreToolUse,
	maybeCaptureFromUserPromptSubmit,
} from "../plan-capture.js";
import { detectPlanDrift, formatPlanDriftWarning } from "../plan-drift.js";
import { runSessionEndBaselineAutoFold } from "../baseline-autofold.js";
import { recordHarnessMissed } from "../recurrence.js";
import { runSessionEndScratchpadArchive } from "../scratchpad-archive.js";
import {
	formatSequenceFinding,
	runSequenceDetectorsForPhase,
} from "../sequence-checks/index.js";
import { buildStopDigest } from "../stop-digest.js";
import { buildPatternRescanWarnings } from "../stop-rescan.js";
import { clearArchive } from "../trajectory/fingerprint-archive.js";
import {
	formatSessionReworkNudge,
	sessionReworkSummary,
} from "../trajectory/session-rework.js";
import { buildTurnEndSummary, formatTurnEndWarnings } from "../turn-end.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	clearWorkspaceEffectSession,
	consumeWorkspaceResidue,
	formatWorkspaceResidueWarning,
} from "../workspace-effects.js";
import { captureBackgroundTasks } from "../background-task-log.js";
import { captureAgentEvent } from "./agent-event-capture.js";
import {
	handleSkillEnter,
	handleSkillLeave,
	handleSkillList,
	handleSubagentStop,
} from "./lifecycle-events-handlers.js";
import * as lifecyclePersist from "./lifecycle-persist.js";
import {
	autoStripSessionStartPermissions,
	refreshFilePriorityOnSessionStart,
	refreshTrigramIndexOnSessionStart,
} from "./lifecycle-session-start.js";
import {
	buildCommitCadenceNudge,
	buildStaleBaselineNudge,
	buildVerificationStopWarnings,
} from "./lifecycle-stop-warnings.js";
import type { ServerRuntime } from "./runtime-context.js";
import { runSessionEndJobs, runSessionEndResourcePlan } from "./session-end-batch.js";
import { writeSessionEndEvidence } from "./session-end-evidence.js";
import { runSessionEndHeavyJobs } from "./session-end-heavy-jobs.js";
import { readHeavyReports } from "./session-start-heavy-reports.js";
import { suppressRepeatedNudges } from "./stop-nudge-throttle.js";
import { peekTrajectoryState } from "./trajectory-shadow.js";

// Re-exported so `import { resolveParentSessionId } from "./lifecycle-events.js"`
// keeps working for existing consumers/tests after the helper move.
export { resolveParentSessionId } from "./lifecycle-events-handlers.js";

/** Deadline (in ms) to drain pending async analysis work before the Stop
 *  arm completes. Mirrors server.ts's constant. */
const ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Run the lifecycle-event `switch`. Returns a `HarnessDecision` for the arms
 * that produced an early return in the original `processEvent`, or `null`
 * when the arm fell through (`break`) and the caller should keep evaluating.
 */
export async function handleLifecycleEvent(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision | null> {
	const { cohort, log } = ctx;
	// Plan capture (PB&J item #2) — fires BEFORE the switch to observe
	// TaskCreate / ExitPlanMode on PreToolUse without intercepting the
	// pipeline. Best-effort, never blocks.
	if (event.hook_event === "PreToolUse") {
		const cfg = ctx.rules.plan_capture;
		const enabled = cfg?.enabled !== false;
		const captured = await maybeCaptureFromPreToolUse({
			event,
			session,
			cwd: ctx.cwd,
			enabled,
			log: ctx.log,
		});
		if (captured) {
			ctx.log(
				`Plan capture: ${captured.source} → ${captured.steps.length} step(s) (session ${captured.session_id})`,
			);
		}
	}
	// Background-agent roster (Stop / SubagentStop payloads). A background
	// agent fires no per-agent hook of its own, so this array is the only
	// report that it exists — see harness/background-task-log.ts.
	captureBackgroundTasks(event, ctx.cwd, log);

	switch (event.hook_event) {
		case "SessionStart":
			return handleSessionStart(ctx, event);
		case "SessionEnd":
			return handleSessionEnd(ctx, event);
		case "Stop":
			return handleStop(ctx, event, session);
		case "UserPromptSubmit":
			return handleUserPromptSubmit(ctx, event, session);
		case "SubagentStart":
			cohort.subagentJoined(event);
			captureAgentEvent(event, ctx.cwd, log);
			log(`Subagent joined: ${event.agent_name || "unnamed"}`);
			return null;
		case "SubagentStop":
			handleSubagentStop(ctx, event);
			// Durable capture: the subagent's RESULT (last_assistant_message /
			// transcript tail) → collection.jsonl, + its transcript → timeline.
			// Without this, a spawned agent's answer exists nowhere under
			// .interlinked/ (background results fire no other hook).
			captureAgentEvent(event, ctx.cwd, log);
			return null;
		case "TaskCompleted":
			cohort.recordActivity(event);
			captureAgentEvent(event, ctx.cwd, log);
			return null;
		case "SkillEnter":
			return handleSkillEnter(ctx, event, session);
		case "SkillLeave":
			return handleSkillLeave(ctx, event, session);
		case "SkillList":
			return handleSkillList(ctx, event, session);
		default:
			cohort.recordActivity(event);
			return null;
	}
}

// ─────────────────────────────────────────────────────────────────────
// Per-event handlers
// ─────────────────────────────────────────────────────────────────────

/** Cohort join + side-effects: file-priority refresh, trigram-index
 *  refresh, malformed-permission-rule auto-strip. Returns a decision
 *  only when the auto-strip surfaces a warning; otherwise falls through
 *  to `null` so the caller continues normal evaluation. */
async function handleSessionStart(
	ctx: ServerRuntime,
	event: HarnessEvent,
): Promise<HarnessDecision | null> {
	const { cohort, log } = ctx;
	cohort.agentJoined(event);
	log(`Agent joined: ${event.agent_name || event.session_id} (${event.agent_source})`);
	// Surface any completed SessionEnd heavy-job reports (fuzz-smoke failures,
	// bench regressions) as SessionStart context — never a mid-session surprise.
	// Fuzz failures are also recorded as a harness_missed recurrence.
	const heavyWarnings = readHeavyReports(ctx.cwd, (failed, files) => {
		recordHarnessMissed({
			signature: "fuzz_smoke_failure",
			check_id: "fuzz_smoke",
			message: `${failed} property/fuzz assertion(s) failed under elevated numRuns: ${files.join(", ")}`,
			cwd: ctx.cwd,
		});
	});
	refreshFilePriorityOnSessionStart(ctx, log);
	refreshTrigramIndexOnSessionStart(ctx, log);
	const stripDecision = autoStripSessionStartPermissions(ctx, log, heavyWarnings);
	if (stripDecision) return stripDecision;
	return heavyWarnings.length > 0 ? { decision: "allow", warnings: heavyWarnings } : null;
}

/** SessionEnd narrow body — defensive cleanup only.
 *
 * Per docs/design/test-quality-harness-local-first.md §1.1, SessionEnd is
 * wired narrowly and Claude-Code-only. The daemon's per-turn reflection
 * and cleanup already ran on the session's final Stop. The audit-chain
 * reason annotation is written from the hook template's `appendLocal`
 * (which applies chain fields when event_type === "session_end"); the
 * commit-attribution finalization (`reconcileCommits`) runs in the hook
 * template at hooks-template.ts:1023-1025.
 *
 * Edge cases like `/clear` during prompt-input can fire SessionEnd
 * without a final Stop for the in-flight session, so we drop in-memory
 * session state here to avoid leaks. Safe to re-run: each call site
 * below uses an underlying delete/remove primitive that is a no-op when
 * the key is absent (Map.delete and the SessionTracker/Set semantics
 * match), so the prior Stop having already removed the same keys does
 * not cause an error. No reflection, no nudges — those ran on the prior
 * Stop (if any).
 */
function handleSessionEnd(ctx: ServerRuntime, event: HarnessEvent): HarnessDecision {
	const { sessions } = ctx;
	// Archive the session scratchpad before the OS purges it (scratchpad-
	// governance Phase 1). Never-throw by contract; bounded by config caps.
	runSessionEndScratchpadArchive({ cwd: ctx.cwd, sessionId: event.session_id, rules: ctx.rules, log: ctx.log });
	// Good-citizen resource plan + fire-and-forget background jobs (job 4: recurrence
	// scan). Computed BEFORE state removal so the cohort count is accurate.
	const resourcePlan = runSessionEndResourcePlan(ctx, event);
	if (resourcePlan) {
		runSessionEndJobs(ctx, resourcePlan);
		runSessionEndHeavyJobs(ctx, event, resourcePlan); // fuzz-smoke + bench (run-if-exists)
	}
	// Evidence bundle (job 5) + the TIGHTEN-ONLY baseline auto-fold (harness-internal
	// `fs` raises — baseline-autofold.ts): both read the session's signals BEFORE removal.
	const endedSession = sessions.get(event.session_id);
	if (endedSession) writeSessionEndEvidence(ctx.cwd, endedSession);
	const folds = runSessionEndBaselineAutoFold({ cwd: ctx.cwd, rules: ctx.rules, log: ctx.log, event, session: endedSession });
	sessions.remove(event.session_id);
	ctx.asyncFindings.clearSession(event.session_id);
	clearArchive(ctx.cwd, event.session_id);
	deleteLiveSnapshot(ctx.cwd, event.session_id);
	ctx.classifierSessions.delete(event.session_id);
	ctx.autoCoordStates.delete(event.session_id);
	clearWorkspaceEffectSession(event.session_id);
	return folds.length > 0 ? { decision: "allow", warnings: folds } : { decision: "allow" };
}

function reconcileStopWorkspaceEffects(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string[] {
	// Pre/Post snapshots are always rooted at the daemon workspace. A runner's
	// event.cwd may be a subdirectory, so using it here would compare unrelated
	// relative-path namespaces and manufacture create/delete residue.
	const residue = consumeWorkspaceResidue(event.session_id, ctx.cwd);
	for (const effect of residue?.files ?? []) session.files_written.add(effect.path);
	const warning = residue ? formatWorkspaceResidueWarning(residue) : null;
	return warning ? [warning] : [];
}

/** Stop body — turn-end reflection + trajectory persistence + cleanup.
 *
 * Three internal stages, each its own helper for readability:
 *   1. {@link buildStopWarnings} — turn-end summary + commit-cadence nudge
 *      + verification-stop-checks + dead-on-arrival
 *   2. {@link persistSessionTrajectory} — sanitize session_id + path-traversal
 *      check + write trajectory.json (async; uses fs/promises)
 *   3. {@link cleanupSessionState} — drain async analysis + cohort + reservation
 *      release + in-memory session state removal
 *
 * Stop fires per turn, so cleanup runs every turn (the per-Stop release is
 * the implicit "rebuild on next UserPromptSubmit" pattern). SessionEnd's
 * defensive cleanup mirrors this for the edge case where Stop didn't fire
 * before the session terminated.
 */
async function handleStop(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	const { log } = ctx;
	const residueWarnings = reconcileStopWorkspaceEffects(ctx, event, session);
	const turnSummary = buildTurnEndSummary(session, 0, 0);
	const turnWarnings = formatTurnEndWarnings(turnSummary);
	if (turnWarnings.length > 0) {
		log(`Turn-end patterns: ${turnSummary.turn_patterns.join(", ")}`);
	}
	for (const w of buildStopWarnings(ctx, event, session)) {
		turnWarnings.push(w);
	}
	turnWarnings.push(...residueWarnings);
	// Plan-drift reflection (PB&J item #6) — compare session.declared_plan
	// against the actual tool_sequence; advisory-only, never blocks.
	const driftReport = detectPlanDrift(session);
	if (driftReport) {
		const driftWarning = formatPlanDriftWarning({ report: driftReport });
		if (driftWarning) turnWarnings.push(driftWarning);
	}
	await persistSessionTrajectory({ ctx, event, session, turnSummary });
	await ctx.asyncAnalysis.drain(ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS);
	cleanupSessionState(ctx, event, session);
	log(`Agent left: ${event.agent_name || event.session_id}`);
	// Rank + cap the WHOLE Stop wall (stop-digest.ts): actionable first, ≤15
	// stderr lines, full detail spooled to .interlinked/stop-digest.jsonl.
	const stopCwd = event.cwd || ctx.cwd;
	const digest = buildStopDigest({ warnings: turnWarnings, cwd: stopCwd, sessionId: event.session_id, dryRun: event.dry_run });
	return { decision: "allow", warnings: digest.length > 0 ? digest : undefined };
}

/** UserPromptSubmit — cohort tracking + PII scan with redacted-prompt
 *  rewrite. Never blocks (users can always submit their own prompts);
 *  this is storage hygiene, not a policy gate. */
async function handleUserPromptSubmit(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session?: SessionTrajectory,
): Promise<HarnessDecision> {
	const { cohort, log } = ctx;
	cohort.recordActivity(event);
	// Plan capture (PB&J item #2) — structured `## Plan` parser, behind a
	// config flag (default off — false-positive risk). Best-effort.
	if (session) {
		const planCfg = ctx.rules.plan_capture;
		const planCaptured = await maybeCaptureFromUserPromptSubmit({
			event,
			session,
			cwd: ctx.cwd,
			enabled: planCfg?.enabled !== false,
			parseUserPrompt: planCfg?.parse_userprompt === true,
			log: ctx.log,
		});
		if (planCaptured) {
			log(
				`Plan capture (user-prompt): ${planCaptured.steps.length} step(s) (session ${planCaptured.session_id})`,
			);
		}
	}
	if (ctx.rules.content_scanner?.enabled && ctx.contentScanner) {
		const promptText = event.prompt ?? "";
		const scanResult = await scanUserPrompt(promptText, ctx.rules, ctx.contentScanner);
		if (scanResult) {
			log(
				`Content scanner: UserPromptSubmit — ${scanResult.findings.length} finding(s), redacted for local log`,
			);
			return { decision: "allow", redacted_prompt: scanResult.redacted };
		}
	}
	return { decision: "allow" };
}

// ─────────────────────────────────────────────────────────────────────
// handleStop internal helpers
// ─────────────────────────────────────────────────────────────────────

/** Thin dispatcher: commit-cadence nudge + verification-stop-checks.
 *  Each sub-stage is its own helper so this function stays a flat list
 *  of "produce a warning, maybe push it." Heavy check helpers live in
 *  lifecycle-stop-warnings.ts; this dispatcher and its wiring imports
 *  stay here so source-text regression tests pin the Stop→rescan wiring. */
function buildStopWarnings(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): string[] {
	const warnings: string[] = [];
	const cadenceWarning = buildCommitCadenceNudge(ctx, event, session);
	if (cadenceWarning !== null) warnings.push(cadenceWarning);
	// LG-5 edit-mechanics reflection — doomed-anchor/rescue/staleness summary.
	const editMechanicsWarning = buildEditMechanicsStopNudge(session);
	if (editMechanicsWarning !== null) warnings.push(editMechanicsWarning);
	// Stale quality baselines. Not about THIS turn: it reports that the ratchets
	// themselves are measuring against an out-of-date water-line. Self-throttled
	// to once a day so a weeks-stale baseline does not nag every Stop.
	const staleBaselineWarning = buildStaleBaselineNudge(ctx, event, session.files_written.size > 0);
	if (staleBaselineWarning !== null) warnings.push(staleBaselineWarning);
	for (const w of buildVerificationStopWarnings(ctx, event, session)) {
		warnings.push(w);
	}
	// Deterministic pattern rescan over every file the agent touched this turn.
	// Filtering, actor attribution and ranking live in stop-rescan-report.ts;
	// detector errors are swallowed inside, so this branch never throws.
	const cwd = event.cwd || ctx.cwd;
	for (const w of buildPatternRescanWarnings(session, cwd, {
		sessionId: event.session_id,
		dryRun: event.dry_run,
	})) {
		warnings.push(w);
	}
	// Gate reach (plan 16 §4) — each gate's coverage OF ITSELF; disabled gates are
	// LOUD (silent disablement is the failure this prevents). Read-only sessions
	// (zero files_written) skip it — the gates judged none of this session's work.
	const gateReachWarning = buildGateReachStopWarning({
		cwd,
		sessionId: event.session_id || "unknown",
		perEditCoverageEnabled: ctx.rules.per_edit_coverage?.enabled !== false,
		sessionWroteFiles: session.files_written.size > 0,
	});
	if (gateReachWarning !== null) warnings.push(gateReachWarning);
	// Stop-phase sequence detectors — multi-event quality + cross-agent +
	// install-then-execute shapes. Sibling family to `buildPatternRescanWarnings`
	// (which rescans per-file content); these run over the trajectory state.
	// No-op until detectors register with `default_enabled: true`.
	const stopFindings = runSequenceDetectorsForPhase({
		phase: "stop",
		trajectory: session,
		candidate: event,
	});
	for (const f of stopFindings) warnings.push(formatSequenceFinding(f));
	// Session-rework aggregate (7d) — the churn family's quantitative roll-up:
	// share of edits that returned a file to earlier content. Nudge-only above
	// generous floors; silent when the shadow engine never folded this session.
	const trajectoryState = peekTrajectoryState(event.session_id);
	if (trajectoryState) {
		const reworkNudge = formatSessionReworkNudge(sessionReworkSummary(trajectoryState));
		if (reworkNudge !== null) warnings.push(reworkNudge);
	}
	// Say each distinct nudge ONCE per session: a Stop reflection that repeats
	// verbatim with nothing changed is a loop, not a reminder (it trapped a real
	// install waiting on a HUMAN decision). Applied at the outermost assembler
	// so it covers every nudge family, not one. See stop-nudge-throttle.ts.
	return suppressRepeatedNudges({ projectRoot: ctx.cwd, sessionId: event.session_id }, warnings);
}

// persistSessionTrajectory + cleanupSessionState moved VERBATIM to
// lifecycle-persist.ts (line-cap decomposition, 2026-07-17); the source-text
// security pins moved to lifecycle-persist.test.ts. Local bindings preserved
// so handleStop's call sites stay byte-stable.
const { persistSessionTrajectory, cleanupSessionState } = lifecyclePersist;
