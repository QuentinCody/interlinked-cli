import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { netUnresolvedHandovers } from "./handover-churn.js";
import {
	classifyExitReason,
	describeLastExit,
	describeLastLedgerEvent,
	makeHeapPressureLedger,
	readRecentDaemonEvents,
	recordDaemonEvent,
	recordDaemonExit,
} from "./daemon-ledger.js";

/**
 * Why this exists: over one session (2026-07-28) the daemon "went down" a
 * dozen times with FOUR different causes — build-refresh handovers, memory
 * hangs under swap, orphan accumulation, RSS-ceiling recycles — and every one
 * presented as the same opaque symptom: "pid present, no live daemon". With no
 * record of WHY a daemon exited, each occurrence was re-diagnosed from scratch
 * and mostly misattributed. The ledger makes every daemon exit self-
 * documenting, so the cold-block message and `harness status` can say "handed
 * over to a newer build 4s ago — normal after a rebuild" instead of implying
 * a crash.
 */
let dir: string;
const NOW = 1_800_000_000_000;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "daemon-ledger-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("recordDaemonEvent / readRecentDaemonEvents", () => {
	// test-contract: behavior — the emergency-GC ledger callback (storm
	// postmortem 2026-08-17) writes a joinable row AND a log line with both
	// heap numbers, so a postmortem reads the defense firing
	it("P: makeHeapPressureLedger records an emergency-gc row and logs both numbers", () => {
		const logged: string[] = [];
		makeHeapPressureLedger(dir, (m) => logged.push(m))(2000, 2560);
		const row = readRecentDaemonEvents(dir)[0];
		expect(row).toMatchObject({ event: "emergency-gc", pid: process.pid });
		expect(row?.detail).toBe("heap 2000MB of 2560MB limit — shrank caches + forced GC");
		expect(logged[0]).toBe("Emergency GC: heap 2000MB of 2560MB limit — shrank caches");
	});

	it("round-trips an exit event with its reason", () => {
		recordDaemonEvent(dir, { at: NOW, pid: 42, event: "exit", reason: "build-refresh", rss_mb: 180 });
		const events = readRecentDaemonEvents(dir);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ pid: 42, event: "exit", reason: "build-refresh" });
	});

	// P: the exit row every daemon exit path shares — reason plus the memory
	// split and uptime a post-mortem needs, for THIS process.
	it("recordDaemonExit writes reason, pid, memory split and uptime", () => {
		recordDaemonExit(dir, "startup-failed", Date.now() - 5_000);
		const row = readRecentDaemonEvents(dir)[0];
		expect(row).toMatchObject({ event: "exit", reason: "startup-failed", pid: process.pid });
		expect(row?.rss_mb).toBeGreaterThan(0);
		expect(row?.heap_mb).toBeGreaterThan(0);
		expect(typeof row?.ext_mb).toBe("number");
		// ~5s elapsed; allow for a slow CI tick either way.
		expect(row?.uptime_s).toBeGreaterThanOrEqual(4);
		expect(row?.uptime_s).toBeLessThan(30);
	});

	it("keeps events in append order", () => {
		recordDaemonEvent(dir, { at: NOW, pid: 1, event: "start" });
		recordDaemonEvent(dir, { at: NOW + 1, pid: 1, event: "exit", reason: "signal" });
		expect(readRecentDaemonEvents(dir).map((e) => e.event)).toEqual(["start", "exit"]);
	});

	it("never throws when the directory is unwritable — the guard must not die of its own diary", () => {
		// A REAL unwritable directory (mode 000), not a procfs path: probing
		// /proc/nonexistent-root worked as a joke path on macOS but on the Linux
		// CI runner it lands inside procfs, whose mkdir semantics hung the
		// single fork worker and timed out the whole unit lane (run 30410747800
		// — identified by the size-ordered queue: this file was the largest
		// never-completed). Root under CI runs unprivileged, so chmod 000 holds.
		const locked = join(dir, "locked");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		try {
			expect(() =>
				recordDaemonEvent(join(locked, "sub"), { at: NOW, pid: 1, event: "start" }),
			).not.toThrow();
		} finally {
			chmodSync(locked, 0o755); // or afterEach's rmSync fails on some platforms
		}
	});

	it("returns [] when no ledger exists", () => {
		expect(readRecentDaemonEvents(dir)).toEqual([]);
	});

	it("skips torn/corrupt lines rather than failing the read", () => {
		recordDaemonEvent(dir, { at: NOW, pid: 1, event: "start" });
		writeFileSync(join(dir, ".interlinked", "daemon-events.jsonl"), "{not json\n", { flag: "a" });
		recordDaemonEvent(dir, { at: NOW + 2, pid: 1, event: "exit", reason: "signal" });
		expect(readRecentDaemonEvents(dir)).toHaveLength(2);
	});

	it.each([{ reason: 42 }, { rss_mb: "large" }, { attempt_id: [] }, { outcome: {} }])(
		"skips a ledger row with malformed optional fields: %j",
		(fields) => {
			recordDaemonEvent(dir, { at: NOW, pid: 1, event: "start" });
			writeFileSync(join(dir, ".interlinked", "daemon-events.jsonl"), `${JSON.stringify({ at: NOW + 1, pid: 1, event: "exit", ...fields })}\n`, { flag: "a" });
			expect(readRecentDaemonEvents(dir)).toEqual([{ at: NOW, pid: 1, event: "start" }]);
		},
	);

	it("preserves newer event labels and counts legacy spawned handovers", () => {
		recordDaemonEvent(dir, { at: NOW, pid: 1, event: "start" });
		const rows = [
			{ at: NOW + 1, pid: 1, event: "handover", outcome: "spawned", attempt_id: "legacy" },
			{ at: NOW + 2, pid: 1, event: "future-event", detail: "retained" },
		];
		writeFileSync(join(dir, ".interlinked", "daemon-events.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { flag: "a" });
		const read = readRecentDaemonEvents(dir);
		expect(read.slice(1)).toEqual(rows);
		expect(netUnresolvedHandovers(read, NOW + 3)).toBe(1);
		expect(describeLastLedgerEvent(read, NOW + 3)).toContain("future-event");
	});

	it("bounds the read to a tail — a long-lived ledger must not be slurped whole", () => {
		for (let i = 0; i < 2000; i++) recordDaemonEvent(dir, { at: NOW + i, pid: i, event: "start" });
		const events = readRecentDaemonEvents(dir);
		expect(events.length).toBeLessThan(2000);
		expect(events.at(-1)?.pid).toBe(1999); // the newest survives the bound
	});

	it("reads the byte-bounded tail directly instead of full-reading then slicing", () => {
		const source = readFileSync(new URL("./daemon-ledger.ts", import.meta.url), "utf-8");
		expect(source).toContain("readRecentLines(path, 10_000, READ_TAIL_BYTES)");
		expect(source).not.toMatch(/readFileSync\(path[^)]*\)[\s\S]{0,120}slice/);
	});
});

