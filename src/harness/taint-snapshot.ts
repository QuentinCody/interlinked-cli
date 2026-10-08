// ===========================================
// Taint state in the live snapshot file
// ===========================================
//
// The daemon rewrites `.interlinked/sessions/<id>.live.json` after every event
// and re-hydrates it when a session resumes, so the snapshot — not the daemon's
// memory — is what makes a sensitivity level outlive the process that set it.
// An operator clear that only touched memory would be undone by the next
// resume, and a clear issued while no daemon is running has nowhere else to go.
//
// Reads go through the snapshot codec's own field readers, so this surface and
// `SessionTracker.hydrate` agree on what a stored level and source list mean.
// Writes go through `writeLiveSnapshot` (temp + rename), so a crash mid-clear
// can never leave a half-written snapshot for the next hydrate to parse.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { liveSnapshotPath, readLiveSnapshot, writeLiveSnapshot } from "./live-snapshot.js";
import { readSensitivity, readTaintSources } from "./session-snapshot-codec.js";
import {
	buildTaintView,
	finiteOrNull,
	operatorClearSource,
	type TaintClearOutcome,
	type TaintSessionView,
} from "./taint-control.js";
import type { SensitivityLevel, TaintSource, TaintTrackingConfig } from "./types.js";

const LIVE_SUFFIX = ".live.json";

/** Cap on `listTaintedSnapshotViews` — a repo accumulates snapshots for every
 *  session it has ever run, and the operator only needs the tainted ones. */
const MAX_LISTED_SNAPSHOTS = 25;

/** One session's taint facts as the snapshot file stores them. */
export interface SnapshotTaint {
	session_id: string;
	agent_name: string | null;
	level: SensitivityLevel;
	step_limit: number | null;
	sources: TaintSource[];
	tool_call_count: number;
}

function readSnapshotTaint(snapshot: JsonObject, fallbackId: string): SnapshotTaint {
	const id = typeof snapshot.session_id === "string" ? snapshot.session_id : fallbackId;
	const agent = typeof snapshot.agent_name === "string" ? snapshot.agent_name : null;
	const limit = typeof snapshot.step_limit === "number" ? finiteOrNull(snapshot.step_limit) : null;
	const steps = typeof snapshot.tool_call_count === "number" ? snapshot.tool_call_count : 0;
	return {
		session_id: id,
		agent_name: agent,
		level: readSensitivity(snapshot.sensitivity_level),
		step_limit: limit,
		sources: readTaintSources(snapshot.taint_sources),
		tool_call_count: steps,
	};
}

function viewOf(taint: SnapshotTaint, config: TaintTrackingConfig): TaintSessionView {
	return buildTaintView({
		session_id: taint.session_id,
		agent_name: taint.agent_name,
		sensitivity_level: taint.level,
		step_limit: taint.step_limit,
		sources: taint.sources,
		config,
		origin: "live-snapshot",
	});
}

/** The taint state the NEXT resume of this session would hydrate, or null when
 *  no snapshot exists (or the session id cannot be sanitized to a path). */
export function readTaintSnapshotView(
	cwd: string,
	sessionId: string,
	config: TaintTrackingConfig,
): TaintSessionView | null {
	const snapshot = readLiveSnapshot(cwd, sessionId);
	if (!snapshot) return null;
	return viewOf(readSnapshotTaint(snapshot, sessionId), config);
}

/** Every live snapshot whose stored level is above Public, in directory order,
 *  capped. Used by `taint status` with no `--session`. */
export function listTaintedSnapshotViews(
	cwd: string,
	config: TaintTrackingConfig,
	limit: number = MAX_LISTED_SNAPSHOTS,
): TaintSessionView[] {
	const dir = join(cwd, ".interlinked", "sessions");
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const views: TaintSessionView[] = [];
	for (const name of entries) {
		if (!name.endsWith(LIVE_SUFFIX) || views.length >= limit) continue;
		const view = readTaintSnapshotView(cwd, name.slice(0, -LIVE_SUFFIX.length), config);
		if (view && view.sensitivity_level !== "Public") views.push(view);
	}
	return views;
}

export type SnapshotClearResult =
	| { ok: true; outcome: Omit<TaintClearOutcome, "applied_to">; path: string }
	| { ok: false; reason: string };

/** The next snapshot content for a cleared session: Public, the configured
 *  Public step limit, and the clear marker appended to an untouched history. */
function clearedSnapshot(
	snapshot: JsonObject,
	taint: SnapshotTaint,
	reason: string,
	publicLimit: number | null,
): JsonObject {
	return {
		...snapshot,
		sensitivity_level: "Public",
		step_limit: publicLimit,
		taint_sources: [...taint.sources, operatorClearSource(reason, taint.tool_call_count)],
	};
}

/**
 * Lower a stored level to Public in the snapshot file, reset `step_limit` from
 * config and append the operator-clear marker, atomically.
 *
 * Refuses an absent snapshot and an already-Public one: both mean there is no
 * ratchet to clear, and writing anyway would mint a misleading audit row.
 */
export function clearTaintInSnapshot(
	cwd: string,
	sessionId: string,
	config: TaintTrackingConfig,
	reason: string,
): SnapshotClearResult {
	const target = liveSnapshotPath(cwd, sessionId);
	const snapshot = readLiveSnapshot(cwd, sessionId);
	if (!target || !snapshot) {
		return { ok: false, reason: `No live snapshot for session ${sessionId}` };
	}
	const taint = readSnapshotTaint(snapshot, sessionId);
	if (taint.level === "Public") {
		return { ok: false, reason: `Session ${sessionId} is already Public in its live snapshot` };
	}
	const setter = viewOf(taint, config).set_by;
	const publicLimit = finiteOrNull(config.step_limits.Public);
	const written = writeLiveSnapshot(
		cwd,
		sessionId,
		clearedSnapshot(snapshot, taint, reason, publicLimit),
	);
	if (!written.ok) return { ok: false, reason: written.error.message };
	const outcome: Omit<TaintClearOutcome, "applied_to"> = {
		session_id: taint.session_id,
		previous_level: taint.level,
		previous_step_limit: taint.step_limit,
		new_level: "Public",
		new_step_limit: publicLimit,
		set_by: setter?.file ?? "unknown",
		set_by_inferred: setter?.inferred ?? false,
		reason,
	};
	return { ok: true, path: target, outcome };
}
