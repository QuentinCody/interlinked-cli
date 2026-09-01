// ===========================================
// Daemon lifecycle ledger — every exit self-documents
// ===========================================
// Over one session (2026-07-28) the daemon "went down" a dozen times with FOUR
// distinct causes — build-refresh handovers after any rebuild of the shared
// dist (including rebuilds triggered from OTHER guarded repos via `interlinked
// reload`), memory hangs on a swap-bound machine, orphan accumulation, and the
// RSS-ceiling recycle — and every one presented to the agent as the same
// opaque symptom: "BLOCKED: pid present, no live daemon". Hours went into
// re-diagnosing (and misattributing) each occurrence, because nothing recorded
// WHY the previous daemon left.
//
// This ledger is that record. Daemons append one row on start, hand-over
// intent, and exit (with reason + RSS + uptime); the cold-block message and
// `harness status` read the tail so an outage explains itself: "handed over to
// a newer build 4s ago — normal after a rebuild" is actionable in a way
// "unreachable" never was.
//
// Design constraints, in order: NEVER throw (the guard must not die of its own
// diary); bounded reads (tail only); extensible (a new exit reason is just a
// new string — readers print unknown reasons verbatim).

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readRecentLines } from "../lib/local-activity-collection.js";

/** Known reasons; readers must handle unknown strings (forward compatibility). */
export type DaemonEventKind = "start" | "listening" | "handover" | "exit" | "spike" | "emergency-gc";

/** Typed handover-attempt outcomes (attempt-ID protocol, 2026-08-29).
 *  The cross-process chain is requested → launcher_spawned (the restart CLI
 *  was launched — NOT yet a daemon attempt) → daemon_spawned (the ONLY
 *  outcome the churn backstop counts as unresolved) → the successor's
 *  `listening` row. Terminal outcomes (`refused` / `spawn_failed` /
 *  `no_artifact` / `start_failed`) RESOLVE the attempt like a listening ack.
 *  Expiry is derived, not written: an unresolved `daemon_spawned` row ages
 *  out of the churn window rather than getting its own row. */
export type HandoverOutcome =
	| "requested"
	| "launcher_spawned"
	| "daemon_spawned"
	| "refused"
	| "spawn_failed"
	| "no_artifact"
	| "start_failed";

export interface DaemonLedgerEvent {
	/** Epoch ms. */
	at: number;
	pid: number;
	event: DaemonEventKind;
	/** e.g. "signal" | "idle-timeout" | "rss-ceiling" | "build-refresh" | "crash". */
	reason?: string;
	detail?: string;
	rss_mb?: number;
	/** V8 heap in use — JS objects (caches, ASTs, parsed structures). */
	heap_mb?: number;
	/** External + ArrayBuffers — Buffers, subprocess output, native allocations.
	 *  The heap/external SPLIT is the first question of any memory diagnosis:
	 *  the 2026-07-28 spikes (0→838MB in 15s, 2.5GB in one 30s window) could not
	 *  be attributed without it. */
	ext_mb?: number;
	uptime_s?: number;
	/** Was this exit INTENDED? Recorded on the row so a diagnosis reads
	 *  straight off `daemon-events.jsonl` instead of re-deriving the taxonomy
	 *  from a reason string every time. See {@link classifyExitReason}. */
	disposition?: ExitDisposition;
	/** Handover attempt id (attempt-ID protocol). On a `handover` row it names
	 *  the attempt; on a `listening` row it ACKNOWLEDGES the attempt that
	 *  spawned this daemon — the pairing key that makes churn counting
	 *  order-independent. Absent on legacy rows and manual starts. */
	attempt_id?: string;
	/** Typed attempt outcome on `handover` rows. Absent on legacy rows, which
	 *  the churn counter treats as `spawned` (they were only written after the
	 *  old counting semantics' spawn). */
	outcome?: HandoverOutcome;
}

/** Planned = someone asked for this exit (a restart, a recycle, a stop).
 *  Unplanned = the daemon lost, and the guard had a gap. Unknown = a reason a
 *  newer daemon writes that this reader has not been taught yet. */
