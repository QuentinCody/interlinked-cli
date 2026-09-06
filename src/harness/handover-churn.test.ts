import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonLedgerEvent, HandoverOutcome } from "./daemon-ledger.js";
import {
	HANDOVER_ATTEMPT_ENV,
	HANDOVER_CHURN_MAX_ATTEMPTS,
	HANDOVER_CHURN_WINDOW_MS,
	churnBackstopEvent,
	consumeHandoverAttemptEnv,
	currentProcessAttemptId,
	handoverChurnExceeded,
	netUnresolvedHandovers,
	newHandoverAttemptId,
	recordInheritedDaemonSpawn,
	unresolvedAttemptExistsFor,
} from "./handover-churn.js";

function handover(at: number, reason = "build-refresh"): DaemonLedgerEvent {
	return { at, pid: 1, event: "handover", reason };
}

function listening(at: number): DaemonLedgerEvent {
	return { at, pid: 2, event: "listening" };
}

/** The COUNTING row of the cross-process chain: the restart CLI actually
 *  spawned a daemon for this attempt. */
function spawned(at: number, attemptId: string, detail?: string): DaemonLedgerEvent {
	return {
		at,
		pid: 1,
		event: "handover",
		reason: "daemon-start",
		outcome: "daemon_spawned",
		attempt_id: attemptId,
		...(detail !== undefined ? { detail } : {}),
	};
}

function ack(at: number, attemptId: string): DaemonLedgerEvent {
	return { at, pid: 2, event: "listening", attempt_id: attemptId };
}

function typedRow(at: number, outcome: HandoverOutcome, attemptId: string): DaemonLedgerEvent {
	return { at, pid: 1, event: "handover", reason: "rss-ceiling", outcome, attempt_id: attemptId };
}

describe("netUnresolvedHandovers — positive (must count unresolved rows)", () => {
	it("counts a handover with no matching listening row", () => {
		expect(netUnresolvedHandovers([handover(1_000)], 2_000)).toBe(1);
	});

	it("counts multiple unresolved handovers", () => {
		const events = [handover(1_000), handover(1_500), handover(1_800)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(3);
	});

	it("ignores events outside the window", () => {
		const nowMs = 100_000;
		const events = [handover(nowMs - HANDOVER_CHURN_WINDOW_MS - 1)];
		expect(netUnresolvedHandovers(events, nowMs)).toBe(0);
	});

	// Review 2026-08-28 finding 3 (second accounting error): plain subtraction
	// let an old healthy start EARLIER in the window cancel a LATER failed
	// handover. Pairing is chronological: a listening row pays off only
	// attempts that precede it.
	it("a listening row BEFORE the handover does not resolve it", () => {
		const events = [listening(1_000), handover(1_500)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(1);
	});

	it("an old start pays off none of several later failed handovers", () => {
		const events = [listening(1_000), handover(1_200), handover(1_400), handover(1_600)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(3);
	});

	it("ignores events after nowMs", () => {
		expect(netUnresolvedHandovers([handover(5_000)], 1_000)).toBe(0);
	});
});

describe("netUnresolvedHandovers — negative (must not count resolved rows)", () => {
	it("nets out a handover followed by a listening row", () => {
		const events = [handover(1_000), listening(1_200)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	it("never goes negative when listening rows outnumber handovers", () => {
		const events = [listening(1_000), listening(1_200)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	it("ignores other event kinds entirely", () => {
		const events: DaemonLedgerEvent[] = [
			{ at: 1_000, pid: 1, event: "start" },
			{ at: 1_100, pid: 1, event: "exit", reason: "signal" },
			{ at: 1_200, pid: 1, event: "spike" },
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});
});

describe("handoverChurnExceeded — positive (must fire)", () => {
	it("trips once unresolved handovers reach the max", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS }, (_, i) => handover(1_000 + i));
		expect(handoverChurnExceeded(events, 10_000)).toBe(true);
	});

	it("trips past the max, not just at it", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS + 3 }, (_, i) => handover(1_000 + i));
		expect(handoverChurnExceeded(events, 10_000)).toBe(true);
	});

	it("respects a custom threshold argument", () => {
		const events = [handover(1_000), handover(1_100)];
		expect(handoverChurnExceeded(events, 2_000, 2)).toBe(true);
	});
});

describe("handoverChurnExceeded — negative (must not fire)", () => {
	it("stays clear one attempt below the max", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS - 1 }, (_, i) => handover(1_000 + i));
		expect(handoverChurnExceeded(events, 10_000)).toBe(false);
	});

	it("stays clear once every attempt resolved with a listening row", () => {
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS + 2 }, (_, i) => [
			handover(1_000 + i * 10),
			listening(1_005 + i * 10),
		]).flat();
		expect(handoverChurnExceeded(events, 10_000)).toBe(false);
	});

	it("stays clear once stale attempts age out of the window", () => {
		const nowMs = 1_000_000;
		const events = Array.from(
			{ length: HANDOVER_CHURN_MAX_ATTEMPTS + 2 },
			(_, i) => handover(nowMs - HANDOVER_CHURN_WINDOW_MS - 1_000 - i),
		);
		expect(handoverChurnExceeded(events, nowMs)).toBe(false);
	});
});

