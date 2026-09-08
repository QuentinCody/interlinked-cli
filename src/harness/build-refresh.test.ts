import { parseWire, wireRecord, wireUnknown } from "../lib/value-validation.js";
import { nonNull } from "../lib/non-null.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveOwnArtifact,
	shouldHandOver,
	startBuildRefreshWatcher,
} from "./build-refresh.js";
import type { DaemonLedgerEvent } from "./daemon-ledger.js";
import { HANDOVER_CHURN_MAX_ATTEMPTS } from "./handover-churn.js";

type SpawnRestart = NonNullable<NonNullable<Parameters<typeof startBuildRefreshWatcher>[0]["deps"]>["spawn"]>;

function makeSpawn() {
	return vi.fn<SpawnRestart>(() => ({ unref: vi.fn() }));
}

/** `HANDOVER_CHURN_MAX_ATTEMPTS` unresolved handover rows — enough to trip
 *  the churn backstop when handed to a `readEvents`/`recordEvent` seam. */
function churnedEvents(nowMs: number): DaemonLedgerEvent[] {
	return Array.from({ length: HANDOVER_CHURN_MAX_ATTEMPTS }, (_, i) => ({
		at: nowMs - 1_000 + i,
		pid: 1,
		event: "handover" as const,
		reason: "build-refresh",
	}));
}

describe("resolveOwnArtifact", () => {
	it("returns null for a src-run module URL (tsx/bun dev — no dist marker)", () => {
		expect(resolveOwnArtifact("file:///Users/x/interlinked-cli/src/harness/server.ts")).toBeNull();
	});

	it("returns null for an unparseable module URL", () => {
		expect(resolveOwnArtifact("not-a-url")).toBeNull();
	});

	it("derives artifact + CLI entry from a dist-run module URL", () => {
		const resolved = resolveOwnArtifact("file:///Users/x/interlinked-cli/dist/harness/server.js");
		expect(resolved).not.toBeNull();
		expect(resolved?.artifactPath).toBe("/Users/x/interlinked-cli/dist/harness/server.js");
		expect(resolved?.cliEntryPath).toBe("/Users/x/interlinked-cli/dist/index.js");
	});
});

describe("shouldHandOver", () => {
	const base = {
		nowMs: 100_000,
		currentMtimeMs: 50_000,
		startedMtimeMs: 40_000,
		lastActivityAtMs: 0,
		settleMs: 5_000,
		quietMs: 10_000,
	};

	it("fires when the artifact is newer, settled, and the repo is quiet", () => {
		expect(shouldHandOver(base)).toBe(true);
	});

	it("does not fire when the artifact mtime is unchanged", () => {
		expect(shouldHandOver({ ...base, currentMtimeMs: base.startedMtimeMs })).toBe(false);
	});

	it("does not fire when the artifact is older than the running build (clock skew)", () => {
		expect(shouldHandOver({ ...base, currentMtimeMs: 30_000 })).toBe(false);
	});

	it("does not fire while the rebuild is still settling", () => {
		expect(shouldHandOver({ ...base, currentMtimeMs: 99_000 })).toBe(false);
	});

	it("does not fire during an active hook-event burst", () => {
		expect(shouldHandOver({ ...base, lastActivityAtMs: 95_000 })).toBe(false);
	});

	// Both boundaries are exclusive: "settled" and "quiet" are reached AT the
	// threshold, not one tick past it. Without these, `<` and `<=` are
	// indistinguishable and an off-by-one delays every hand-over by a full tick.
	it("treats an artifact aged exactly settleMs as settled", () => {
		expect(shouldHandOver({ ...base, currentMtimeMs: 95_000 })).toBe(true);
	});

	it("treats silence of exactly quietMs as quiet", () => {
		expect(shouldHandOver({ ...base, lastActivityAtMs: 90_000 })).toBe(true);
	});

	it("treats a never-active daemon (lastActivityAtMs=0) as quiet", () => {
		expect(shouldHandOver({ ...base, lastActivityAtMs: 0 })).toBe(true);
	});

	// The quiet window alone starves: a busy multi-agent session never goes
	// 10s idle, so a daemon can serve a stale build indefinitely — measured on
	// this repo as 38 rss-ceiling handovers against 2 build-refresh handovers
	// while a 2-hour-old daemon silently under-enforced the baseline gate.
	describe("staleness escalation over the quiet window", () => {
		/** Burst so dense the quiet window never opens on its own. */
		const busy = { ...base, lastActivityAtMs: 99_999 };

		it("hands over mid-burst once the running build is stale past the deadline", () => {
			expect(shouldHandOver({ ...busy, nowMs: 700_000 })).toBe(true);
		});

		it("still defers to the quiet window just before the deadline", () => {
			// artifact age 599_999ms — one millisecond short of the 10min deadline.
			expect(shouldHandOver({ ...busy, nowMs: 649_999, lastActivityAtMs: 649_998 })).toBe(
				false,
			);
		});

		it("fires exactly at the deadline boundary", () => {
			expect(shouldHandOver({ ...busy, nowMs: 650_000, lastActivityAtMs: 649_999 })).toBe(true);
		});

		it("honors a caller-supplied maxStalenessMs", () => {
			expect(shouldHandOver({ ...busy, maxStalenessMs: 40_000 })).toBe(true);
			expect(shouldHandOver({ ...busy, maxStalenessMs: 60_000 })).toBe(false);
		});

		it("never escalates a build that is not actually newer", () => {
			expect(
				shouldHandOver({ ...busy, nowMs: 700_000, currentMtimeMs: base.startedMtimeMs }),
			).toBe(false);
		});

		it("never escalates past the settle window — an in-flight write is not a build", () => {
			// maxStaleness below settleMs must not let an unsettled artifact through.
			expect(
				shouldHandOver({ ...busy, maxStalenessMs: 1_000, currentMtimeMs: 99_000 }),
			).toBe(false);
		});
	});
});

