// ===========================================
// Daemon-side operator taint control
// ===========================================
//
// The CLI reaches this over the raw socket with `hook_event: "TaintControl"`,
// the same control-channel shape `HookCoverage` already uses (one JSON line
// in, one `HarnessDecision` out, the report in `additional_context`). It is
// answered at the transport boundary, BEFORE the normal event pipeline, so an
// operator query never creates a session, never mints an event ordinal and
// never counts as a tool call.
//
// Two carriers hold a session's level and both must agree after a clear: the
// daemon's in-memory trajectory governs the tool calls happening right now,
// and `<id>.live.json` is what a resume re-hydrates. A clear that touched only
// one of them would be silently undone (memory-only: on the next resume;
// file-only: by the next event the live session writes).

import { isJsonObject } from "../../lib/json-types.js";
import { writeLiveSnapshot } from "../live-snapshot.js";
import {
	clearActorTaint,
	clearSessionTaint,
	isTaintControlRequest,
	TAINT_CONTROL_EVENT,
	type TaintControlReport,
	type TaintControlRequest,
	type TaintViewOrigin,
	unknownSessionReport,
	viewFromSession,
} from "../taint-control.js";
import {
	clearTaintInSnapshot,
	listTaintedSnapshotViews,
	readTaintSnapshotView,
} from "../taint-snapshot.js";
import type { HarnessDecision, SessionTrajectory, TaintTrackingConfig } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/** The slice of the daemon runtime taint control needs. Narrow on purpose:
 *  these handlers read session state and config, and write one snapshot. */
export type TaintRuntime = Pick<ServerRuntime, "cwd" | "rules" | "sessions" | "log">;

/** Intercept a `TaintControl` line. Returns undefined for every other event so
 *  the caller falls through to the normal pipeline. */
export function taintControlQuery(ctx: TaintRuntime, value: unknown): HarnessDecision | undefined {
	if (!isJsonObject(value) || value.hook_event !== TAINT_CONTROL_EVENT) return undefined;
	if (!isTaintControlRequest(value.request)) {
		return { decision: "block", reason: "Invalid taint control operation" };
	}
	return {
		decision: "allow",
		additional_context: JSON.stringify(handleTaintControl(ctx, value.request)),
	};
}

export function handleTaintControl(
	ctx: TaintRuntime,
	request: TaintControlRequest,
): TaintControlReport {
	const config = ctx.rules.taint_tracking;
	if (request.operation === "status") return taintStatus(ctx, config, request.session_id);
	return taintClear({
		ctx,
		config,
		sessionId: request.session_id,
		reason: request.reason,
		actor: request.actor,
	});
}

/** One clear request, fully resolved. Grouped so neither handler takes four
 *  positional parameters two of which are strings. */
interface ClearArgs {
	ctx: TaintRuntime;
	config: TaintTrackingConfig;
	reason: string;
}

function taintStatus(
	ctx: TaintRuntime,
	config: TaintTrackingConfig,
	sessionId: string | undefined,
): TaintControlReport {
	if (sessionId !== undefined) {
		const live = ctx.sessions.get(sessionId);
		if (live) return { ok: true, session: viewFromSession(live, config) };
		const stored = readTaintSnapshotView(ctx.cwd, sessionId, config);
		return stored ? { ok: true, session: stored } : unknownSessionReport(sessionId);
	}
	const live = ctx.sessions.getAll().map((session) => viewFromSession(session, config));
	const inMemory = new Set(live.map((view) => view.session_id));
	const stored = listTaintedSnapshotViews(ctx.cwd, config).filter(
		(view) => !inMemory.has(view.session_id),
	);
	return { ok: true, sessions: [...live, ...stored] };
}

/** Clear a session the daemon currently holds: memory first, then the snapshot
 *  that memory serializes to, so a resume cannot resurrect the level. */
function clearLiveSession(args: ClearArgs & { session: SessionTrajectory }): TaintControlReport {
	const { ctx, config, session, reason } = args;
	if (session.sensitivity_level === "Public") {
		return { ok: false, reason: `Session ${session.session_id} is already Public` };
	}
	const outcome = clearSessionTaint(session, config, reason);
	const appliedTo: TaintViewOrigin[] = ["daemon-memory"];
	const snapshot = ctx.sessions.serialize(session.session_id);
	if (snapshot && writeLiveSnapshot(ctx.cwd, session.session_id, snapshot).ok) {
		appliedTo.push("live-snapshot");
	}
	ctx.log(
		`Taint cleared by operator: ${session.session_id} ${outcome.previous_level} → Public (${reason})`,
	);
	return {
		ok: true,
		cleared: { ...outcome, applied_to: appliedTo },
		session: viewFromSession(session, config),
	};
}

/** Clear ONE actor of a live session (B3): the session level and every other
 *  actor stay as they are, and only that actor's tainted files are dropped. */
function clearLiveActor(args: ClearArgs & { session: SessionTrajectory; actor: string }): TaintControlReport {
	const { ctx, config, session, actor, reason } = args;
	const outcome = clearActorTaint(session, actor, reason);
	if (!outcome.ok) return { ok: false, reason: outcome.reason };
	const appliedTo: TaintViewOrigin[] = ["daemon-memory"];
	const snapshot = ctx.sessions.serialize(session.session_id);
	if (snapshot && writeLiveSnapshot(ctx.cwd, session.session_id, snapshot).ok) {
		appliedTo.push("live-snapshot");
	}
	ctx.log(
		`Actor taint cleared by operator: ${session.session_id}/${actor} ${outcome.previous_level} → Public (${reason})`,
	);
	return {
		ok: true,
		cleared: {
			session_id: session.session_id,
			previous_level: outcome.previous_level,
			previous_step_limit: null,
			new_level: "Public",
			new_step_limit: null,
			set_by: `actor ${actor}`,
			set_by_inferred: false,
			reason,
			applied_to: appliedTo,
		},
		session: viewFromSession(session, config),
	};
}

function taintClear(args: ClearArgs & { sessionId: string; actor?: string | undefined }): TaintControlReport {
	const { ctx, config, sessionId, reason, actor } = args;
	const live = ctx.sessions.get(sessionId);
	if (actor !== undefined) {
		// Per-actor clear needs the live lineage: a snapshot-only session has no
		// registered actors in memory to lower.
		return live
			? clearLiveActor({ ctx, config, session: live, actor, reason })
			: { ok: false, reason: `No live session ${sessionId}: --actor needs a running daemon that holds its lineage` };
	}
	if (live) return clearLiveSession({ ctx, config, session: live, reason });
	const stored = clearTaintInSnapshot(ctx.cwd, sessionId, config, reason);
	if (!stored.ok) {
		// Distinguish "no such session" from "nothing to clear": only the first
		// is an operator typo, and only the second means the state is already fine.
		const exists = readTaintSnapshotView(ctx.cwd, sessionId, config) !== null;
		return exists ? { ok: false, reason: stored.reason } : unknownSessionReport(sessionId);
	}
	ctx.log(
		`Taint cleared by operator in snapshot: ${sessionId} ${stored.outcome.previous_level} → Public (${reason})`,
	);
	const view = readTaintSnapshotView(ctx.cwd, sessionId, config);
	return {
		ok: true,
		cleared: { ...stored.outcome, applied_to: ["live-snapshot"] },
		...(view ? { session: view } : {}),
	};
}
