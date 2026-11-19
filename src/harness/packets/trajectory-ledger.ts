// Instruction packets — window ledger, delivery queue and the Stop/SessionEnd entry (design §7).
//
// `runWindowEvaluation` is what the daemon calls at Stop (turn window) and at
// SessionEnd (session window), and what `packets replay-windows` calls per
// turn: it reads the two local logs as bounded tails, builds the window,
// judges it (trajectory.ts), appends every row to `packet-window-judgments.jsonl`
// and queues the ELIGIBLE rows. Stop warnings reach no agent on most runners,
// so delivery happens on the session's NEXT PostToolUse (`drainWindowWarnings`,
// called from server/packets-phase.ts): the drained rows are appended again
// with `shown: true` under the same judgment id, and the newest row wins when
// the ledger is read. Replay never queues. Nothing here throws into a hook.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardRulesConfig } from "../types.js";
import { enabledPacketsConfig, loadPacketFile } from "./evaluator.js";
import { fallbackLine } from "./fallback.js";
import { deliveredIds } from "./fallback-ledger.js";
import { statusRank } from "./schema.js";
import { evaluateWindow, type TrajectoryDeps, WINDOW_LEDGER, type WindowJudgmentRow } from "./trajectory.js";
import { PACKET_FILE_BASENAME, type PacketFile } from "./types.js";
import type { WindowDigest } from "./window.js";
import { readCollectionCalls, readTimelineRows, sessionWindow, turnWindows } from "./window-source.js";

const DEFAULT_WINDOW_TAIL_MB = 32;

const WINDOW_PENDING = "packet-window-pending.jsonl";
let ledgerErrors = 0;

/** Test seam (the queue and the delivery ledger live on disk; this only resets the error counter). */
export function resetWindowQueue(): void {
	ledgerErrors = 0;
}

function appendWindowRows(cwd: string, rows: readonly WindowJudgmentRow[]): void {
	if (rows.length === 0) return;
	try {
		appendFileSync(join(cwd, ".interlinked", WINDOW_LEDGER), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
	} catch {
		ledgerErrors++; // a ledger gap beats a daemon crash
	}
}

function pendingPath(cwd: string): string {
	return join(cwd, ".interlinked", WINDOW_PENDING);
}

function readPending(cwd: string): WindowJudgmentRow[] {
	const path = pendingPath(cwd);
	if (!existsSync(path)) return [];
	const out: WindowJudgmentRow[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line) as WindowJudgmentRow);
		} catch {
			ledgerErrors++;
		}
	}
	return out;
}

function writePending(cwd: string, rows: readonly WindowJudgmentRow[]): void {
	const path = pendingPath(cwd);
	try {
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
		renameSync(tmp, path);
	} catch {
		ledgerErrors++;
	}
}

/** Hold eligible live rows ON DISK (they survive a daemon restart) until a delivery point drains them. */
export function queueWindowWarnings(cwd: string, sessionId: string, rows: readonly WindowJudgmentRow[]): void {
	const eligible = rows.filter((r) => r.eligible && r.warning !== null && r.source === "live" && r.session_id === sessionId);
	if (eligible.length === 0) return;
	try {
		appendFileSync(pendingPath(cwd), eligible.map((r) => `${JSON.stringify(r)}\n`).join(""));
	} catch {
		ledgerErrors++;
	}
}

function deliver(cwd: string, rows: readonly WindowJudgmentRow[]): string[] {
	const shown = rows.map((r) => ({ ...r, shown: true, ts: new Date().toISOString() }));
	// A fallback line is delivered but is not a judgment: it never enters the ledger.
	appendWindowRows(cwd, shown.filter((r) => r.fallback !== true));
	return shown.map((r) => r.warning as string);
}


/** Why a window evaluation says the packet set is not live right now, or null. */
function windowNonLiveReason(rows: readonly WindowJudgmentRow[]): string | null {
	if (rows.some((r) => r.gate === "spend_cap")) return "spend cap reached this daemon run";
	if (rows.some((r) => r.gate === "ask_failed")) return "Jev unreachable";
	const forced = rows.find((r) => r.status_effective === "shadow" && statusRank(r.status) >= statusRank("warn"));
	return forced ? `judged at shadow: calibration binding does not match this evaluator (model ${forced.model ?? "?"})` : null;
}

/** §9 for window packets (R41): when a window evaluation hits the cap or an outage, queue the released text of
 *  every released packet for the session's next delivery point, once per session. Rides the pending queue as
 *  `fallback` rows so a daemon restart cannot lose it. */