type ExitDisposition = "planned" | "unplanned" | "unknown";

/** Exits the system asked for. `anti-stomp` and `already-running` belong here:
 *  a loser standing down so ONE binder proceeds is the mutex working. */
const PLANNED_EXIT_REASONS = new Set([
	"build-refresh",
	"rss-ceiling",
	"idle-timeout",
	"handover",
	"explicit-stop",
	"explicit-restart",
	"anti-stomp",
	"already-running",
]);

/** Exits nobody asked for. `signal` is here because an UNEXPLAINED SIGTERM is
 *  the storm's signature (a reaper killing a healthy daemon); an intentional
 *  `harness stop` records an `explicit-stop` handover first, which upgrades the
 *  reason before it is classified. */
const UNPLANNED_EXIT_REASONS = new Set(["signal", "oom", "startup-failed", "crash"]);

export function classifyExitReason(reason: string | undefined): ExitDisposition {
	if (reason === undefined) return "unknown";
	if (PLANNED_EXIT_REASONS.has(reason)) return "planned";
	if (UNPLANNED_EXIT_REASONS.has(reason)) return "unplanned";
	return "unknown";
}

const LEDGER_REL = join(".interlinked", "daemon-events.jsonl");
/** Tail bound for reads — ~8KB ≈ the last few dozen lifecycle events. */
const READ_TAIL_BYTES = 8 * 1024;
/** An exit older than this cannot explain a CURRENT outage. */
const EXPLAIN_WINDOW_MS = 5 * 60 * 1000;

function ledgerPath(projectRoot: string): string {
	return join(projectRoot, LEDGER_REL);
}

/** Append one event. Never throws — a diary failure must not harm the daemon. */
export function recordDaemonEvent(projectRoot: string, evt: DaemonLedgerEvent): void {
	try {
		mkdirSync(join(projectRoot, ".interlinked"), { recursive: true });
		appendFileSync(ledgerPath(projectRoot), `${JSON.stringify(evt)}\n`);
	} catch (err) {
		// Deliberately quiet: this can run on the Stop/shutdown path where stderr
		// becomes agent-visible noise, and there is no safer channel left.
		void err;
	}
}

/** Ledger callback for the daemon-timers emergency heap-pressure shrink
 *  (storm postmortem 2026-08-17): a row per firing so the next postmortem
 *  reads the defense acting, not just the deaths. Factory lives HERE because
 *  server.ts is over the line cap and may only shrink. */
export function makeHeapPressureLedger(
	projectRoot: string,
	log: (message: string) => void,
): (usedMb: number, limitMb: number) => void {
	return (usedMb, limitMb) => {
		recordDaemonEvent(projectRoot, {
			at: Date.now(),
			pid: process.pid,
			event: "emergency-gc",
			detail: `heap ${usedMb}MB of ${limitMb}MB limit — shrank caches + forced GC`,
		});
		log(`Emergency GC: heap ${usedMb}MB of ${limitMb}MB limit — shrank caches`);
	};
}

/** Bytes per megabyte, for the memory fields on an exit row. */
const BYTES_PER_MB = 1048576;

/** Append the `exit` row for THIS process, with the memory + uptime context a
 *  post-mortem needs. Split out of server.ts's `shutdownWith` so every exit
 *  path records the same shape — the heap/external split included, which is
 *  the first question of any memory diagnosis. */
export function recordDaemonExit(projectRoot: string, reason: string, startedAtMs: number): void {
	const mem = process.memoryUsage();
	recordDaemonEvent(projectRoot, {
		at: Date.now(),
		pid: process.pid,
		event: "exit",
		reason,
		disposition: classifyExitReason(reason),
		rss_mb: Math.round(mem.rss / BYTES_PER_MB),
		heap_mb: Math.round(mem.heapUsed / BYTES_PER_MB),
		ext_mb: Math.round((mem.external + mem.arrayBuffers) / BYTES_PER_MB),
		uptime_s: Math.round((Date.now() - startedAtMs) / 1000),
	});
}

