import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeHeapSnapshotMock = vi.fn<(path?: string) => string>();
vi.mock("node:v8", () => ({
	writeHeapSnapshot: (path?: string) => writeHeapSnapshotMock(path),
	// Default heap stats read: comfortable (no pressure) so tests that don't
	// inject heapStats never trip the emergency shrink.
	getHeapStatistics: () => ({ used_heap_size: 1, heap_size_limit: 1024 * 1024 * 1024 }),
	getHeapSpaceStatistics: () => heapSpacesMock(),
}));
// Default: one big retained space + one sub-floor space that must be elided.
const heapSpacesMock = vi.fn(() => [
	{ space_name: "old_space", space_used_size: 1997 * 1024 * 1024 },
	{ space_name: "new_space", space_used_size: 4 * 1024 * 1024 },
]);

import { heapSpaceSummary, IDLE_DRAIN_AFTER_MS, idleActionDue, installDaemonTimers } from "./daemon-timers.js";

describe("idleActionDue — once per idle period", () => {
    // test-contract: invariant — an idle action (the evidence drain) fires only after the idle threshold AND only once per idle period: it is re-armed by a newer hook event, never by time alone (H5, 2026-10-02)
    it("is due after the threshold, once, until a newer event re-arms it", () => {
        const after = IDLE_DRAIN_AFTER_MS;
        expect(idleActionDue(1_000 + after - 1, 1_000, 0, after)).toBe(false);
        expect(idleActionDue(1_000 + after, 1_000, 0, after)).toBe(true);
        expect(idleActionDue(1_000 + 3 * after, 1_000, 1_000 + after, after)).toBe(false);
        const firedAt = 1_000 + after, newerEvent = firedAt + 5_000;
        expect(idleActionDue(newerEvent + after, newerEvent, firedAt, after)).toBe(true);
    });
});

describe("heapSpaceSummary — spike-row heap breakdown", () => {
	it("P1: renders each over-floor space as name=NNNMB with _space trimmed", () => {
		expect(heapSpaceSummary()).toContain("old=1997MB");
	});

	it("N1: elides spaces at or under the 16MB floor", () => {
		expect(heapSpaceSummary()).not.toContain("new=");
	});

	it("P2: appends external memory once Buffers push it over the floor", () => {
		// 48MB of Buffer-backed allocation lands in `external`, not the JS heap.
		const pinned = Buffer.alloc(48 * 1024 * 1024, 1);
		const summary = heapSpaceSummary();
		expect(pinned.length).toBe(48 * 1024 * 1024);
		expect(summary).toMatch(/external=\d+MB/);
	});
});

/**
 * The memory timer is a machine-safety boundary: it must stop the bloated
 * process before any replacement can overlap its heap. The next cold hook can
 * continue deterministic guarding and trigger the single-flight self-heal.
 */
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const MB = 1024 * 1024;

function harness(rss: number, ceiling: number) {
	const shutdown = vi.fn();
	const log = vi.fn();
	const refreshStatuslineSnapshot = vi.fn();
	const acquireRecycleLease = vi.fn(() => true);
	const stop = installDaemonTimers({
		refreshStatuslineSnapshot,
		acquireRecycleLease,
		shutdown,
		log,
		rssBytes: () => rss,
		ceilingBytes: ceiling,
	});
	return { acquireRecycleLease, shutdown, log, refreshStatuslineSnapshot, stop };
}

describe("installDaemonTimers — memory ceiling", () => {
	it("does not recycle a daemon under its ceiling", () => {
		const h = harness(100 * MB, 500 * MB);
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.shutdown).not.toHaveBeenCalled();
		h.stop();
	});

	it("gracefully stops on the first over-ceiling tick", () => {
		const h = harness(600 * MB, 500 * MB);
		vi.advanceTimersByTime(30_000);
		expect(h.acquireRecycleLease).toHaveBeenCalledTimes(1);
		expect(h.shutdown).toHaveBeenCalledTimes(1);
		expect(
			h.acquireRecycleLease.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		).toBeLessThan(
			h.shutdown.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		const msg = h.log.mock.calls.map((c) => String(c[0])).join(" ");
		expect(msg).toContain("stopping before replacement");
		h.stop();
	});

	it("says WHY it is recycling, with both numbers", () => {
		// An operator seeing the daemon restart must be able to tell this apart
		// from a crash, or they will go hunting for a bug that isn't there.
		const h = harness(600 * MB, 500 * MB);
		vi.advanceTimersByTime(60_000);
		const msg = h.log.mock.calls.map((c) => String(c[0])).join(" ");
		expect(msg).toContain("600MB");
		expect(msg).toContain("500MB");
		expect(msg).toContain("Recycling");
		expect(msg).toContain("release memory");
		h.stop();
	});

	it("requests shutdown only once while process teardown is pending", () => {
		const h = harness(600 * MB, 500 * MB);
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.acquireRecycleLease).toHaveBeenCalledTimes(1);
		expect(h.shutdown).toHaveBeenCalledTimes(1);
		expect(h.log).toHaveBeenCalledTimes(1);
		h.stop();
	});

	it("refreshes the statusline on its own cadence", () => {
		const h = harness(10 * MB, 500 * MB);
		vi.advanceTimersByTime(30_000);
		expect(h.refreshStatuslineSnapshot).toHaveBeenCalled();
		h.stop();
	});

	it("stops both timers when stopped", () => {
		const h = harness(600 * MB, 500 * MB);
		h.stop();
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.shutdown).not.toHaveBeenCalled();
		expect(h.refreshStatuslineSnapshot).not.toHaveBeenCalled();
	});

	it("never recycles when the ceiling is disabled with 0", () => {
		const h = harness(10_000 * MB, 0);
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.shutdown).not.toHaveBeenCalled();
		h.stop();
	});
});

