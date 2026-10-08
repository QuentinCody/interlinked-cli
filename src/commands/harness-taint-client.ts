// ===========================================
// CLI → daemon taint control, with a snapshot fallback
// ===========================================
//
// The daemon's in-memory level is what governs the tool calls happening right
// now, so it is asked first — over the same raw control channel
// `queryHookCoverage` uses. When no daemon answers (stopped, or a build that
// predates this command and therefore returns an empty allow), the live
// snapshot file is the authoritative carrier instead: it is what the next
// resume hydrates, which is exactly the state an operator needs to fix.
//
// Both paths return the SAME `TaintControlReport`, built by the same shared
// core, so the renderer cannot describe them differently.

import { loadRules } from "../harness/rules-loader.js";
import {
	isTaintControlReport,
	TAINT_CONTROL_EVENT,
	type TaintControlReport,
	type TaintControlRequest,
	unknownSessionReport,
} from "../harness/taint-control.js";
import {
	clearTaintInSnapshot,
	listTaintedSnapshotViews,
	readTaintSnapshotView,
} from "../harness/taint-snapshot.js";
import type { TaintTrackingConfig } from "../harness/types.js";
import { queryHarness } from "./harness-status-helpers.js";

/** Control queries are cheap in the daemon (no pipeline, no disk scan), so a
 *  short timeout is enough and keeps a wedged daemon from hanging the CLI. */
const TAINT_CONTROL_TIMEOUT_MS = 3_000;

export interface TaintClientDeps {
	cwd: string;
	/** One control round-trip. Resolves null when nothing answered with a
	 *  parseable taint report. */
	query: (request: TaintControlRequest) => Promise<TaintControlReport | null>;
	config: () => TaintTrackingConfig;
}

async function queryDaemon(
	cwd: string,
	request: TaintControlRequest,
): Promise<TaintControlReport | null> {
	const raw = await queryHarness(
		cwd,
		{ hook_event: TAINT_CONTROL_EVENT, request },
		TAINT_CONTROL_TIMEOUT_MS,
	);
	if (typeof raw?.additional_context !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.additional_context);
	} catch {
		return null;
	}
	return isTaintControlReport(parsed) ? parsed : null;
}

export function taintClientDeps(cwd: string = process.cwd()): TaintClientDeps {
	return {
		cwd,
		query: (request) => queryDaemon(cwd, request),
		config: () => loadRules(cwd).taint_tracking,
	};
}

export type TaintResolutionSource = "daemon" | "snapshot";

export interface TaintResolution {
	report: TaintControlReport;
	via: TaintResolutionSource;
}

function snapshotStatus(deps: TaintClientDeps, sessionId: string | undefined): TaintControlReport {
	const config = deps.config();
	if (sessionId === undefined) {
		return { ok: true, sessions: listTaintedSnapshotViews(deps.cwd, config) };
	}
	const view = readTaintSnapshotView(deps.cwd, sessionId, config);
	return view ? { ok: true, session: view } : unknownSessionReport(sessionId);
}

export async function resolveTaintStatus(
	deps: TaintClientDeps,
	sessionId: string | undefined,
): Promise<TaintResolution> {
	const request: TaintControlRequest =
		sessionId === undefined
			? { operation: "status" }
			: { operation: "status", session_id: sessionId };
	const fromDaemon = await deps.query(request);
	if (fromDaemon) return { report: fromDaemon, via: "daemon" };
	return { report: snapshotStatus(deps, sessionId), via: "snapshot" };
}

/** One clear request. A struct, not two adjacent strings, so a swapped call
 *  cannot record the reason as the session id. */
export interface TaintClearArgs {
	sessionId: string;
	reason: string;
	/** Clear ONE actor's level (B3) instead of the whole session. Needs a live
	 *  daemon: the lineage lives in its memory. */
	actor?: string | undefined;
}

function snapshotClear(deps: TaintClientDeps, args: TaintClearArgs): TaintControlReport {
	const { sessionId, reason } = args;
	if (args.actor !== undefined) {
		return {
			ok: false,
			reason:
				"--actor needs a running daemon: per-actor levels live in daemon memory, not in the live snapshot. Start the daemon, or clear the whole session.",
		};
	}
	const config = deps.config();
	const cleared = clearTaintInSnapshot(deps.cwd, sessionId, config, reason);
	if (!cleared.ok) {
		const exists = readTaintSnapshotView(deps.cwd, sessionId, config) !== null;
		return exists ? { ok: false, reason: cleared.reason } : unknownSessionReport(sessionId);
	}
	const view = readTaintSnapshotView(deps.cwd, sessionId, config);
	return {
		ok: true,
		cleared: { ...cleared.outcome, applied_to: ["live-snapshot"] },
		...(view ? { session: view } : {}),
	};
}

/** Clear through the daemon when one answers — it owns the in-memory level and
 *  persists the snapshot itself, so the CLI must not write a second time. */
export async function resolveTaintClear(
	deps: TaintClientDeps,
	args: TaintClearArgs,
): Promise<TaintResolution> {
	const fromDaemon = await deps.query({
		operation: "clear",
		session_id: args.sessionId,
		reason: args.reason,
		...(args.actor === undefined ? {} : { actor: args.actor }),
	});
	if (fromDaemon) return { report: fromDaemon, via: "daemon" };
	return { report: snapshotClear(deps, args), via: "snapshot" };
}
