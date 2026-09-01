// ===========================================
// Harness daemon — background timers
// ===========================================
// The periodic work the daemon does off the hook path: refreshing the
// statusline snapshot so live counters stay current without a triggering event,
// and watching its own memory so it recycles before it degrades.
//
// Extracted from server.ts because that file is over the per-file line cap;
// keeping timers here means adding one is a change to a small module rather
// than growth on a file that may only shrink.

import { join } from "node:path";
import { getHeapSpaceStatistics, getHeapStatistics, writeHeapSnapshot } from "node:v8";
import { configuredCeilingBytes, shouldRecycle } from "../memory-ceiling.js";

const STATUSLINE_REFRESH_INTERVAL_MS = 10_000;
const MEMORY_CHECK_INTERVAL_MS = 30_000;
const BYTES_PER_MB = 1024 * 1024;

interface DaemonTimerHooks {
	/** Recompute the statusline snapshot (reservations, index, bridge state). */
	refreshStatuslineSnapshot: () => void;
	/**
	 * Hold the daemon-start mutex under this process's PID for the duration of
	 * RSS teardown. The lease is deliberately not released: contenders see a
	 * live owner while shutdown drains, then stale-owner recovery reclaims it
	 * immediately after this PID exits. This prevents a cold hook from spawning
	 * a replacement beside the still-resident old heap.
	 */
	acquireRecycleLease?: () => boolean;
	/** Clean shutdown — releases the socket and pid file. */
	shutdown: () => void;
	/** Always-on log line (not gated behind --verbose). */
	log: (message: string) => void;
	/** Injected for tests; defaults to this process's RSS. */
	rssBytes?: () => number;
	/** Injected for tests; defaults to the configured ceiling. */
	ceilingBytes?: number;
	/**
	 * Called when RSS jumps by more than the spike threshold between two ticks —
	 * the passive attribution channel for the unexplained ~1GB heap spikes
	 * (fingerprinted 2026-07-28: pure V8 heap, external ~20MB). A ledger row per
	 * spike, timestamp-joinable against activity.jsonl, turns the next day of
	 * normal use into the profiling session nobody has to run.
	 */
	onSpike?: (rssMb: number, deltaMb: number) => void;
	/** Directory for SIGUSR2 heap snapshots; absent disables the handler. */
	snapshotDir?: string;
	/** Timestamp of the last hook event this daemon served (server tracks it
	 *  for the idle timer already). Enables the idle shrink below. */
	lastEventAtMs?: () => number;
	/** Drop shrinkable caches (parsed manifest, forced GC). Called once per
	 *  idle period, re-armed by new activity: an idle daemon on a swap-pinned
	 *  box is a jetsam target for memory it doesn't need until the next event
	 *  — measured 2026-07-28, row-less SIGKILLs during a 2h idle gap.
	 *  ALSO the emergency valve under heap pressure (storm postmortem
	 *  2026-08-17): the heap cap sits below the RSS recycle ceiling, so a
	 *  transient spike aborts V8 before the graceful recycle can fire —
	 *  shrinking at the pressure fraction keeps headroom for the spike. */
	shrinkIdleMemory?: () => void;
	/** Injected for tests; defaults to v8.getHeapStatistics. */
	heapStats?: () => { usedBytes: number; limitBytes: number };
	/** Ledger callback when the emergency heap-pressure shrink fires. */
	onHeapPressure?: (usedMb: number, limitMb: number) => void;
}

/** Heap-use fraction of the V8 limit that triggers the emergency shrink. */
const EMERGENCY_HEAP_FRACTION = 0.75;
/** Emergency shrinks are rate-limited — GC under sustained pressure every
 *  tick would trade the OOM for a CPU stall. */
const EMERGENCY_SHRINK_COOLDOWN_MS = 120_000;

/** Idle time after which the shrink fires (once per idle period). */
const IDLE_SHRINK_AFTER_MS = 5 * 60_000;

/**
 * Start the daemon's background timers. Returns a stop function for tests.
 *
 * The memory timer is the hard backstop after removing compiler/test fanout
 * from the daemon. When RSS crosses the ceiling it stops this process first:
 * `shutdown()` releases the socket, pid file, and memory before any replacement
 * can start. The next cold hook keeps deterministic guards available and uses
 * the existing single-flight self-heal. This ordering is deliberate — spawning
 * a successor beside a multi-gigabyte daemon caused the system-wide OOM class
 * this timer must prevent. The state lost is caches and per-session trajectory,
 * both rebuildable.
 */
/** Compact per-space heap breakdown for spike attribution: which V8 space
 *  grew names the allocation class (old_space = retained objects,
 *  large_object_space = giant strings/arrays, plus external/arrayBuffers from
 *  process.memoryUsage for Buffer-backed reads). Sub-16MB spaces are elided —
 *  the spike rows exist to explain ~1GB jumps, not to catalog every space. */
