// ===========================================
// Harness server event loop
// ===========================================
// Extracted from server.ts. The per-event evaluation pipeline: parse a raw
// hook payload, hydrate/record session trajectory, dispatch to the
// lifecycle / Pre / Post pipelines, then write the live snapshot + latency
// log. Also owns the protocol-status event counter mutations.
//
// server.ts builds the `ServerRuntime` context and a few module-scoped
// callbacks (idle-timer reset, runtime in/out sync, collection-record
// writer) and hands them to `createEventLoop`, which closes over them and
// returns the two entry points the socket servers call. Keeping these
// module-global dependencies as explicit parameters (rather than closures
// over `server.ts` `let`s) is what lets the loop live in its own file
// without behavior change — startup order and side effects are identical.

import { isJsonObject } from "../lib/json-types.js";
import type { JsonObject } from "../lib/json-types.js";
import { appendCheckResults } from "./check-results-sink.js";
import { forwardCloudPreToolUse } from "./cloud-forward.js";
import { enrichCodexSubagentAttribution } from "./codex-subagent-attribution.js";
import { appendLatencyLog } from "./latency-log.js";
import { toLegacyHarnessEvent } from "./legacy-client.js";
import { readLiveSnapshot, writeLiveSnapshot } from "./live-snapshot.js";
import { liftOutcomeEvidence } from "./outcome-evidence.js";
import { runWithClock } from "./replay/harness-clock.js";
import { maybeRecordReplaySnapshots, phaseForHookEvent } from "./replay/tree-snapshot.js";
import { recordGuardDecision } from "./guard-tally.js";
import { buildLatencyRecord } from "./server/latency-record.js";
import { handleLifecycleEvent } from "./server/lifecycle-events.js";
import {
	POST_TOOL_PIPELINE_FAILURE_WARNING,
	runPostToolPipeline,
} from "./server/post-tool-pipeline.js";
import { runPreToolPipeline } from "./server/pre-tool-pipeline.js";
import {
	recordProtocolEvent as bumpProtocolEvent,
	type ProtocolStatusFile,
	writeProtocolStatus as persistProtocolStatus,
} from "./server/protocol-status.js";
import type { ServerRuntime } from "./server/runtime-context.js";
import { mergeTrajectoryShadow } from "./server/trajectory-shadow.js";
import { isPostToolUse, isPreToolUse } from "./server-tool-helpers.js";
import { captureTimeline } from "./timeline-capture.js";
import { observeBlockWorkaround } from "./trajectory/block-fingerprint-session.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";
import { discardWorkspaceSnapshot } from "./workspace-effects.js";

// `session.files_read` is typed as a required `Set<string>`, but some
// session snapshots (e.g. mid-hydration, or test doubles) genuinely omit it
// at runtime — keep the fallback honest instead of crashing on spread.
function readFilesReadSnapshot(files_read: Set<string> | undefined | null): string[] {
	return [...(files_read ?? [])];
}

function reconcileBlockedPreTool(event: HarnessEvent, decision: HarnessDecision): void {
	if (decision.decision !== "block") return;
	discardWorkspaceSnapshot({
		toolUseId: event.tool_use_id,
		sessionId: event.session_id,
	});
}

/** Persist only events outside the tool pipelines. Keeping this partition in a
 *  helper prevents the lifecycle mirror from becoming a second Pre/Post tool
 *  writer while leaving the already-dense event dispatcher branch-neutral. */
function persistNonToolLifecycleActivity(
	writeRecord: (event: HarnessEvent, decision?: HarnessDecision) => void,
	event: HarnessEvent,
	decision: HarnessDecision | null,
): void {
	if (isPreToolUse(event) || isPostToolUse(event)) return;
	writeRecord(event, decision ?? undefined);
}

/** Dependencies the event loop closes over. The `ServerRuntime` carries the
 *  bulk of daemon state; the rest are module-scoped callbacks / objects that
 *  live in `server.ts` (the idle timer, the runtime in/out sync, the
 *  protocol-status object + its path, the collection-record writer). */