function queueReleasedFallback(cwd: string, sessionId: string, rows: readonly WindowJudgmentRow[], file: PacketFile): void {
	const template = rows[0];
	const reason = windowNonLiveReason(rows);
	// Replay never queues; a SESSION window ends the session, so nobody is left to receive it (its successor gets
	// the words at its own SessionStart).
	if (!template || template.source !== "live" || template.window.kind !== "turn" || reason === null) return;
	// Skip what the session already received (recorded by the hook after encoding) and what is already queued.
	const received = deliveredIds(join(cwd, ".interlinked"), sessionId);
	const queued = new Set(readPending(cwd).filter((r) => r.fallback === true && r.session_id === sessionId).map((r) => r.packet));
	const released = file.packets.filter((p) => p.release !== null && !received.has(p.id) && !queued.has(p.id));
	if (released.length === 0) return;
	const lines: WindowJudgmentRow[] = released.map((p) => ({ ...template, packet: p.id, packet_hash: p.packet_hash, eligible: false, shown: false, p: null, gate: null, error: null, warning: fallbackLine(p, reason), fallback: true }));
	try {
		appendFileSync(pendingPath(cwd), lines.map((r) => `${JSON.stringify(r)}\n`).join(""));
	} catch {
		ledgerErrors++;
	}
}

/** Deliver this session's TURN findings on its next PostToolUse; record each as shown under the same id. */
export function drainWindowWarnings(cwd: string, sessionId: string): string[] {
	const pending = readPending(cwd);
	const mine = pending.filter((r) => r.session_id === sessionId && r.window.kind === "turn");
	if (mine.length === 0) return [];
	writePending(cwd, pending.filter((r) => !(r.session_id === sessionId && r.window.kind === "turn")));
	return deliver(cwd, mine);
}

/** Deliver SESSION-window findings (from any ended session) to the session that starts next in this project. */
export function drainWindowWarningsForStart(cwd: string): string[] {
	const pending = readPending(cwd);
	const sessionFindings = pending.filter((r) => r.window.kind === "session");
	if (sessionFindings.length === 0) return [];
	writePending(cwd, pending.filter((r) => r.window.kind !== "session"));
	return deliver(cwd, sessionFindings).map((w, i) => `${w}\n  ↳ from session ${sessionFindings[i]?.session_id.slice(0, 8)} (ended)`);
}

export interface RunWindowOptions {
	cwd: string;
	sessionId: string;
	kind: WindowDigest["kind"];
	/** The event's `agent_source` (legacy client id) or an adapter id. */
	runnerSource: string;
	rules: GuardRulesConfig;
	deps?: TrajectoryDeps;
	/** Replay may hand in a prebuilt window instead of reading the logs. */
	window?: WindowDigest;
}

async function windowFromLogs(cwd: string, sessionId: string, kind: WindowDigest["kind"], tailMb: number): Promise<WindowDigest | null> {
	const bytes = tailMb * 1024 * 1024;
	const calls = await readCollectionCalls(join(cwd, ".interlinked", "collection.jsonl"), bytes, sessionId);
	const timeline = await readTimelineRows(join(cwd, ".interlinked", "timeline.jsonl"), bytes, sessionId);
	if (kind === "session") return sessionWindow(sessionId, calls, timeline);
	const turns = turnWindows(sessionId, calls, timeline);
	return turns[turns.length - 1] ?? null;
}

/** Build, judge, record and (live) queue one window. Never rejects. */
export async function runWindowEvaluation(opts: RunWindowOptions): Promise<WindowJudgmentRow[]> {
	try {
		const config = enabledPacketsConfig(opts.rules);
		if (!config) return [];
		const path = join(opts.cwd, ".interlinked", PACKET_FILE_BASENAME);
		if (!existsSync(path)) return [];
		const loaded = loadPacketFile(opts.cwd, path);
		if (!loaded.ok) return [];
		const window = opts.window ?? (await windowFromLogs(opts.cwd, opts.sessionId, opts.kind, config.window_tail_mb ?? DEFAULT_WINDOW_TAIL_MB));
		if (!window) return [];
		const rows = await evaluateWindow(window, loaded.file, config, opts.runnerSource, opts.deps ?? {});
		appendWindowRows(opts.cwd, rows);
		queueWindowWarnings(opts.cwd, opts.sessionId, rows);
		queueReleasedFallback(opts.cwd, opts.sessionId, rows, loaded.file);
		return rows;
	} catch {
		return [];
	}
}

/** Hook-path entry for Stop / SessionEnd: fire and forget. */
export function scheduleWindowEvaluation(opts: RunWindowOptions): void {
	if (!enabledPacketsConfig(opts.rules)) return;
	setImmediate(() => {
		void runWindowEvaluation(opts);
	});
}