describe("backstop refusal rows never count as attempts (2026-08-25 outage pin)", () => {
	it("P: suppression rows do not sustain the lockout — the backstop decays once real attempts age out", () => {
		// The outage shape: 4 real never-listened handovers trip the backstop,
		// then every 120s a churn-backstop row is written. Under the old
		// counting those rows kept the window full forever; under the fix the
		// backstop releases as soon as the REAL attempts age past the window.
		const nowMs = 1_000_000_000;
		const stale = HANDOVER_CHURN_WINDOW_MS + 60_000;
		const events = [
			...Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS }, (_, i) => handover(nowMs - stale - i)),
			...Array.from({ length: 10 }, (_, i) =>
				churnBackstopEvent(39414, nowMs - i * 120_000, "build-refresh handover suppressed"),
			),
		];
		expect(handoverChurnExceeded(events, nowMs)).toBe(false);
	});

	it("N: real never-listened handovers inside the window still trip the backstop", () => {
		const nowMs = 1_000_000_000;
		const events = Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS }, (_, i) =>
			handover(nowMs - 1_000 - i),
		);
		expect(handoverChurnExceeded(events, nowMs)).toBe(true);
	});
});

describe("attempt-ID protocol — ordering-independent resolution (review 2026-08-29)", () => {
	// test-contract: bug — the reproduced fast-successor race: the successor's
	// acknowledging listening row lands BEFORE the parent's counting spawned
	// row. Chronological pairing read that successful restart as unresolved;
	// id pairing must not.
	it("P: an ack BEFORE its spawned row still resolves the attempt", () => {
		const events = [ack(1_000, "a1"), spawned(1_500, "a1")];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: public-api — the normal successful replacement: requested
	// (non-counting) → spawned → ack, net zero.
	it("P: requested + spawned + ack nets to zero", () => {
		const events = [typedRow(1_000, "requested", "a1"), spawned(1_100, "a1"), ack(1_400, "a1")];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: invariant — only `spawned` counts: requested, refused,
	// spawn_failed and no_artifact rows never had a successor to wait for.
	it("N: non-spawned typed outcomes never count as attempts", () => {
		const events = [
			typedRow(1_000, "requested", "a1"),
			typedRow(1_100, "refused", "a2"),
			typedRow(1_200, "spawn_failed", "a3"),
			typedRow(1_300, "no_artifact", "a4"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: bug — a spawned attempt whose successor never listens
	// stays unresolved regardless of the surrounding rows.
	it("P: a spawned row with no ack counts as one unresolved attempt", () => {
		expect(netUnresolvedHandovers([spawned(1_000, "a1")], 2_000)).toBe(1);
	});

	// test-contract: invariant — duplicated ledger events must not
	// double-count: two spawned rows with one id are one attempt, and a
	// duplicate ack changes nothing.
	it("N: duplicate spawned/ack rows for the same id count once", () => {
		const noAck = [spawned(1_000, "a1"), spawned(1_001, "a1")];
		expect(netUnresolvedHandovers(noAck, 2_000)).toBe(1);
		const acked = [...noAck, ack(1_100, "a1"), ack(1_101, "a1")];
		expect(netUnresolvedHandovers(acked, 2_000)).toBe(0);
	});

	// test-contract: invariant — an id-carrying listening row already resolved
	// its OWN attempt; it must not also pay off an unrelated legacy attempt.
	it("N: an acknowledging listening row does not pay off a legacy handover", () => {
		const events = [handover(1_000), spawned(1_200, "a1"), ack(1_400, "a1")];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(1);
	});

	// test-contract: public-api — a manual/legacy start reaching listening
	// means a daemon IS serving: it pays off one preceding unresolved attempt
	// of either kind.
	it("P: an id-less listening pays off a preceding unacked spawned attempt", () => {
		const events = [spawned(1_000, "a1"), listening(1_500)];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: boundary — expiry is the window: a spawned attempt older
	// than the window stops counting without any explicit expired row.
	it("N: an unresolved spawned attempt expires out of the window", () => {
		const nowMs = 1_000_000;
		const events = [spawned(nowMs - HANDOVER_CHURN_WINDOW_MS - 1, "a1")];
		expect(netUnresolvedHandovers(events, nowMs)).toBe(0);
	});
});

/** One row of the restart CLI / parent legs, by reason + outcome. */
function chainRow(
	at: number,
	reason: string,
	outcome: HandoverOutcome,
	attemptId?: string,
): DaemonLedgerEvent {
	return {
		at,
		pid: 3,
		event: "handover",
		reason,
		outcome,
		...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
	};
}

/** The legacy audit rows the chain writes with no outcome field. */
function legacyAudit(at: number, reason: string): DaemonLedgerEvent {
	return { at, pid: 3, event: "handover", reason };
}

// Review 2026-08-29 (P0): the reducer must net ZERO for every complete
// cross-process sequence the REAL code writes — the earlier version counted
// the restart CLI's own legacy explicit-restart/explicit-stop rows as
// unresolved attempts, so every successful automatic handover fed the
// backstop.
describe("cross-process attempt sequences (real row shapes)", () => {
	// test-contract: bug — the reviewer's reproduced miscount: a SUCCESSFUL
	// automatic handover's full chain (parent rows, CLI audit rows, daemon
	// spawn, ack) must net zero; it previously netted 2.
	it("P: the complete successful automatic chain nets zero", () => {
		const events = [
			chainRow(1_000, "build-refresh", "requested", "a1"),
			chainRow(1_001, "build-refresh", "launcher_spawned", "a1"),
			chainRow(1_100, "explicit-restart", "requested", "a1"),
			legacyAudit(1_150, "explicit-stop"),
			chainRow(1_200, "daemon-start", "daemon_spawned", "a1"),
			ack(1_400, "a1"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: bug — the same chain with legacy id-less CLI rows (an
	// OLD-build restart CLI between new-build parents) must also net zero:
	// explicit-restart/explicit-stop are audit facts, never attempts.
	it("P: legacy explicit-restart/explicit-stop rows inside the chain never count", () => {
		const events = [
			chainRow(1_000, "build-refresh", "requested", "a1"),
			chainRow(1_001, "build-refresh", "launcher_spawned", "a1"),
			legacyAudit(1_100, "explicit-restart"),
			legacyAudit(1_150, "explicit-stop"),
			ack(1_400, "a1"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: invariant — a child that backs off (churn) is terminal:
	// the refused row resolves the attempt and nothing counts.
	it("P: child backoff (churn-backstop refused) nets zero", () => {
		const events = [
			chainRow(1_000, "rss-ceiling", "requested", "a1"),
			chainRow(1_001, "rss-ceiling", "launcher_spawned", "a1"),
			{ ...chainRow(1_100, "churn-backstop", "refused", "a1"), detail: "explicit-restart suppressed" },
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: invariant — a failed CLI launch is terminal at the parent.
	it("P: CLI spawn failure (spawn_failed) nets zero", () => {
		const events = [
			chainRow(1_000, "build-refresh", "requested", "a1"),
			chainRow(1_001, "build-refresh", "spawn_failed", "a1"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: invariant — a failed DAEMON spawn inside the CLI is
	// terminal for the whole attempt.
	it("P: daemon spawn failure inside the CLI nets zero", () => {
		const events = [
			chainRow(1_000, "build-refresh", "launcher_spawned", "a1"),
			chainRow(1_100, "explicit-restart", "requested", "a1"),
			chainRow(1_200, "daemon-start", "spawn_failed", "a1"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: invariant — a restart deferring to an in-flight start
	// resolves its attempt (refused); nothing counts.
	it("P: deferred-to-inflight nets zero", () => {
		const events = [
			chainRow(1_000, "build-refresh", "launcher_spawned", "a1"),
			chainRow(1_100, "deferred-to-inflight", "refused", "a1"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: invariant — a stop that survives SIGKILL writes the
	// terminal start_failed row; the attempt resolves.
	it("P: start_failed (stop survived) nets zero", () => {
		const events = [
			chainRow(1_000, "build-refresh", "launcher_spawned", "a1"),
			chainRow(1_100, "explicit-restart", "requested", "a1"),
			chainRow(1_200, "explicit-restart", "start_failed", "a1"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: invariant — the startup guard stamps the attempt id on a
	// startup-failed exit; that exit resolves the counted daemon_spawned.
	it("P: a startup-failed exit carrying the id resolves the daemon attempt", () => {
		const events: DaemonLedgerEvent[] = [
			chainRow(1_000, "daemon-start", "daemon_spawned", "a1"),
			{ at: 1_300, pid: 4, event: "exit", reason: "startup-failed", attempt_id: "a1" },
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});

	// test-contract: bug — the one genuinely-unresolved shape: a daemon was
	// spawned and neither listened nor died with a stamped exit. It counts
	// until the window expires it.
	it("N: a spawned daemon that never listens counts until expiry", () => {
		const chain = [
			chainRow(1_000, "build-refresh", "launcher_spawned", "a1"),
			chainRow(1_200, "daemon-start", "daemon_spawned", "a1"),
		];
		expect(netUnresolvedHandovers(chain, 2_000)).toBe(1);
		const nowMs = 1_000_000;
		const aged = chain.map((e) => ({ ...e, at: nowMs - HANDOVER_CHURN_WINDOW_MS - 1 }));
		expect(netUnresolvedHandovers(aged, nowMs)).toBe(0);
	});

	// test-contract: public-api — launcher_spawned alone never counts as a
	// daemon attempt (it only means the restart CLI was launched).
	it("N: launcher_spawned alone counts zero", () => {
		expect(
			netUnresolvedHandovers([chainRow(1_000, "build-refresh", "launcher_spawned", "a1")], 2_000),
		).toBe(0);
	});

	// test-contract: invariant — an anti-stomp loser's exit row carries the
	// attempt id (stamped by antiStompDepsFor), resolving the attempt so four
	// lost races in a window can never re-trip the backoff.
	it("P: an anti-stomp exit carrying the id resolves the daemon attempt", () => {
		const events: DaemonLedgerEvent[] = [
			chainRow(1_000, "daemon-start", "daemon_spawned", "a1"),
			{ at: 1_300, pid: 4, event: "exit", reason: "anti-stomp", attempt_id: "a1" },
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});
});

// Rolling-upgrade compatibility (review 2026-08-29 finding 2): a pre-rename
// daemon writes outcome "spawned" for its launcher row. Under the OLD
// one-process model that meant "successor launched", so the reader must keep
// COUNTING it; new code never writes it.
describe("legacy outcome 'spawned' — reader-only compatibility", () => {
	// SAFETY: deliberately building a row with the retired outcome string the
	// old build wrote to disk; the union no longer contains it.
	const legacySpawned = (at: number, id: string): DaemonLedgerEvent =>
		({
			at,
			pid: 1,
			event: "handover",
			reason: "build-refresh",
			outcome: "spawned",
			attempt_id: id,
		}) as unknown as DaemonLedgerEvent;

	// test-contract: bug — the reviewer's repro: an unacknowledged old-format
	// spawned(A) counted ZERO under the rename, silently disabling the
	// backstop for rolling upgrades.
	it("P: an unacked legacy spawned(A) counts as one unresolved attempt", () => {
		expect(netUnresolvedHandovers([legacySpawned(1_000, "a1")], 2_000)).toBe(1);
	});

	// test-contract: invariant — a mixed old+new chain for ONE id counts once
	// and resolves on the ack.
	it("N: legacy spawned(A) + daemon_spawned(A) + listening(A) nets zero", () => {
		const events = [
			legacySpawned(1_000, "a1"),
			chainRow(1_200, "daemon-start", "daemon_spawned", "a1"),
			ack(1_400, "a1"),
		];
		expect(netUnresolvedHandovers(events, 2_000)).toBe(0);
	});
});

describe("recordInheritedDaemonSpawn / currentProcessAttemptId", () => {
	// test-contract: invariant — consuming the REAL process env retains the id
	// for late writers (the anti-stomp exit stamps it after the guard cleared
	// the env); an injected test env never pollutes that memo.
	it("P: currentProcessAttemptId returns the pending real-env value", () => {
		process.env[HANDOVER_ATTEMPT_ENV] = "cafe0001";
		try {
			expect(currentProcessAttemptId()).toBe("cafe0001");
			expect(consumeHandoverAttemptEnv()).toBe("cafe0001");
			expect(process.env[HANDOVER_ATTEMPT_ENV]).toBeUndefined();
			expect(currentProcessAttemptId()).toBe("cafe0001");
		} finally {
			delete process.env[HANDOVER_ATTEMPT_ENV];
		}
	});
});

describe("unresolvedAttemptExistsFor — per-artifact coalescing", () => {
	// test-contract: public-api — a launcher_spawned row for the artifact is
	// IN FLIGHT for coalescing (a second tick must not launch another CLI),
	// and a terminal refusal releases it.
	it("P: an unresolved launcher_spawned coalesces; a refused one releases", () => {
		const inFlight = [
			{ ...chainRow(1_000, "build-refresh", "launcher_spawned", "a1"), detail: "artifact X" },
		];
		expect(unresolvedAttemptExistsFor(inFlight, 2_000, "artifact X")).toBe(true);
		const released = [...inFlight, chainRow(1_100, "churn-backstop", "refused", "a1")];
		expect(unresolvedAttemptExistsFor(released, 2_000, "artifact X")).toBe(false);
	});

	// test-contract: public-api — the coalescing check: a second successor for
	// the SAME build artifact must not spawn while the first is mid-boot.
	it("P: an unacked spawned attempt for the artifact is in flight", () => {
		const events = [spawned(1_000, "a1", "artifact X")];
		expect(unresolvedAttemptExistsFor(events, 2_000, "artifact X")).toBe(true);
	});

	// test-contract: boundary — an acked attempt is resolved; a DIFFERENT
	// artifact's attempt never coalesces this one.
	it("N: acked or different-artifact attempts do not coalesce", () => {
		const acked = [spawned(1_000, "a1", "artifact X"), ack(1_100, "a1")];
		expect(unresolvedAttemptExistsFor(acked, 2_000, "artifact X")).toBe(false);
		const other = [spawned(1_000, "a2", "artifact Y")];
		expect(unresolvedAttemptExistsFor(other, 2_000, "artifact X")).toBe(false);
	});
});

describe("attempt-id plumbing helpers", () => {
	// test-contract: public-api — ids must be non-empty and unique enough to
	// pair rows inside one window.
	it("P: newHandoverAttemptId returns distinct non-empty ids", () => {
		const a = newHandoverAttemptId();
		const b = newHandoverAttemptId();
		expect(a).toMatch(/^[0-9a-f-]{8}$/);
		expect(a).not.toBe(b);
	});

	// test-contract: invariant — consuming the env var must CLEAR it, or the
	// daemon's own later handover spawns would leak a stale id to an unrelated
	// successor.
	it("P: consumeHandoverAttemptEnv reads and clears the variable", () => {
		const env: NodeJS.ProcessEnv = { [HANDOVER_ATTEMPT_ENV]: "abc12345" };
		expect(consumeHandoverAttemptEnv(env)).toBe("abc12345");
		expect(env[HANDOVER_ATTEMPT_ENV]).toBeUndefined();
	});

	// test-contract: boundary — absent and empty both normalize to undefined.
	it("N: absent or empty env yields undefined", () => {
		expect(consumeHandoverAttemptEnv({})).toBeUndefined();
		const env: NodeJS.ProcessEnv = { [HANDOVER_ATTEMPT_ENV]: "" };
		expect(consumeHandoverAttemptEnv(env)).toBeUndefined();
	});
});

describe("recordInheritedDaemonSpawn — ledger writes gated by an inherited attempt id", () => {
	function withTempRoot(fn: (root: string) => void): void {
		const root = mkdtempSync(join(tmpdir(), "handover-churn-test-"));
		try {
			fn(root);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	function readLedgerRows(root: string): DaemonLedgerEvent[] {
		const raw = readFileSync(join(root, ".interlinked", "daemon-events.jsonl"), "utf8");
		return raw
			.trim()
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line));
	}

	// test-contract: public-api — the counting outcome writes a ledger row
	// carrying the inherited attempt id and detail verbatim.
	it("P: writes a daemon_spawned row carrying the inherited attempt id and detail", () => {
		withTempRoot((root) => {
			recordInheritedDaemonSpawn(root, "daemon_spawned", "artifact X", { [HANDOVER_ATTEMPT_ENV]: "a1" });
			const rows = readLedgerRows(root);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				event: "handover",
				reason: "daemon-start",
				outcome: "daemon_spawned",
				attempt_id: "a1",
				detail: "artifact X",
			});
		});
	});

	// test-contract: invariant — daemon_spawned is the COUNTING step; it never
	// dedupes, unlike a terminal outcome.
	it("P: a repeated daemon_spawned outcome writes a row every time", () => {
		withTempRoot((root) => {
			const env = { [HANDOVER_ATTEMPT_ENV]: "a2" };
			recordInheritedDaemonSpawn(root, "daemon_spawned", undefined, env);
			recordInheritedDaemonSpawn(root, "daemon_spawned", undefined, env);
			expect(readLedgerRows(root)).toHaveLength(2);
		});
	});

	// test-contract: bug — a terminal outcome must resolve the attempt exactly
	// once even if the caller's retry loop reaches the same line twice; the
	// SECOND call's detail ("second") must never reach the ledger.
	it("P: a terminal outcome writes only once per (id, outcome)", () => {
		withTempRoot((root) => {
			const env = { [HANDOVER_ATTEMPT_ENV]: "a3" };
			recordInheritedDaemonSpawn(root, "spawn_failed", "first", env);
			recordInheritedDaemonSpawn(root, "spawn_failed", "second", env);
			const rows = readLedgerRows(root);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ outcome: "spawn_failed", detail: "first" });
		});
	});

	// test-contract: boundary — a missing or empty inherited id is a no-op: a
	// plain manual `harness start` must never create a ledger file.
	it("N: a missing or empty attempt id in env writes nothing", () => {
		withTempRoot((root) => {
			recordInheritedDaemonSpawn(root, "daemon_spawned", undefined, {});
			recordInheritedDaemonSpawn(root, "daemon_spawned", undefined, { [HANDOVER_ATTEMPT_ENV]: "" });
			expect(existsSync(join(root, ".interlinked", "daemon-events.jsonl"))).toBe(false);
		});
	});
});

describe("churnBackstopEvent", () => {
	it("builds a handover row tagged churn-backstop with the given detail", () => {
		const evt = churnBackstopEvent(4242, 5_000, "rss-ceiling suppressed");
		expect(evt).toEqual({
			at: 5_000,
			pid: 4242,
			event: "handover",
			reason: "churn-backstop",
			detail: "rss-ceiling suppressed",
		});
	});
});