export interface EventLoopDeps {
	readonly ctx: ServerRuntime;
	readonly protocolStatus: ProtocolStatusFile;
	readonly protocolStatusPath: string;
	readonly resetIdleTimer: () => void;
	readonly syncRuntimeIn: () => void;
	readonly syncRuntimeOut: () => void;
	readonly writeCollectionRecord: (event: HarnessEvent, decision?: HarnessDecision) => void;
	readonly writeLifecycleActivityRecord: (
		event: HarnessEvent,
		decision?: HarnessDecision,
	) => void;
}

/** The two entry points the socket servers invoke, plus the protocol-status
 *  serializer that `server.ts` startup also calls. */
interface EventLoop {
	evaluateEventLine: (line: string, protocol: "raw" | "framed") => Promise<HarnessDecision>;
	evaluateUnifiedViaRuntime: (event: UnifiedHookEvent) => Promise<HarnessDecision>;
	writeProtocolStatus: () => void;
}

/** G4 replay mode: the frozen evaluation clock for this event, or null on
 *  the live path. Active only with INTERLINKED_REPLAY_CLOCK=event and a
 *  parseable event timestamp — every time-window branch then reproduces its
 *  recorded verdict (docs/design/reproducibility/g4-harness-determinism.md). */
function replayClockFor(parsed: JsonObject): number | null {
	if (process.env.INTERLINKED_REPLAY_CLOCK !== "event") return null;
	if (typeof parsed.timestamp !== "string") return null;
	const ms = Date.parse(parsed.timestamp);
	return Number.isFinite(ms) ? ms : null;
}

/** Build the per-event evaluation pipeline. Returns the entry points the raw
 *  and framed socket servers call. All daemon state is reached through `deps`
 *  — the function bodies are moved verbatim from the monolithic server.ts. */