describe("installDaemonTimers — spike attribution", () => {
	// The unexplained heap spikes (pure V8 heap, ~1GB inside one 30s window)
	// need passive attribution: a callback per >150MB/tick jump, ledgered by the
	// caller and timestamp-joinable against activity.jsonl.
	it("reports a jump over the spike threshold with rss and delta in MB", () => {
		let rss = 100 * MB;
		const onSpike = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => rss,
			ceilingBytes: 0,
			onSpike,
		});
		rss = 400 * MB;
		vi.advanceTimersByTime(30_000);
		expect(onSpike).toHaveBeenCalledWith(400, 300);
		stop();
	});

	it("stays silent for growth under the threshold", () => {
		let rss = 100 * MB;
		const onSpike = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => rss,
			ceilingBytes: 0,
			onSpike,
		});
		rss = 200 * MB; // +100MB — normal churn, not a spike
		vi.advanceTimersByTime(30_000);
		expect(onSpike).not.toHaveBeenCalled();
		stop();
	});

	it("attributes each spike to ITS tick, not cumulatively", () => {
		let rss = 100 * MB;
		const onSpike = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => rss,
			ceilingBytes: 0,
			onSpike,
		});
		rss = 400 * MB;
		vi.advanceTimersByTime(30_000);
		vi.advanceTimersByTime(30_000); // flat since — must not re-report
		expect(onSpike).toHaveBeenCalledTimes(1);
		stop();
	});
});

describe("installDaemonTimers — emergency heap-pressure shrink", () => {
	// The heap cap (1536MB) sits below the 2048MB RSS recycle ceiling, so a
	// transient allocation spike can still abort V8
	// before the graceful recycle can ever fire. The defense is an emergency
	// shrink (cache drop + forced GC) the moment heap use crosses the
	// pressure fraction — not only when idle.
	function pressureHarness(usedBytes: number, limitBytes: number) {
		const shrinkIdleMemory = vi.fn();
		const onHeapPressure = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => 100 * MB,
			ceilingBytes: 0,
			heapStats: () => ({ usedBytes, limitBytes }),
			shrinkIdleMemory,
			onHeapPressure,
		});
		return { shrinkIdleMemory, onHeapPressure, stop };
	}

	it("P: shrinks and reports with used/limit MB when heap use crosses the fraction", () => {
		const h = pressureHarness(1200 * MB, 1536 * MB); // 78% > 75%
		vi.advanceTimersByTime(30_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		expect(h.onHeapPressure).toHaveBeenCalledWith(1200, 1536);
		h.stop();
	});

	it("N: stays quiet under the pressure fraction", () => {
		const h = pressureHarness(1075 * MB, 1536 * MB); // 70% < 75%
		vi.advanceTimersByTime(30_000);
		expect(h.shrinkIdleMemory).not.toHaveBeenCalled();
		expect(h.onHeapPressure).not.toHaveBeenCalled();
		h.stop();
	});

	it("N: fires at most once per cooldown window under sustained pressure", () => {
		const h = pressureHarness(1400 * MB, 1536 * MB);
		vi.advanceTimersByTime(30_000);
		vi.advanceTimersByTime(30_000);
		vi.advanceTimersByTime(30_000); // 90s elapsed — still inside the 120s cooldown
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_000); // 150s — cooldown passed, still pressured
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(2);
		h.stop();
	});

	it("N: a zero heap limit never divides its way into a shrink", () => {
		const h = pressureHarness(2000 * MB, 0);
		vi.advanceTimersByTime(30_000);
		expect(h.shrinkIdleMemory).not.toHaveBeenCalled();
		h.stop();
	});
});

