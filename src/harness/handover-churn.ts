// ===========================================
// Handover churn backstop — bounded restart loops
// ===========================================
// Root cause (2026-08-22 postmortem): a build-refresh handover, an
// rss-ceiling recycle, and an explicit `interlinked harness restart` can all
// target the SAME repo within seconds of each other — the build-refresh
// watcher spawns `harness restart`, which unconditionally SIGTERMs every
// daemon pid file it discovers (`stopAllDaemons`, "unlike a reaper this MAY
// stop a serving daemon") before checking whether a DIFFERENT trigger's
// successor is still mid-boot. A successor that has written its pid file but
// not yet reached `listening` looks identical to a stale orphan, so the next
// trigger kills it too — five daemons died pre-listening in nine minutes on
// 2026-08-22 this way, each contributing a `handover` ledger row with no
// matching `listening` row.
//
// The primary fix (see startup-lock.ts's heartbeat + harness-lifecycle-
// helpers.ts's `resolveRestartAction`) makes a restart trigger DEFER to an
// in-flight start instead of killing it. This module is the required
// BACKSTOP for whatever the primary fix misses: no caller may keep spawning
// successors forever. Automatic build-refresh and the explicit-restart path
// in harness-lifecycle-helpers.ts consult `handoverChurnExceeded` before
// spawning. RSS pressure does not spawn a successor: it stops first so the old
// and new heaps never overlap, and recovery falls to the hook's cold-fallback
// self-heal. Past the threshold, handover callers back off — recording a
// `churn-backstop` row so the postmortem self-explains — and recovery remains
// available through the cold path or `interlinked harness start`.

import { randomUUID } from "node:crypto";
import { type DaemonLedgerEvent, type DaemonLedgerRow, recordDaemonEvent } from "./daemon-ledger.js";

/** Unresolved handovers inside the window before a caller backs off. */
export const HANDOVER_CHURN_MAX_ATTEMPTS = 4;
/** Rolling window the backstop counts over. */
export const HANDOVER_CHURN_WINDOW_MS = 10 * 60_000;

/** Env var carrying a handover attempt id to the spawned successor. Node's
 *  `spawn` inherits env by default, so setting it on the `harness restart`
 *  child threads it through start → daemon, where the startup guard stamps it
 *  on the `listening` row (and deletes it from the daemon's own env so a
 *  LATER handover spawned by that daemon cannot reuse a stale id). */
export const HANDOVER_ATTEMPT_ENV = "INTERLINKED_HANDOVER_ATTEMPT";

/** Fresh attempt id — short enough to grep, unique enough per window. */
export function newHandoverAttemptId(): string {
	return randomUUID().slice(0, 8);
}

// The id this PROCESS consumed from its real env — kept so late writers (the
// anti-stomp loser exit, which fires after the startup guard already cleared
// the env) can still stamp their rows. Never set from an injected test env.
let consumedFromProcessEnv: string | undefined;

/** Read AND clear the inherited attempt id. Clearing matters: the daemon's
 *  own later handover spawns copy `process.env`, and a stale id surviving
 *  there would make an unrelated future `listening` row acknowledge the
 *  wrong attempt. Empty string normalizes to undefined. */
export function consumeHandoverAttemptEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const id = env[HANDOVER_ATTEMPT_ENV];
	if (id !== undefined) delete env[HANDOVER_ATTEMPT_ENV];
	const normalized = id === undefined || id === "" ? undefined : id;
	if (env === process.env && normalized !== undefined) consumedFromProcessEnv = normalized;
	return normalized;
}

/** The attempt id this process serves: the still-pending env value, or the
 *  one already consumed from the real env. For late writers (anti-stomp
 *  exit) that run after the startup guard cleared the env. */
export function currentProcessAttemptId(): string | undefined {
	const pending = process.env[HANDOVER_ATTEMPT_ENV];
	if (pending !== undefined && pending !== "") return pending;
	return consumedFromProcessEnv;
}

/** Terminal outcomes a launcher/start path may stamp on the inherited
 *  attempt; `daemon_spawned` is the one non-terminal (counting) value. */
type InheritedSpawnOutcome = "daemon_spawned" | "spawn_failed" | "refused" | "no_artifact" | "start_failed";

// Idempotence for terminal rows: every early-return path calls the helper,
// and a path can be reached twice in one process (retry loops); one terminal
// row per (id, outcome) is enough for the reducer and keeps the ledger legible.
const terminalizedAttempts = new Set<string>();