describe("describeLastExit — the sentence the block message shows", () => {
	it("explains a build-refresh handover as normal, with age", () => {
		recordDaemonEvent(dir, { at: NOW - 4_000, pid: 7, event: "handover", reason: "build-refresh" });
		recordDaemonEvent(dir, { at: NOW - 3_000, pid: 7, event: "exit", reason: "signal" });
		const line = describeLastExit(readRecentDaemonEvents(dir), NOW);
		expect(line).toContain("build-refresh");
		expect(line).toContain("3s ago");
	});

	it("names an rss-ceiling recycle explicitly", () => {
		recordDaemonEvent(dir, { at: NOW - 10_000, pid: 7, event: "exit", reason: "rss-ceiling", rss_mb: 512 });
		const line = describeLastExit(readRecentDaemonEvents(dir), NOW);
		expect(line).toContain("rss-ceiling");
		expect(line).toContain("512");
	});

	it("does not explain a stale exit as if it were the current outage", () => {
		// An exit from an hour ago cannot be why the socket is down NOW; a wrong
		// explanation is worse than none.
		recordDaemonEvent(dir, { at: NOW - 3_600_000, pid: 7, event: "exit", reason: "signal" });
		expect(describeLastExit(readRecentDaemonEvents(dir), NOW)).toBeNull();
	});

	it("returns null with no exit events at all", () => {
		recordDaemonEvent(dir, { at: NOW - 1_000, pid: 7, event: "start" });
		expect(describeLastExit(readRecentDaemonEvents(dir), NOW)).toBeNull();
	});
});

// ── Exit disposition: planned vs unplanned (2026-08-15 restart storm) ────────
// The storm's diagnosis stalled on a ledger where a reaper's SIGTERM and an
// intentional `harness stop` were the same row. Every exit now carries which
// it was.

describe("classifyExitReason — positive (must fire)", () => {
	it("P1: recycles and handovers are planned", () => {
		for (const r of ["build-refresh", "rss-ceiling", "idle-timeout", "handover"]) {
			expect(classifyExitReason(r)).toBe("planned");
		}
	});
	it("P2: an explicit stop/restart is planned", () => {
		expect(classifyExitReason("explicit-stop")).toBe("planned");
		expect(classifyExitReason("explicit-restart")).toBe("planned");
	});
	it("P3: a startup-lock loser standing down is planned", () => {
		expect(classifyExitReason("anti-stomp")).toBe("planned");
	});
	it("P4: signal / oom / startup-failed are unplanned", () => {
		for (const r of ["signal", "oom", "startup-failed", "crash"]) {
			expect(classifyExitReason(r)).toBe("unplanned");
		}
	});
	it("P5: recordDaemonExit stamps the disposition on the row", () => {
		recordDaemonExit(dir, "explicit-stop", NOW - 1000);
		const rows = readRecentDaemonEvents(dir);
		expect(rows[rows.length - 1]?.disposition).toBe("planned");
	});
});

describe("classifyExitReason — negative (must not fire)", () => {
	it("N1: an unknown reason is 'unknown', never guessed as planned", () => {
		expect(classifyExitReason("teleported")).toBe("unknown");
	});
	it("N2: a missing reason is 'unknown'", () => {
		expect(classifyExitReason(undefined)).toBe("unknown");
	});
});

describe("describeLastLedgerEvent — quotes the LAST event, not the last exit", () => {
	it("P1: a start after an exit is what gets reported", () => {
		const events = [
			{ at: NOW - 276_000, pid: 50829, event: "exit" as const, reason: "startup-failed" },
			{ at: NOW - 4_000, pid: 60001, event: "start" as const },
		];
		const text = describeLastLedgerEvent(events, NOW);
		expect(text).toContain("pid 60001 start");
		expect(text).toContain("4s ago");
		expect(text).not.toContain("50829");
	});
	it("P2: an exit row reports its disposition", () => {
		const text = describeLastLedgerEvent(
			[{ at: NOW - 1_000, pid: 7, event: "exit" as const, reason: "signal" }],
			NOW,
		);
		expect(text).toContain("unplanned");
	});
	it("N1: an empty ledger describes nothing", () => {
		expect(describeLastLedgerEvent([], NOW)).toBeNull();
	});
});
