// ===========================================
// Stop/SessionEnd persistence + cleanup helpers
// ===========================================
//
// Extracted verbatim from lifecycle-events.ts (line-cap decomposition,
// LG-5 wiring 2026-07-17). Same contract, same source-text pins — the
// security assertions in lifecycle-events.test.ts read THIS file now.

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { deleteLiveSnapshot } from "../live-snapshot.js";
import { sanitizeSessionId } from "../session-paths.js";
import type { buildTurnEndSummary } from "../turn-end.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Sanitize the session_id, build the trajectory.json path under
 *  `.interlinked/sessions/`, containment-check it, and write the
 *  serialized trajectory + turn-summary + feedback-effectiveness.
 *
 *  Async because the trajectory write is real disk I/O on the daemon's
 *  event loop and shouldn't block other concurrent hook evaluations.
 *  Failure is non-fatal — the catch arm logs and swallows so a transient
 *  write failure doesn't cascade into a missed Stop reply.
 *
 *  SECURITY: event.session_id arrives over the Unix socket as
 *  arbitrary JSON-parsed data. Without sanitization, a payload like
 *  "../../../.config/target" would escape sessDir via path.join (which
 *  does not contain traversal). We both sanitize (whitelist charset +
 *  length cap) and containment-check the resolved path before writing.
 *  The source-text assertions in lifecycle-events.test.ts pin both
 *  halves in place — do NOT remove sanitizeSessionId() or the
 *  resolve()/resolvedDir + sep check.
 */
export async function persistSessionTrajectory(opts: {
	ctx: ServerRuntime;
	event: HarnessEvent;
	session: SessionTrajectory;
	turnSummary: ReturnType<typeof buildTurnEndSummary>;
}): Promise<void> {
	const { ctx, event, turnSummary } = opts;
	const trajectory = ctx.sessions.serialize(event.session_id);
	if (!trajectory) return;
	try {
		const sessDir = join(ctx.cwd, ".interlinked", "sessions");
		// `mkdir({ recursive: true })` is idempotent — it does not throw
		// when the directory already exists, so a prior `existsSync`
		// gate would be redundant.
		await mkdir(sessDir, { recursive: true });
		const safeId = sanitizeSessionId(event.session_id);
		if (!safeId) {
			throw new Error("invalid session_id: no safe characters");
		}
		const targetPath = join(sessDir, `${safeId}.trajectory.json`);
		const resolvedDir = resolve(sessDir);
		const resolvedTarget = resolve(targetPath);
		if (
			resolvedTarget !== resolvedDir &&
			!resolvedTarget.startsWith(resolvedDir + sep)
		) {
			throw new Error(
				`refusing to write trajectory outside sessions dir: ${resolvedTarget}`,
			);
		}
		await writeFile(
			targetPath,
			JSON.stringify(
				{
					...trajectory,
					turn_summary: turnSummary,
					feedback_evidence: { schema: "finding-outcomes.v1", source: ".interlinked/check-results.jsonl", legacy_resolution_rate: "not-computed" },
				},
				null,
				2,
			),
		);
		ctx.log(`Session trajectory saved: ${event.session_id}`);
	} catch (err) {
		ctx.log(
			`Failed to save trajectory (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Per-Stop cleanup: cohort departure, reservation release, in-memory
 *  session removal, async-findings clear, live-snapshot deletion,
 *  classifier + auto-coord state drop. Safe to re-run — SessionEnd's
 *  narrow body re-runs the same removals as a safety net for the edge
 *  case where Stop didn't fire before the session terminated. */
export function cleanupSessionState(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): void {
	const { cohort, sessions, reservations } = ctx;
	cohort.agentLeft(event);
	reservations.releaseAllForAgent(event.agent_name || session.agent_name, cohort);
	sessions.remove(event.session_id);
	ctx.asyncFindings.clearSession(event.session_id);
	// Pair the trajectory.json archive with live-snapshot deletion —
	// once the session is permanently archived, the live snapshot is
	// noise that would otherwise be picked up by the startup sweep.
	deleteLiveSnapshot(ctx.cwd, event.session_id);
	ctx.classifierSessions.delete(event.session_id);
	ctx.autoCoordStates.delete(event.session_id);
}