/** True exactly once per (id, terminal outcome) in this process; the
 *  counting `daemon_spawned` step never dedupes. */
function shouldWriteAttemptRow(id: string, outcome: InheritedSpawnOutcome): boolean {
	if (outcome === "daemon_spawned") return true;
	const key = `${id}:${outcome}`;
	if (terminalizedAttempts.has(key)) return false;
	terminalizedAttempts.add(key);
	return true;
}

/** Record one step of an id-carrying attempt from the restart CLI / start
 *  paths (which must NOT clear the env var — the daemon consumes it). Writes
 *  the COUNTING `daemon_spawned` row, or a TERMINAL row (`spawn_failed` /
 *  `refused` / `no_artifact` / `start_failed`) that resolves the attempt in
 *  the churn reducer; a no-op without an inherited id (a plain manual
 *  `harness start` stays id-less). Terminal writes are idempotent per
 *  (id, outcome) within one process. */
export function recordInheritedDaemonSpawn(
	cwd: string,
	outcome: InheritedSpawnOutcome,
	detail?: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const id = env[HANDOVER_ATTEMPT_ENV];
	if (id === undefined || id === "") return;
	if (!shouldWriteAttemptRow(id, outcome)) return;
	recordDaemonEvent(cwd, {
		at: Date.now(),
		pid: process.pid,
		event: "handover",
		reason: "daemon-start",
		outcome,
		attempt_id: id,
		...(detail !== undefined ? { detail } : {}),
	});
}

/** Handover reasons that are AUDIT facts, never daemon attempts. Counting
 *  churn-backstop refusals made the backstop feed itself (2026-08-25 outage);
 *  counting the restart CLI's explicit-restart/explicit-stop/deferral rows
 *  made every SUCCESSFUL automatic handover read as unresolved (review
 *  2026-08-29 — the chain writes them between launcher and listening). */
const AUDIT_ONLY_REASONS = new Set([
	"churn-backstop",
	"explicit-stop",
	"explicit-restart",
	"deferred-to-inflight",
	"deferred-timeout",
]);

/** Outcomes that RESOLVE an attempt: nobody is coming, and the ledger says
 *  so — the attempt must stop counting exactly like a listening ack. */
const TERMINAL_ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
	"refused",
	"spawn_failed",
	"no_artifact",
	"start_failed",
]);

/** True when `e` is a handover row that COUNTS as an unresolved attempt:
 *  legacy rows (no `outcome`, non-audit reason) were only written around a
 *  spawn, so they count; typed rows count ONLY at `daemon_spawned` — a
 *  launched restart CLI (`launcher_spawned`) is not yet a daemon attempt,
 *  and requested/terminal outcomes never had a successor to wait for. */
function isCountingAttempt(e: DaemonLedgerRow): boolean {
	if (e.event !== "handover" || AUDIT_ONLY_REASONS.has(e.reason ?? "")) return false;
	// Ledger rows come from disk and may carry the
	// short-lived legacy outcome "spawned" (written by 2026-08-29 pre-rename
	// daemons during a rolling upgrade). It meant "successor launched" under
	// the OLD one-process model, so it COUNTS like daemon_spawned; new code
	// never writes it.
	const outcome: string | undefined = e.outcome;
	return outcome === undefined || outcome === "daemon_spawned" || outcome === "spawned";
}

/** In-flight for COALESCING: counting attempts plus `launcher_spawned` rows —
 *  a launched restart CLI is already working toward a daemon, so a second
 *  launch for the same artifact must wait for its resolution. */
function isInFlightAttempt(e: DaemonLedgerRow): boolean {
	return isCountingAttempt(e) || (e.event === "handover" && e.outcome === "launcher_spawned");
}

/** Attempt ids RESOLVED anywhere in the given rows: a `listening` ack, a
 *  handover row with a terminal outcome, or an `exit` row carrying the id
 *  (the startup guard stamps it on a startup-failed exit). */
function resolvedAttemptIds(rows: readonly DaemonLedgerRow[]): Set<string> {
	const resolved = new Set<string>();
	for (const e of rows) {
		if (e.attempt_id === undefined) continue;
		if (e.event === "listening" || e.event === "exit") resolved.add(e.attempt_id);
		else if (e.event === "handover" && e.outcome !== undefined && TERMINAL_ATTEMPT_OUTCOMES.has(e.outcome))
			resolved.add(e.attempt_id);
	}
	return resolved;
}