export function heapSpaceSummary(): string {
	// BYTES_PER_MB is a module constant (1024*1024) — divisor non-zero by construction.
	const mb = (n: number): number => Math.round(n / BYTES_PER_MB);
	const spaces = getHeapSpaceStatistics()
		.filter((s) => s.space_used_size > 16 * BYTES_PER_MB)
		.map((s) => `${s.space_name.replace(/_space$/, "")}=${mb(s.space_used_size)}MB`);
	const usage = process.memoryUsage();
	if (usage.external > 16 * BYTES_PER_MB) spaces.push(`external=${mb(usage.external)}MB`);
	if (usage.arrayBuffers > 16 * BYTES_PER_MB) spaces.push(`arrayBuffers=${mb(usage.arrayBuffers)}MB`);
	return spaces.join(" ");
}

export function installDaemonTimers(hooks: DaemonTimerHooks): () => void {
	const ceiling = hooks.ceilingBytes ?? configuredCeilingBytes();
	const readRss = hooks.rssBytes ?? (() => process.memoryUsage().rss);
	const readHeap =
		hooks.heapStats ??
		((): { usedBytes: number; limitBytes: number } => {
			const s = getHeapStatistics();
			return { usedBytes: s.used_heap_size, limitBytes: s.heap_size_limit };
		});
	let lastEmergencyShrinkAt = 0;

	const statusline = setInterval(hooks.refreshStatuslineSnapshot, STATUSLINE_REFRESH_INTERVAL_MS);
	/** One tick's RSS growth that counts as a spike worth attributing. */
	const SPIKE_DELTA_BYTES = 150 * BYTES_PER_MB;
	let recycleStarted = false;
	let prevRss = readRss();
	// SIGUSR2 → heap snapshot on demand, for root-causing the spikes offline.
	// SIGUSR1 is reserved by Node for the debugger; USR2 is conventionally free.
	// Handler is stored so the disposer can unregister it (tests install and
	// tear these timers down repeatedly in one process).
	const onSigusr2 = (): void => {
		try {
			const path = writeHeapSnapshot(join(hooks.snapshotDir ?? "", `heap-${process.pid}.heapsnapshot`));
			hooks.log(`Heap snapshot written: ${path}`);
		} catch (err) {
			hooks.log(`Heap snapshot failed: ${String(err)}`);
		}
	};
	if (hooks.snapshotDir) process.on("SIGUSR2", onSigusr2);
	// Idle shrink: fire once per idle period. `lastShrinkAt < lastEvent` means
	// "no shrink since the last event" — firing stamps lastShrinkAt past the
	// idle period's event, and only a NEWER event re-arms the comparison.
	let lastShrinkAt = 0;
	const memory = setInterval(() => {
		const rss = readRss();
		const delta = rss - prevRss;
		prevRss = rss;
		if (delta > SPIKE_DELTA_BYTES) {
			hooks.onSpike?.(Math.round(rss / BYTES_PER_MB), Math.round(delta / BYTES_PER_MB));
		}
		if (hooks.lastEventAtMs && hooks.shrinkIdleMemory) {
			const lastEvent = hooks.lastEventAtMs();
			if (Date.now() - lastEvent >= IDLE_SHRINK_AFTER_MS && lastShrinkAt < lastEvent) {
				lastShrinkAt = Date.now();
				hooks.shrinkIdleMemory();
			}
		}
		// Emergency valve: shrink the moment heap use crosses the pressure
		// fraction — waiting for idleness or the RSS ceiling is what let spikes
		// abort V8 (heap cap < RSS ceiling, storm postmortem 2026-08-17).
		if (hooks.shrinkIdleMemory) {
			const heap = readHeap();
			const pressured =
				heap.limitBytes > 0 && heap.usedBytes / heap.limitBytes > EMERGENCY_HEAP_FRACTION;
			if (pressured && Date.now() - lastEmergencyShrinkAt >= EMERGENCY_SHRINK_COOLDOWN_MS) {
				lastEmergencyShrinkAt = Date.now();
				hooks.shrinkIdleMemory();
				hooks.onHeapPressure?.(
					Math.round(heap.usedBytes / BYTES_PER_MB),
					Math.round(heap.limitBytes / BYTES_PER_MB),
				);
			}
		}
		if (!shouldRecycle(rss, ceiling)) {
			return;
		}
		if (recycleStarted) return;
		recycleStarted = true;
		// Hold the startup mutex BEFORE the socket starts draining. A cold hook can
		// arrive after the socket stops answering but while shutdownAsync still
		// retains this heap for a few seconds; the live-PID lock makes that caller
		// defer rather than spawning an overlapping replacement. We leave the lease
		// behind intentionally so dead-owner recovery, not this process, opens the
		// next start window after memory is actually gone.
		const recycleLeaseHeld = hooks.acquireRecycleLease?.() ?? false;
		hooks.log(
			`Recycling: RSS ${Math.round(rss / BYTES_PER_MB)}MB over ${Math.round(ceiling / BYTES_PER_MB)}MB ceiling — ${recycleLeaseHeld ? "startup lease held; stopping before replacement" : "startup already locked; stopping without spawning"} to release memory`,
		);
		hooks.shutdown();
	}, MEMORY_CHECK_INTERVAL_MS);

	// Neither timer should hold the process open on its own.
	statusline.unref();
	memory.unref();

	return () => {
		clearInterval(statusline);
		clearInterval(memory);
		process.removeListener("SIGUSR2", onSigusr2);
	};
}