function parseEventLine(line: string): DaemonLedgerEvent | null {
	try {
		const raw: unknown = JSON.parse(line);
		if (typeof raw !== "object" || raw === null) return null;
		// SAFETY: object-ness checked above; the three required fields are
		// individually type-tested below before the row is trusted.
		const e = raw as Partial<DaemonLedgerEvent>;
		if (typeof e.at !== "number" || typeof e.pid !== "number" || typeof e.event !== "string") return null;
		// SAFETY: at/pid/event verified as number/number/string on the line above.
		return e as DaemonLedgerEvent;
	} catch {
		// A torn final line from a killed daemon is expected, not exceptional.
		return null;
	}
}

/** The newest events, oldest→newest, from a bounded tail read. Never throws. */
export function readRecentDaemonEvents(projectRoot: string): DaemonLedgerEvent[] {
	const path = ledgerPath(projectRoot);
	try {
		// Reverse-tail I/O is bounded BEFORE bytes become a JS string. The old
		// implementation read the whole ever-growing ledger and only then sliced
		// 8KB, defeating this function's memory contract.
		const lines = readRecentLines(path, 10_000, READ_TAIL_BYTES).reverse();
		const out: DaemonLedgerEvent[] = [];
		for (const line of lines) {
			if (line.trim() === "") continue;
			const evt = parseEventLine(line);
			if (evt) out.push(evt);
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * One sentence explaining the most recent RELEVANT exit, or null.
 *
 * Null when there is no exit recent enough to explain a current outage — a
 * wrong explanation is worse than none. A `handover` intent immediately before
 * the exit upgrades a generic "signal" exit into its real cause: the
 * build-refresh watcher hands over by spawning `harness restart`, so the exit
 * itself only ever sees SIGTERM.
 */
export function describeLastExit(events: DaemonLedgerEvent[], nowMs: number): string | null {
	let lastExit: DaemonLedgerEvent | null = null;
	let lastHandover: DaemonLedgerEvent | null = null;
	for (const e of events) {
		if (e.event === "exit") lastExit = e;
		if (e.event === "handover") lastHandover = e;
	}
	if (lastExit === null) return null;
	if (nowMs - lastExit.at > EXPLAIN_WINDOW_MS) return null;

	const ageS = Math.max(0, Math.round((nowMs - lastExit.at) / 1000));
	const handoverExplains =
		lastHandover !== null && lastExit.at >= lastHandover.at && lastExit.at - lastHandover.at < 60_000;
	const reason = handoverExplains ? (lastHandover?.reason ?? "handover") : (lastExit.reason ?? "unknown");
	const rss = lastExit.rss_mb !== undefined ? `, rss ${lastExit.rss_mb}MB` : "";
	const disposition = classifyExitReason(reason);
	const normal =
		disposition === "planned"
			? " — planned exit, not a crash; self-heal brings it back"
			: disposition === "unplanned"
				? " — unplanned"
				: "";
	return `last daemon (pid ${lastExit.pid}) exited ${ageS}s ago: ${reason}${rss}${normal}`;
}

/**
 * One sentence about the most recent event of ANY kind — a `start` counts as
 * much as an `exit`.
 *
 * `describeLastExit` quotes the last EXIT, which lied in the exact case that
 * matters: on 2026-08-15 a Write was refused with "last daemon (pid 50829)
 * exited 276s ago: startup-failed" while a NEWER daemon was answering. The exit
 * was real and stale; the start after it was the news. Callers reporting an
 * outage should quote this, not the exit alone.
 */
export function describeLastLedgerEvent(events: DaemonLedgerEvent[], nowMs: number): string | null {
	const last = events.length > 0 ? events[events.length - 1] : undefined;
	if (last === undefined) return null;
	const ageS = Math.max(0, Math.round((nowMs - last.at) / 1000));
	const reason = last.reason !== undefined ? `: ${last.reason}` : "";
	const disposition =
		last.event === "exit" ? ` (${last.disposition ?? classifyExitReason(last.reason)})` : "";
	return `last ledger event ${ageS}s ago — pid ${last.pid} ${last.event}${reason}${disposition}`;
}