describe("installDaemonTimers — idle shrink", () => {
	// A daemon idle for minutes on a swap-pinned box is a jetsam target for
	// memory it doesn't need until the next event: drop the shrinkable caches
	// once per idle period, re-armed by new activity.
	function idleHarness(lastEventAtMs: () => number) {
		const shrinkIdleMemory = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => 100 * MB,
			ceilingBytes: 500 * MB,
			lastEventAtMs,
			shrinkIdleMemory,
		});
		return { shrinkIdleMemory, stop };
	}

	it("P1: shrinks once after the idle threshold, not on every subsequent tick", () => {
		const start = Date.now();
		const h = idleHarness(() => start);
		vi.advanceTimersByTime(6 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		h.stop();
	});

	it("P2: new activity re-arms the shrink for the next idle period", () => {
		const start = Date.now();
		let lastEvent = start;
		const h = idleHarness(() => lastEvent);
		vi.advanceTimersByTime(6 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		lastEvent = Date.now(); // an event arrives
		vi.advanceTimersByTime(6 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(2);
		h.stop();
	});

	it("N1: recent activity means no shrink", () => {
		const h = idleHarness(() => Date.now());
		vi.advanceTimersByTime(10 * 60_000);
		expect(h.shrinkIdleMemory).not.toHaveBeenCalled();
		h.stop();
	});

	it("N2: absent hooks leave the timers working as before", () => {
		const shutdown = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown,
			log: vi.fn(),
			rssBytes: () => 100 * MB,
			ceilingBytes: 500 * MB,
		});
		vi.advanceTimersByTime(10 * 60_000);
		expect(shutdown).not.toHaveBeenCalled();
		stop();
	});
});

describe("installDaemonTimers — idle evidence drain", () => {
	function drainHarness(lastEventAtMs: () => number) {
		const drainIdleEvidence = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(), shutdown: vi.fn(), log: vi.fn(),
			rssBytes: () => 100 * MB, ceilingBytes: 500 * MB, lastEventAtMs, drainIdleEvidence,
		});
		return { drainIdleEvidence, stop };
	}

	// test-contract: invariant — the daemon starts the evidence drain once per idle period, only after the drain threshold (longer than the shrink's), and a newer hook event re-arms it (H5, 2026-10-02)
	it("drains once after ten idle minutes, not at five, and re-arms on new activity", () => {
		let lastEvent = Date.now();
		const h = drainHarness(() => lastEvent);
		vi.advanceTimersByTime(6 * 60_000);
		expect(h.drainIdleEvidence).not.toHaveBeenCalled();
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.drainIdleEvidence).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(20 * 60_000);
		expect(h.drainIdleEvidence).toHaveBeenCalledTimes(1);
		lastEvent = Date.now();
		vi.advanceTimersByTime(11 * 60_000);
		expect(h.drainIdleEvidence).toHaveBeenCalledTimes(2);
		h.stop();
	});
});

describe("installDaemonTimers — defaults (ceilingBytes/rssBytes omitted)", () => {
	// Both default expressions (`hooks.ceilingBytes ?? configuredCeilingBytes()`
	// and `hooks.rssBytes ?? process.memoryUsage().rss`) only run when the
	// caller omits the corresponding hook — every other test in this file
	// supplies both explicitly.
	it("still runs the memory timer without throwing when both are omitted", () => {
		const shutdown = vi.fn();
		const refreshStatuslineSnapshot = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot,
			shutdown,
			log: vi.fn(),
		});
		expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
		expect(refreshStatuslineSnapshot).toHaveBeenCalled();
		stop();
	});
});

describe("installDaemonTimers — SIGUSR2 heap snapshot", () => {
	beforeEach(() => {
		writeHeapSnapshotMock.mockReset();
	});

	it("writes a heap snapshot and logs the path on SIGUSR2 when snapshotDir is set", () => {
		writeHeapSnapshotMock.mockReturnValue("/tmp/heap-123.heapsnapshot");
		const log = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log,
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
			snapshotDir: "/tmp/snaps",
		});
		process.emit("SIGUSR2");
		expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);
		expect(log.mock.calls.some((c) => String(c[0]).includes("Heap snapshot written"))).toBe(
			true,
		);
		stop();
	});

	it("logs a failure message when writeHeapSnapshot throws", () => {
		writeHeapSnapshotMock.mockImplementation(() => {
			throw new Error("disk full");
		});
		const log = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log,
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
			snapshotDir: "/tmp/snaps",
		});
		process.emit("SIGUSR2");
		expect(log.mock.calls.some((c) => String(c[0]).includes("Heap snapshot failed"))).toBe(
			true,
		);
		stop();
	});

	it("does not register a SIGUSR2 handler when snapshotDir is absent", () => {
		const before = process.listenerCount("SIGUSR2");
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
		});
		expect(process.listenerCount("SIGUSR2")).toBe(before);
		stop();
	});

	it("removes its SIGUSR2 listener when stopped", () => {
		const before = process.listenerCount("SIGUSR2");
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
			snapshotDir: "/tmp/snaps",
		});
		expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
		stop();
		expect(process.listenerCount("SIGUSR2")).toBe(before);
	});
});
