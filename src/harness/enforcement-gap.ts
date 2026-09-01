// ===========================================
// Enforcement gaps — when the guard was NOT guarding
// ===========================================
// The harness fails OPEN by design: if the daemon is unreachable, edits proceed.
// That is the right default (a dead guard must not brick the repo) and it has a
// silent failure mode — nothing tells the agent that a stretch of work went
// ungated.
//
// Measured cost, this repo:
//   * A 20-agent coverage wave ran ~2h against a daemon that was thrashing
//     itself down (2015 `anti-stomp` exits/2h). The content gate never ran, so
//     type-broken test files landed that it would have refused — and those
//     errors then deadlocked a LATER wave through the repo-wide transient-debt
//     gate. Nothing in the session said "gates were off".
//   * A wedged daemon held the pid file for 9h07m while serving nothing. Every
//     auto-revive politely exited. The symptom the user finally noticed was a
//     statusline reading "harness offline — auto-revive failing"; the ledger had
//     recorded the cause 220 times an hour the whole time.
//
// The ledger already holds the answer. This module reads it and states the gap
// in the one unit that matters to an agent: how long the guard was not running,
// and whether it is still not running.
//
// Pure functions over an event list — no I/O, no clock. The caller supplies
// `nowMs`, which is what makes this testable without fake timers (see
// `timing_flake`).

import type { DaemonLedgerEvent } from "./daemon-ledger.js";

/** A window during which no daemon was serving. */
interface EnforcementGap {
	/** Epoch ms when service stopped. */
	from: number;
	/** Epoch ms when service resumed, or null when still down. */
	to: number | null;
	ms: number;
	/** `thrash` = repeated start/exit with no successful listen (the anti-stomp
	 *  deadlock); `down` = a plain outage. */
	kind: "down" | "thrash";
	/** Distinct exit reasons seen in the window, most frequent first. */
	reasons: string[];
}

/** Gaps shorter than this are ordinary restarts (a rebuild handover lands in a
 *  few seconds) and would be pure noise if reported. */
const MIN_REPORTABLE_MS = 60_000;

/** This many start/exit pairs with no `listening` in between is a deadlock, not
 *  a restart — the auto-revive path is trying and losing every time. */
const THRASH_ATTEMPTS = 5;

/** Count exit reasons within a window, most frequent first. */
function rankReasons(events: DaemonLedgerEvent[]): string[] {
	const counts = new Map<string, number>();
	for (const e of events) {
		if (e.event !== "exit") continue;
		const r = e.reason ?? "unknown";
		counts.set(r, (counts.get(r) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
}

/** An in-progress gap: when it opened and every event seen since. */
interface OpenGap {
	from: number;
	window: DaemonLedgerEvent[];
}

/** Close an open gap into a record, or null when it is too short to matter. */
function sealGap(open: OpenGap, to: number | null, nowMs: number): EnforcementGap | null {
	const { from, window } = open;
	const end = to ?? nowMs;
	const ms = end - from;
	if (ms < MIN_REPORTABLE_MS) return null;
	const attempts = window.filter((e) => e.event === "start").length;
	return {
		from,
		to,
		ms,
		kind: attempts >= THRASH_ATTEMPTS ? "thrash" : "down",
		reasons: rankReasons(window),
	};
}

/**
 * Derive the windows in which no daemon was serving.
 *
 * A gap OPENS at an `exit` (or at a `start` never followed by `listening`) and
 * CLOSES at the next `listening`. Events must be in ascending `at` order, which
 * is how the ledger appends them.
 */
export function detectEnforcementGaps(events: DaemonLedgerEvent[], nowMs: number): EnforcementGap[] {
	// Service resumes when a daemon STARTS AND SURVIVES. `listening` is declared
	// in DaemonEventKind but nothing emits it (measured: 2348 start / 2348 exit /
	// 0 listening in this repo's ledger) — an earlier version of this function
	// closed gaps only on `listening` and therefore could never close one, so it
	// reported a permanent outage on any repo. That is the same defect class this
	// module exists to surface, which is exactly why it must key on an event the
	// ledger actually writes.
	const exitedPids = new Set(events.filter((e) => e.event === "exit").map((e) => e.pid));
	const survives = (e: DaemonLedgerEvent): boolean =>
		(e.event === "start" || e.event === "listening") && !exitedPids.has(e.pid);

	const gaps: EnforcementGap[] = [];
	let open: OpenGap | null = null;

	const close = (to: number | null): void => {
		if (!open) return;
		const g = sealGap(open, to, nowMs);
		if (g) gaps.push(g);
		open = null;
	};

	for (const e of events) {
		if (survives(e)) {
			close(e.at);
			continue;
		}
		if (!open && e.event === "exit") open = { from: e.at, window: [] };
		open?.window.push(e);
	}
	close(null);
	return gaps;
}

function humanMs(ms: number): string {
	const min = Math.round(ms / 60_000);
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	return `${h}h${String(min % 60).padStart(2, "0")}m`;
}

/**
 * One-line warning for the agent, or null when enforcement has been continuous.
 *
 * Deliberately states the CONSEQUENCE ("edits in this window were not gated")
 * rather than the mechanism — an agent reading "daemon exited: anti-stomp" has
 * no way to know that means its own work went unchecked.
 */
export function formatEnforcementGapWarning(gaps: EnforcementGap[], nowMs: number): string | null {
	if (gaps.length === 0) return null;
	const ongoing = gaps.find((g) => g.to === null);
	const total = gaps.reduce((s, g) => s + g.ms, 0);

	if (ongoing) {
		const why = ongoing.kind === "thrash" ? "auto-revive is losing every race (anti-stomp)" : ongoing.reasons[0] ?? "unknown";
		return (
			`[interlinked:enforcement] Gates have been OFF for ${humanMs(nowMs - ongoing.from)} — ${why}. ` +
			"Edits are proceeding UNCHECKED (the guard fails open). " +
			// Do NOT tell every reader to run `harness start`. This warning goes to
			// EVERY actor in the gap at once, and on 2026-08-15 they all followed
			// that advice inside the same second: the concurrent starts raced,
			// reaped the winner, and re-opened the gap for hours. The supervisor
			// restarts one daemon under the startup mutex; patience is the fix.
			"Retry in a few seconds — the daemon supervisor restarts the harness under a startup mutex. " +
			"Do NOT start one by hand; concurrent starts race each other. Only if it is still off after " +
			"30 seconds, run `interlinked harness reap` then `interlinked harness start`."
		);
	}
	return (
		`[interlinked:enforcement] Gates were off for ${humanMs(total)} across ${gaps.length} window(s) this session ` +
		`(${gaps[0]?.reasons.slice(0, 2).join(", ") || "unknown"}). Edits made in those windows were NOT gated — ` +
		"re-run `interlinked verify` if they touched source."
	);
}