describe("startBuildRefreshWatcher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const distUrl = "file:///repo/dist/harness/server.js";

	interface HarnessDeps {
		spawn: ReturnType<typeof makeSpawn>;
		log: ReturnType<typeof vi.fn<(message: string) => void>>;
		mtime: { value: number };
		dispose: () => void;
	}

	function startWatcher(overrides: {
		env?: NodeJS.ProcessEnv;
		moduleUrl?: string;
		startMtime?: number;
		/** Default 0 = never active, i.e. trivially quiet. Pass `() => Date.now()`
		 *  to simulate a session whose hook traffic never lets the window open. */
		lastActivityMs?: () => number;
	} = {}): HarnessDeps {
		const mtime = { value: overrides.startMtime ?? 1_000 };
		const spawn = makeSpawn();
		const log = vi.fn<(message: string) => void>();
		const dispose = startBuildRefreshWatcher({
			moduleUrl: overrides.moduleUrl ?? distUrl,
			cwd: "/repo",
			lastActivityMs: overrides.lastActivityMs ?? (() => 0),
			log,
			env: overrides.env ?? {},
			deps: {
				statMtimeMs: () => mtime.value,
				spawn,
			},
		});
		return { spawn, log, mtime, dispose };
	}

	// Regression: the watcher was wired so a continuously-busy repo could never
	// hand over, leaving a stale daemon silently under-enforcing every gate.
	// These two exercise the WIRING, not just the predicate.
	it("escalates past the staleness deadline even while hook events keep firing", () => {
		const h = startWatcher({ lastActivityMs: () => Date.now() });
		h.mtime.value = Date.now() - 20 * 60_000; // newer build, 20 min stale
		vi.advanceTimersByTime(60_000);
		// Assert the hand-over it actually performs, not merely that it happened:
		// a spawn with the wrong argv would restart nothing and still "pass".
		expect(h.spawn).toHaveBeenCalledTimes(1);
		const [cmd, argv, opts] = nonNull(h.spawn.mock.calls[0]);
		expect(cmd).toBe(process.execPath);
		expect(argv).toEqual(["/repo/dist/index.js", "harness", "restart"]);
		expect(opts.cwd).toBe("/repo");
		// The escalation must announce itself — a silent restart mid-burst is
		// indistinguishable from a crash in the daemon ledger.
		expect(h.log.mock.calls.flat().join(" ")).toContain("[build-refresh]");
		h.dispose();
	});

	it("does not escalate while the newer build is still recent", () => {
		const h = startWatcher({ lastActivityMs: () => Date.now() });
		h.mtime.value = Date.now() - 60_000; // settled, but far short of the deadline
		vi.advanceTimersByTime(60_000);
		expect(h.spawn).not.toHaveBeenCalled();
		h.dispose();
	});

	it("no-ops entirely for src-run daemons", () => {
		const h = startWatcher({ moduleUrl: "file:///repo/src/harness/server.ts" });
		vi.advanceTimersByTime(600_000);
		expect(h.spawn).not.toHaveBeenCalled();
		h.dispose();
	});

	it("no-ops when disabled via INTERLINKED_NO_AUTO_RESTART=1", () => {
		const h = startWatcher({ env: { INTERLINKED_NO_AUTO_RESTART: "1" } });
		h.mtime.value = 5_000_000;
		vi.advanceTimersByTime(600_000);
		expect(h.spawn).not.toHaveBeenCalled();
		h.dispose();
	});

	it("does not spawn while the artifact mtime is unchanged", () => {
		const h = startWatcher();
		vi.advanceTimersByTime(300_000);
		expect(h.spawn).not.toHaveBeenCalled();
		h.dispose();
	});

	it("spawns `harness restart` via the CLI entry once a newer settled build lands", () => {
		const h = startWatcher();
		// Newer than the recorded start mtime; by the first tick (60s later,
		// fake clock) it is settled well past settleMs.
		h.mtime.value = Date.now() + 1_000;
		vi.advanceTimersByTime(61_000); // first tick: spawns the hand-over
		vi.advanceTimersByTime(61_000); // second tick: absorbed by the throttle
		expect(h.spawn).toHaveBeenCalledTimes(1);
		const [cmd, argv, opts] = nonNull(h.spawn.mock.calls[0]);
		expect(cmd).toBe(process.execPath);
		expect(argv).toEqual(["/repo/dist/index.js", "harness", "restart"]);
		expect(opts.cwd).toBe("/repo");
		expect(opts.detached).toBe(true);
		// The restart is detached and must not inherit this process's stdio — a
		// shared pipe would tie the child's lifetime to the parent's streams.
		expect(opts.stdio).toBe("ignore");
		expect(h.log).toHaveBeenCalledWith(expect.stringContaining("newer build"));
		h.dispose();
	});

	it("throttles re-spawn attempts to one per interval while the restart is pending", () => {
		const h = startWatcher();
		h.mtime.value = Date.now() + 1_000;
		vi.advanceTimersByTime(61_000 * 4);
		// Ticks after the first successful attempt are throttled to ~1/interval,
		// so 4 ticks can spawn at most 2 restarts (initial + one retry).
		expect(h.spawn.mock.calls.length).toBeLessThanOrEqual(2);
		h.dispose();
	});

	it("stops ticking after dispose", () => {
		const h = startWatcher();
		h.dispose();
		h.mtime.value = Date.now() + 1_000;
		vi.advanceTimersByTime(600_000);
		expect(h.spawn).not.toHaveBeenCalled();
	});

	it("registers no interval when the initial artifact stat fails (nothing to watch yet)", () => {
		let call = 0;
		const statMtimeMs = () => {
			call++;
			// The first call captures startedMtimeMs; a null here means the
			// artifact could not be stat'd at all — there is no baseline to
			// compare future polls against, so the watcher must not start.
			return call === 1 ? null : 5_000_000;
		};
		const dispose = startBuildRefreshWatcher({
			moduleUrl: distUrl,
			cwd: "/repo",
			lastActivityMs: () => 0,
			log: vi.fn(),
			env: {},
			deps: { statMtimeMs, spawn: makeSpawn() },
		});
		// A real watcher schedules exactly one interval timer; the early-return
		// path must schedule none, not merely avoid spawning on the next tick.
		expect(vi.getTimerCount()).toBe(0);
		dispose();

		// Same call shape, but the initial stat succeeds — the watcher DOES
		// register exactly one interval timer, proving the 0 above is the
		// null-stat early return, not the watcher never scheduling at all.
		const disposeOk = startBuildRefreshWatcher({
			moduleUrl: distUrl,
			cwd: "/repo",
			lastActivityMs: () => 0,
			log: vi.fn(),
			env: {},
			deps: { statMtimeMs: () => 5_000_000, spawn: makeSpawn() },
		});
		expect(vi.getTimerCount()).toBe(1);
		disposeOk();
	});

	describe("startup staleness warning (real dist/src mtimes on disk — not mocked)", () => {
		function makeRepo(distNewerThanSrc: boolean): string {
			const dir = mkdtempSync(join(tmpdir(), "build-refresh-staleness-"));
			const distDir = join(dir, "dist");
			const srcDir = join(dir, "src");
			mkdirSync(distDir, { recursive: true });
			mkdirSync(srcDir, { recursive: true });
			const distIndex = join(distDir, "index.js");
			const srcFile = join(srcDir, "foo.ts");
			writeFileSync(distIndex, "");
			writeFileSync(srcFile, "");
			const now = Date.now();
			const old = new Date(now - 3_600_000);
			const fresh = new Date(now);
			if (distNewerThanSrc) {
				utimesSync(srcFile, old, old);
				utimesSync(distIndex, fresh, fresh);
			} else {
				utimesSync(distIndex, old, old);
				utimesSync(srcFile, fresh, fresh);
			}
			return dir;
		}

		it("logs the staleness warning once when src/ is newer than the running dist build", () => {
			const dir = makeRepo(false);
			try {
				const log = vi.fn<(message: string) => void>();
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(join(dir, "dist", "harness", "server.js")).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log,
					// Isolate the warning from the hand-over machinery entirely —
					// this test is only about the startup log line.
					env: { INTERLINKED_NO_AUTO_RESTART: "1" },
					deps: { statMtimeMs: () => 1_000, spawn: makeSpawn() },
				});
				expect(log).toHaveBeenCalledTimes(1);
				const [message] = nonNull(log.mock.calls[0]);
				// Content that carries meaning — not the exact sentence — so the
				// test survives a copy edit: it names what's stale and what to run.
				expect(message).toMatch(/STALE BUILD/);
				expect(message).toContain("npm run build");
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not log a staleness warning when the running dist build is already current", () => {
			const dir = makeRepo(true);
			try {
				const log = vi.fn<(message: string) => void>();
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(join(dir, "dist", "harness", "server.js")).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log,
					env: { INTERLINKED_NO_AUTO_RESTART: "1" },
					deps: { statMtimeMs: () => 1_000, spawn: makeSpawn() },
				});
				expect(log).not.toHaveBeenCalled();
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("re-spawn throttle boundary (real ticks, exact counts)", () => {
		// The quiet window alone starves (see the module comment on
		// MAX_STALENESS_MS); this is the OTHER half of that story — once a
		// hand-over is pending, the throttle must re-arm at exactly 2×interval,
		// neither sooner (spamming restarts) nor never (silently giving up).
		it("re-attempts only once the pending window has fully elapsed — spawns on ticks 1,3,5, not 2,4", () => {
			const h = startWatcher();
			h.mtime.value = Date.now() + 1_000;
			const counts: number[] = [];
			for (let i = 0; i < 5; i++) {
				vi.advanceTimersByTime(61_000);
				counts.push(h.spawn.mock.calls.length);
			}
			// Original throttle: `lastAttemptMs !== 0 && elapsed < 2*interval`.
			// The window reopens the instant elapsed reaches exactly 2*interval
			// (a strict `<`, not `<=`), so a hand-over is retried every other
			// tick: spawn, skip, spawn, skip, spawn. Forcing either conjunct to
			// `true`, swapping `&&` for `||`, or loosening `<` to `<=` each
			// collapses this into a different, wrong sequence.
			expect(counts).toEqual([1, 1, 2, 2, 3]);
			h.dispose();
		});
	});

	describe("daemon-ledger integration (real fs — not mocked)", () => {
		it("ledgers the hand-over intent with the fields the cold-block explainer depends on", () => {
			const dir = mkdtempSync(join(tmpdir(), "build-refresh-ledger-"));
			try {
				const mtimeValue = Date.now() + 1_000;
				// First stat call captures startedMtimeMs (the daemon's own build);
				// every later poll must read a NEWER value, or the artifact never
				// looks newer than the one this "daemon" started from.
				let calls = 0;
				const statMtimeMs = () => (calls++ === 0 ? 1_000 : mtimeValue);
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(join(dir, "dist", "harness", "server.js")).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log: vi.fn(),
					env: {},
					deps: {
						statMtimeMs,
						spawn: makeSpawn(),
					},
				});
				vi.advanceTimersByTime(61_000);
				const ledgerFile = join(dir, ".interlinked", "daemon-events.jsonl");
				const lines = readFileSync(ledgerFile, "utf-8").trim().split("\n");
				expect(lines.length).toBeGreaterThan(0);
				// SAFETY: length just asserted above; exactly one tick elapsed, so
				// exactly one ledger line is expected, and the last line picks it
				// regardless.
				const lastLine = nonNull(lines[lines.length - 1]);
				const evt = parseWire(JSON.parse(lastLine), wireRecord(wireUnknown), "test JSON value");
				// These are exactly the fields `describeLastExit` (daemon-ledger.ts)
				// reads to turn a bare SIGTERM exit into "handed over to a newer
				// build — normal after a rebuild" instead of an unexplained outage.
				expect(evt.event).toBe("handover");
				expect(evt.reason).toBe("build-refresh");
				expect(evt.pid).toBe(process.pid);
				expect(typeof evt.at).toBe("number");
				expect(evt.detail).toBe(`artifact ${new Date(mtimeValue).toISOString()}`);
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("backs off instead of spawning once the handover churn backstop trips", () => {
			const dir = mkdtempSync(join(tmpdir(), "build-refresh-churn-"));
			try {
				mkdirSync(join(dir, ".interlinked"), { recursive: true });
				const ledgerFile = join(dir, ".interlinked", "daemon-events.jsonl");
				const nowMs = Date.now();
				const seedLines = churnedEvents(nowMs)
					.map((e) => JSON.stringify(e))
					.join("\n");
				writeFileSync(ledgerFile, `${seedLines}\n`);

				const mtimeValue = nowMs + 1_000;
				let calls = 0;
				const statMtimeMs = () => (calls++ === 0 ? 1_000 : mtimeValue);
				const spawn = makeSpawn();
				const log = vi.fn<(message: string) => void>();
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(join(dir, "dist", "harness", "server.js")).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log,
					env: {},
					deps: { statMtimeMs, spawn },
				});
				vi.advanceTimersByTime(61_000);

				expect(spawn).not.toHaveBeenCalled();
				expect(log.mock.calls.flat().join(" ")).toContain("churn backstop");
				const lines = readFileSync(ledgerFile, "utf-8").trim().split("\n");
				const lastLine = nonNull(lines[lines.length - 1]);
				const evt = parseWire(JSON.parse(lastLine), wireRecord(wireUnknown), "test JSON value");
				expect(evt.event).toBe("handover");
				expect(evt.reason).toBe("churn-backstop");
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("records spawn_failed against the same attempt id when the successor cannot be launched", () => {
			const dir = mkdtempSync(join(tmpdir(), "build-refresh-spawnfail-"));
			try {
				const mtimeValue = Date.now() + 1_000;
				let calls = 0;
				const statMtimeMs = () => (calls++ === 0 ? 1_000 : mtimeValue);
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(join(dir, "dist", "harness", "server.js")).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log: vi.fn(),
					env: {},
					deps: {
						statMtimeMs,
						// A real spawn failure (EAGAIN / ENOENT on the CLI entry) throws
						// synchronously; the watcher must ledger it, not crash the tick.
						spawn: (() => {
							throw new Error("EAGAIN: resource temporarily unavailable");
						}),
					},
				});
				vi.advanceTimersByTime(61_000);

				const ledgerFile = join(dir, ".interlinked", "daemon-events.jsonl");
				const rows = readFileSync(ledgerFile, "utf-8")
					.trim()
					.split("\n")
					.map((line) => parseWire(JSON.parse(line), wireRecord(wireUnknown), "test JSON value"));
				expect(rows.map((r) => r.outcome)).toEqual(["requested", "spawn_failed"]);
				// Both rows must carry ONE id, or the churn reducer cannot pair the
				// failure with the intent and the attempt stays pending forever.
				expect(rows[1]?.attempt_id).toBe(rows[0]?.attempt_id);
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("coalesces onto an unresolved handover for the same artifact instead of spawning a second successor", () => {
			const dir = mkdtempSync(join(tmpdir(), "build-refresh-coalesce-"));
			try {
				const nowMs = Date.now();
				const mtimeValue = nowMs + 1_000;
				const detail = `artifact ${new Date(mtimeValue).toISOString()}`;
				mkdirSync(join(dir, ".interlinked"), { recursive: true });
				const ledgerFile = join(dir, ".interlinked", "daemon-events.jsonl");
				// One in-flight attempt for THIS artifact, left by a sibling daemon.
				const inFlight: DaemonLedgerEvent = {
					at: nowMs - 1_000,
					pid: 1,
					event: "handover",
					reason: "build-refresh",
					detail,
				};
				writeFileSync(ledgerFile, `${JSON.stringify(inFlight)}\n`);

				let calls = 0;
				const statMtimeMs = () => (calls++ === 0 ? 1_000 : mtimeValue);
				const spawn = makeSpawn();
				const log = vi.fn<(message: string) => void>();
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(join(dir, "dist", "harness", "server.js")).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log,
					env: {},
					deps: { statMtimeMs, spawn },
				});
				vi.advanceTimersByTime(61_000);

				expect(spawn).not.toHaveBeenCalled();
				expect(log).toHaveBeenCalledWith(
					`[build-refresh] handover for ${detail} already in flight — coalescing (no second successor).`,
				);
				// Coalescing writes NO row: a second `requested` would read as a
				// second pending attempt and walk the churn backstop toward tripping.
				expect(readFileSync(ledgerFile, "utf-8")).toBe(`${JSON.stringify(inFlight)}\n`);
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe("real statMtimeMs (no deps override — hits defaultStatMtimeMs)", () => {
		it("polls a real on-disk artifact and spawns once it is newer and settled", () => {
			const dir = mkdtempSync(join(tmpdir(), "build-refresh-realstat-"));
			try {
				const distDir = join(dir, "dist", "harness");
				mkdirSync(distDir, { recursive: true });
				const artifactPath = join(distDir, "server.js");
				const old = new Date(Date.now() - 3_600_000);
				writeFileSync(artifactPath, "");
				utimesSync(artifactPath, old, old);

				const spawn = makeSpawn();
				const log = vi.fn<(message: string) => void>();
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(artifactPath).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log,
					env: {},
					deps: { spawn },
				});

				// Bump the artifact's mtime forward — the watcher must observe
				// this via the REAL statSync (defaultStatMtimeMs), not a mock.
				const fresh = new Date();
				utimesSync(artifactPath, fresh, fresh);
				vi.advanceTimersByTime(61_000);

				expect(spawn).toHaveBeenCalledTimes(1);
				const call = spawn.mock.calls[0];
				if (call === undefined) throw new Error("spawn was not called");
				const [cmd, argv, opts] = call;
				expect(cmd).toBe(process.execPath);
				// resolveOwnArtifact derives the CLI entry from the dist/harness/*.js
				// artifact path — .../dist/harness/server.js -> .../dist/index.js.
				expect(argv).toEqual([join(dir, "dist", "index.js"), "harness", "restart"]);
				expect(opts.cwd).toBe(dir);
				expect(opts.detached).toBe(true);
				expect(opts.stdio).toBe("ignore");
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("does not throw and simply stops polling when the artifact disappears mid-run", () => {
			const dir = mkdtempSync(join(tmpdir(), "build-refresh-realstat-missing-"));
			try {
				const distDir = join(dir, "dist", "harness");
				mkdirSync(distDir, { recursive: true });
				const artifactPath = join(distDir, "server.js");
				writeFileSync(artifactPath, "");

				const spawn = makeSpawn();
				const dispose = startBuildRefreshWatcher({
					moduleUrl: pathToFileURL(artifactPath).href,
					cwd: dir,
					lastActivityMs: () => 0,
					log: vi.fn(),
					env: {},
					deps: { spawn },
				});

				// Removing the artifact makes the next defaultStatMtimeMs() poll
				// hit its catch branch (statSync throws ENOENT) and return null.
				rmSync(artifactPath, { force: true });
				vi.advanceTimersByTime(61_000);

				expect(spawn).not.toHaveBeenCalled();
				dispose();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