/** The rows inside `[nowMs - windowMs, nowMs]`, ledger order preserved. */
function rowsInWindow(
	events: readonly DaemonLedgerRow[],
	nowMs: number,
	windowMs: number,
): DaemonLedgerRow[] {
	const windowStart = nowMs - windowMs;
	return events.filter((e) => e.at >= windowStart && e.at <= nowMs);
}

/** One counting attempt with an id: skip if acknowledged (order-independent)
 *  or already counted (a duplicated row must not double-count). */
function countsAsPending(
	e: DaemonLedgerRow,
	acknowledged: ReadonlySet<string>,
	counted: Set<string>,
): boolean {
	if (e.attempt_id === undefined) return true;
	if (acknowledged.has(e.attempt_id) || counted.has(e.attempt_id)) return false;
	counted.add(e.attempt_id);
	return true;
}

/**
 * Unresolved handovers in the trailing window.
 *
 * Attempt-ID protocol (2026-08-29): a `spawned` row carrying an `attempt_id`
 * is resolved by a `listening` row acknowledging that SAME id anywhere in the
 * window — ordering between the two rows is irrelevant, which closes the
 * reproduced fast-successor race (the successor's `listening` landing before
 * the parent's counting row read a SUCCESSFUL restart as one unresolved
 * attempt; enough of those tripped the backstop and locked out real
 * restarts). A duplicated `spawned` row for the same id counts once.
 *
 * Legacy fallback: rows without ids keep the chronological pairing — an
 * id-less `listening` pays off only attempts that PRECEDE it (review
 * 2026-08-28 finding 3: plain subtraction let an old healthy start cancel a
 * LATER failed handover). An id-carrying `listening` never pays off a legacy
 * attempt; it already resolved its own. Expiry is the window itself: an
 * unresolved attempt stops counting once it ages out.
 */
export function netUnresolvedHandovers(
	events: readonly DaemonLedgerRow[],
	nowMs: number,
	windowMs: number = HANDOVER_CHURN_WINDOW_MS,
): number {
	const inWindow = rowsInWindow(events, nowMs, windowMs);
	const acknowledged = resolvedAttemptIds(inWindow);
	const counted = new Set<string>();
	let pending = 0;
	for (const e of inWindow) {
		if (isCountingAttempt(e)) {
			if (countsAsPending(e, acknowledged, counted)) pending++;
		} else if (e.event === "listening" && e.attempt_id === undefined && pending > 0) {
			// A manual/legacy start reaching listening means a daemon IS serving:
			// it pays off one preceding unresolved attempt, whichever kind.
			pending--;
		}
	}
	return pending;
}

/** True when a counting attempt with this exact `detail` (the build-artifact
 *  stamp) is still unresolved in the window — the coalescing check that stops
 *  a second successor being spawned for the SAME rebuild while the first is
 *  mid-boot. */
export function unresolvedAttemptExistsFor(
	events: readonly DaemonLedgerRow[],
	nowMs: number,
	detail: string,
	windowMs: number = HANDOVER_CHURN_WINDOW_MS,
): boolean {
	const inWindow = rowsInWindow(events, nowMs, windowMs);
	const resolved = resolvedAttemptIds(inWindow);
	return inWindow.some(
		(e) =>
			isInFlightAttempt(e) &&
			e.detail === detail &&
			(e.attempt_id === undefined || !resolved.has(e.attempt_id)),
	);
}

/** True once the backstop should refuse another automatic handover attempt. */
export function handoverChurnExceeded(
	events: readonly DaemonLedgerRow[],
	nowMs: number,
	maxAttempts: number = HANDOVER_CHURN_MAX_ATTEMPTS,
	windowMs: number = HANDOVER_CHURN_WINDOW_MS,
): boolean {
	return netUnresolvedHandovers(events, nowMs, windowMs) >= maxAttempts;
}

/** The ledger row every backstop trip records, so the next postmortem reads
 *  the defense acting instead of a silent gap. `detail` names which trigger
 *  backed off. */
export function churnBackstopEvent(pid: number, nowMs: number, detail: string): DaemonLedgerEvent {
	return { at: nowMs, pid, event: "handover", reason: "churn-backstop", detail };
}