export function createEventLoop(deps: EventLoopDeps): EventLoop {
	const {
		ctx,
		protocolStatus,
		protocolStatusPath,
		resetIdleTimer,
		syncRuntimeIn,
		syncRuntimeOut,
		writeCollectionRecord,
		writeLifecycleActivityRecord,
	} = deps;
	const { log, sessions } = ctx;
	const CWD = ctx.cwd;
	const INTERLINKED_DIR = ctx.interlinkedDir;

	// Daemon-lifetime telemetry counter. Write-only — incremented on every
	// processed event, never read back (the old module-level `_totalEventsProcessed`).
	let _totalEventsProcessed = 0;

	function writeProtocolStatus(): void {
		persistProtocolStatus(protocolStatusPath, protocolStatus);
	}

	function recordProtocolEvent(protocol: "raw" | "framed"): void {
		bumpProtocolEvent(protocolStatus, protocol);
		writeProtocolStatus();
	}

	async function processEvent(rawData: string): Promise<HarnessDecision> {
		let event: HarnessEvent;
		try {
			event = JSON.parse(rawData.trim());
		} catch (cause) {
			// SECURITY: Malformed events must NOT be allowed through.
			// A broken payload could be a parser-differential attack or a
			// corrupted hook script — either way, we cannot evaluate safety.
			log(`Event parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
			return { decision: "block", reason: "Malformed event — cannot evaluate safety." };
		}

		_totalEventsProcessed++;
		resetIdleTimer();

		// Lift object-tool_response outcome evidence onto the flat fields BEFORE
		// any tracker reads the event — `recordEvent` (trackErrorOutcome) and the
		// PostToolUse pipeline (trackTestRun) both classify on them. Both socket
		// protocols funnel through here, so this is the one call that guarantees
		// a green test run's evidence is visible however the hook delivered it.
		liftOutcomeEvidence(event);
		enrichCodexSubagentAttribution(event);

		// Lazy hydrate: if the in-memory tracker has no entry for this session
		// but disk has a `<id>.live.json` from a previous incarnation of this
		// daemon, restore it before recordEvent so the upcoming event lands on
		// continuous trajectory state (acknowledged checks, edit counts, fired
		// reminders, TDD cycles, ...) instead of resetting to a fresh session.
		if (event.session_id && !sessions.get(event.session_id)) {
			const snap = readLiveSnapshot(CWD, event.session_id);
			if (snap) {
				const restored = sessions.hydrate(snap);
				if (restored) {
					log(
						`Hydrated session ${event.session_id} from live snapshot ` +
							`(${restored.tool_call_count} tool calls, ${restored.files_written.size} files written)`,
					);
				}
			}
		}

		// Update session trajectory.
		// Per-event durability: the snapshot write moved out of this function and
		// runs from `evaluateEventLine` AFTER `processEvent` returns, so the
		// snapshot reflects post-event mutations too — PostToolUse handlers
		// updating `tdd_cycles`, `assertion_counts`, or `active_skills` would
		// otherwise be lost on a daemon restart even though `recordEvent` mutated
		// state that *was* captured. See `evaluateEventLine`'s try/finally.
		const session = sessions.recordEvent(event);

		// G3: stamp the per-session monotonic ordinal on EVERY observed event —
		// the daemon's serial observation is the canonical total order (parallel
		// tool calls share ms timestamps). Writers persist `event.seq` from here.
		event.seq = sessions.nextSeq(session.session_id);

		// Live timeline capture: drain the transcript (new records since the
		// cursor) into .interlinked/timeline.jsonl on EVERY event. Runs for Stop /
		// SessionEnd too — that's what captures a turn's final assistant message,
		// which fires no PreToolUse. Best-effort / fail-open (never throws).
		captureTimeline(event, CWD);

		syncRuntimeIn();
		try {
			// Lifecycle events (SessionStart / SessionEnd / Stop / Subagent* /
			// Skill* / UserPromptSubmit): a non-null decision is an early return,
			// null means fall through to the Pre/Post evaluation path.
			const lifecycleDecision = await handleLifecycleEvent(ctx, event, session);
			persistNonToolLifecycleActivity(writeLifecycleActivityRecord, event, lifecycleDecision);
			// Shadow-eval lifecycle events too (Stop carries the obligation-ledger
			// inventory). Metric-only: appends warnings, never alters the decision.
			if (lifecycleDecision) { mergeTrajectoryShadow(event, lifecycleDecision, ctx.rules); return lifecycleDecision; }

			// Evaluate based on hook type
			if (isPreToolUse(event)) {
				const local = await runPreToolPipeline(ctx, event, session);
				// P1 trajectory continuity (shadow): arm a fingerprint when this
				// event was blocked; on a later event that gets through, note if it
				// reproduces a still-armed refusal through another channel. Never
				// alters the decision — surfaced once at Stop.
				observeBlockWorkaround(session, event, local, event.cwd ?? CWD, Date.now());
				mergeTrajectoryShadow(event, local, ctx.rules, readFilesReadSnapshot(session.files_read));
				writeCollectionRecord(event, local);
				const finalDecision = await forwardCloudPreToolUse(event, local);
				reconcileBlockedPreTool(event, finalDecision);
				return finalDecision;
			}

			if (isPostToolUse(event)) {
				try {
					const decision = await runPostToolPipeline(ctx, event, session);
					// `session.files_read` survives a daemon restart (it is in the
					// live snapshot); the trajectory engine's own read map does not.
					// Passing it seeds a state created after a restart, so reads from
					// before it are not forgotten mid-session (red-team F4).
					mergeTrajectoryShadow(event, decision, ctx.rules, readFilesReadSnapshot(session.files_read));
					writeCollectionRecord(event, decision);
					// Fire-and-forget faithful per-call record for the viz BASELINE filmstrip.
					// Runs AFTER the decision is returned to the hook — never blocks the tool loop.
					appendCheckResults(CWD, event, decision);
					return decision;
				} catch (postErr) {
					// PostToolUse runs AFTER the tool — the action already happened, so
					// a thrown observability/quality check must NEVER become a block. A
					// reason-less block here was surfacing to the user as a spurious
					// "harness bug". Fail OPEN (feedback_safety_continuity) and report
					// the skipped check as a non-blocking warning.
					log(
						`PostToolUse pipeline threw (failing open): ${
							postErr instanceof Error ? postErr.message : String(postErr)
						}`,
					);
					return {
						decision: "allow",
						warnings: [POST_TOOL_PIPELINE_FAILURE_WARNING],
					};
				}
			}

			// Non-tool events (lifecycle, notifications, etc.) — always allow
			return { decision: "allow" };
		} finally {
			syncRuntimeOut();
		}
	}

	/** Per-event durability: write the live snapshot AFTER `processEvent`
	 *  completes so it reflects every post-event state mutation — PostToolUse
	 *  handlers updating `tdd_cycles`, `assertion_counts`, `active_skills`,
	 *  etc. The earlier "snapshot right after recordEvent" placement lost
	 *  those mutations on a daemon restart between events. Best-effort: write
	 *  failures are logged but never block the decision return (called from
	 *  `evaluateEventLine`'s `finally`, so its own errors must not escape).
	 *  Extracted from `evaluateEventLine` verbatim — same try/catch scope,
	 *  same fail-open contract, just a fresh function so the nesting the
	 *  enclosing `if (sessionIdForSnap)` + `finally` added doesn't count
	 *  against the caller's cognitive-complexity budget. */
	function persistEventSnapshot(
		sessionId: string,
		hookEventForSnap: string | undefined,
		toolUseIdForSnap: string | null,
	): void {
		try {
			const snap = sessions.serialize(sessionId);
			if (snap) {
				const writeResult = writeLiveSnapshot(CWD, sessionId, snap);
				if (!writeResult.ok) {
					log(`Live snapshot write failed (non-fatal): ${writeResult.error.message}`);
				}
				// G2 replay capture (env-gated, fail-open): tree snapshot +
				// per-step state archive at tool boundaries. `snap.last_seq`
				// IS this event's seq — the mint ran inside processEvent.
				maybeRecordReplaySnapshots({
					cwd: CWD,
					sessionId,
					seq: typeof snap.last_seq === "number" ? snap.last_seq : null,
					toolUseId: toolUseIdForSnap,
					phase: phaseForHookEvent(hookEventForSnap),
					liveSnapshot: snap,
					log,
				});
			}
		} catch (e) {
			log(`Live snapshot write threw: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function evaluateEventLine(
		line: string,
		protocol: "raw" | "framed",
	): Promise<HarnessDecision> {
		// Parse session_id once up-front so the durability finally block can run
		// even when `processEvent` throws — the session was already created (or
		// hydrated) by the time recordEvent ran, so a snapshot is safe to write.
		// hook_event/tool_use_id ride along for the G2 replay-snapshot wiring.
		let sessionIdForSnap: string | null = null;
		let hookEventForSnap: string | undefined;
		let toolUseIdForSnap: string | null = null;
		let replayClockMs: number | null = null;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isJsonObject(parsed)) {
				if (typeof parsed.session_id === "string") sessionIdForSnap = parsed.session_id;
				if (typeof parsed.hook_event === "string") hookEventForSnap = parsed.hook_event;
				if (typeof parsed.tool_use_id === "string") toolUseIdForSnap = parsed.tool_use_id;
				replayClockMs = replayClockFor(parsed);
			}
		} catch (e) {
			void e;
		}

		try {
			const decision =
				replayClockMs !== null
					? await runWithClock(replayClockMs, () => processEvent(line))
					: await processEvent(line);
			recordProtocolEvent(protocol);
			// Statusline substrate: what the harness actually DID this run.
			// O(1); read on the 10s snapshot tick, never on the hook path.
			recordGuardDecision(decision);
			try {
				appendLatencyLog(INTERLINKED_DIR, buildLatencyRecord(line, decision));
			} catch (e) {
				void e;
			}
			return decision;
		} finally {
			// See persistEventSnapshot's doc comment for the durability
			// rationale (why this runs here, in the `finally`, after
			// `processEvent` returns rather than right after `recordEvent`).
			if (sessionIdForSnap) {
				persistEventSnapshot(sessionIdForSnap, hookEventForSnap, toolUseIdForSnap);
			}
		}
	}

	async function evaluateUnifiedViaRuntime(event: UnifiedHookEvent): Promise<HarnessDecision> {
		try {
			const legacyEvent = toLegacyHarnessEvent(event);
			return await evaluateEventLine(JSON.stringify(legacyEvent), "framed");
		} catch (err) {
			protocolStatus.framed_error_count++;
			writeProtocolStatus();
			throw err;
		}
	}

	return { evaluateEventLine, evaluateUnifiedViaRuntime, writeProtocolStatus };
}
