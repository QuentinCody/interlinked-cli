import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireNullable, wireNumber, wireObject, wireOptional, wireString } from "../lib/value-validation.js";
// ===========================================
// interlinked harness — behavioral coverage
// ===========================================
// Drives every branch of the five exported lifecycle command handlers in
// ./harness.ts (start / stop / restart / status / test). The handlers compose
// helpers from two sibling modules plus node:fs / node:child_process; every one
// of those boundaries is mocked so each branch is scripted deterministically
// with zero real process spawning, socket I/O, or signal delivery:
//   - ./harness-process.js        → isHarnessRunning / reapOrphanHarnesses /
//                                    getHarnessServerPath / dist-fresh / stderr-log
//   - ./harness-status-helpers.js → parseHarnessProtocol / queryHarness /
//                                    expectedSocketPaths / status readers
//   - ../harness/build-staleness  → distStaleness / stalenessWarning
//   - ../lib/formatter            → identity c.* + header/kvLine (assert raw text)
//   - node:fs                     → existsSync / unlinkSync
//   - node:child_process          → spawn (FakeChild EventEmitter)
//   - process.kill                → spied; signal delivery scripted per test
// We assert the real emitted strings (console.log / console.error), the JSON
// shape under --json, process.exit / process.exitCode side-effects, and EVERY
// branch (already-running, missing-server, daemon vs foreground, ready vs
// crashed vs timed-out, SIGTERM→SIGKILL escalation, stale-file cleanup,
// blocked-vs-allowed test decisions, and the --json / --short / --full modes).
//
// Fake timers make the handlers' `await new Promise(setTimeout(...))` poll
// loops resolve instantly; each test that awaits a handler drives the clock
// via a helper that races the handler against repeated timer flushes.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- hoisted mock fns -------------------------------------------------
const mocks = vi.hoisted(() => ({
	// node:fs
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	// node:child_process
	spawn: vi.fn(),
	// build-staleness
	distStaleness: vi.fn(),
	stalenessWarning: vi.fn(),
	// harness-process
	isHarnessRunning: vi.fn(),
	reapOrphanHarnesses: vi.fn(),
	ensureDistFresh: vi.fn(),
	getHarnessServerPath: vi.fn(),
	getSocketPath: vi.fn(),
	getPidPath: vi.fn(),
	openDaemonStderrLog: vi.fn(),
	closeDaemonStderrLog: vi.fn(),
	readDaemonStderrLog: vi.fn(),
	// harness-status-helpers
	parseHarnessProtocol: vi.fn(),
	queryHarness: vi.fn(),
	expectedSocketPaths: vi.fn(),
	readActiveMode: vi.fn(),
	readLastLatencyTimestamp: vi.fn(),
	readProtocolStatus: vi.fn(),
	readFramedSocketStatuses: vi.fn(),
	readRssMb: vi.fn(),
	getFramedSocketPath: vi.fn(),
	// startup mutex + daemon control (2026-08-15 restart-storm fix)
	acquireStartupLock: vi.fn(),
	waitForDaemonSocket: vi.fn(),
	startupInFlight: vi.fn(),
	touchStartupLock: vi.fn(),
	touchStartupLockHolder: vi.fn(),
	transferStartupLock: vi.fn(),
	reapOrphanHarnessesVerified: vi.fn(),
	stopAllDaemons: vi.fn(),
	recordDaemonEvent: vi.fn(),
	readRecentDaemonEvents: vi.fn(),
	recordInheritedDaemonSpawn: vi.fn(),
	lockRelease: vi.fn(),
	classifyDaemonSocket: vi.fn(),
	isDaemonSocketReady: vi.fn(),
	readHarnessProcessIdentity: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	readFileSync: mocks.readFileSync,
	unlinkSync: mocks.unlinkSync,
}));

vi.mock("../harness/daemon-process-identity.js", () => ({
	readHarnessProcessIdentity: mocks.readHarnessProcessIdentity,
}));

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

// The startup mutex: `harness start` takes it, losers wait instead of binding.
vi.mock("../harness/startup-lock.js", () => ({
	acquireStartupLock: mocks.acquireStartupLock,
	waitForDaemonSocket: mocks.waitForDaemonSocket,
	startupInFlight: mocks.startupInFlight,
	touchStartupLock: mocks.touchStartupLock,
	touchStartupLockHolder: mocks.touchStartupLockHolder,
	transferStartupLock: mocks.transferStartupLock,
}));

vi.mock("../harness/session-paths.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../harness/session-paths.js")>()),
	classifyDaemonSocket: mocks.classifyDaemonSocket,
	isDaemonSocketReady: mocks.isDaemonSocketReady,
}));

// Liveness-verified reaping + complete stop.
vi.mock("./harness-daemon-control.js", () => ({
	reapOrphanHarnessesVerified: mocks.reapOrphanHarnessesVerified,
	stopAllDaemons: mocks.stopAllDaemons,
	collectServingDaemonPids: vi.fn(),
}));

vi.mock("../harness/daemon-ledger.js", () => ({
	recordDaemonEvent: mocks.recordDaemonEvent,
	readRecentDaemonEvents: mocks.readRecentDaemonEvents,
}));

vi.mock("../harness/handover-churn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../harness/handover-churn.js")>()),
	recordInheritedDaemonSpawn: mocks.recordInheritedDaemonSpawn,
}));

vi.mock("../harness/build-staleness.js", () => ({
	distStaleness: mocks.distStaleness,
	stalenessWarning: mocks.stalenessWarning,
}));

vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		red: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
		cyan: (s: string) => s,
		blue: (s: string) => s,
	},
	header: (title: string) => `## ${title}`,
	kvLine: (key: string, value: string) => `${key}: ${value}`,
}));

vi.mock("./harness-process.js", () => ({
	isHarnessRunning: mocks.isHarnessRunning,
	reapOrphanHarnesses: mocks.reapOrphanHarnesses,
	ensureDistFresh: mocks.ensureDistFresh,
	getHarnessServerPath: mocks.getHarnessServerPath,
	getSocketPath: mocks.getSocketPath,
	getPidPath: mocks.getPidPath,
	getFramedSocketPath: mocks.getFramedSocketPath,
	openDaemonStderrLog: mocks.openDaemonStderrLog,
	closeDaemonStderrLog: mocks.closeDaemonStderrLog,
	readDaemonStderrLog: mocks.readDaemonStderrLog,
	// re-exported public surface (callable identities, unused by the handlers)
	collectAncestorPids: vi.fn(),
	readActiveHarnessPid: vi.fn(),
}));

vi.mock("./harness-status-helpers.js", () => ({
	parseHarnessProtocol: mocks.parseHarnessProtocol,
	queryHarness: mocks.queryHarness,
	// The liveness probe now queries by explicit socket path (framed-aware,
	// review 2026-08-26); route it to the same mock so call-count expectations
	// keep meaning "one probe".
	queryHarnessSocket: mocks.queryHarness,
	expectedSocketPaths: mocks.expectedSocketPaths,
	readActiveMode: mocks.readActiveMode,
	readLastLatencyTimestamp: mocks.readLastLatencyTimestamp,
	readProtocolStatus: mocks.readProtocolStatus,
	readFramedSocketStatuses: mocks.readFramedSocketStatuses,
	readRssMb: mocks.readRssMb,
}));

import {
	harnessRestartCommand,
	harnessStartCommand,
	harnessStatusCommand,
	harnessStopCommand,
	harnessTestCommand,
} from "./harness.js";

// ---- fake child process ------------------------------------------------
interface FakeChild extends EventEmitter {
	pid: number;
	unref: ReturnType<typeof vi.fn>;
}

function createFakeChild(pid = 4321): FakeChild {
	return Object.assign(new EventEmitter(), { pid, unref: vi.fn() });
}

// ---- output capture ----------------------------------------------------
let logs: string[];
let errs: string[];
let stderrChunks: string[];

function logText(): string {
	return logs.join("\n");
}
function errText(): string {
	return errs.join("\n");
}
function stderrText(): string {
	return stderrChunks.join("");
}

// ---- driving the clock through a handler's poll loops ------------------
// Handlers `await new Promise(setTimeout(...))` inside `while` loops. With
// fake timers those promises never resolve unless we advance the clock. We
// run the handler and, in parallel, repeatedly flush pending timers until the
// handler settles.
async function runWithTimers(p: Promise<void>): Promise<void> {
	let done = false;
	const settled = p.then(
		() => {
			done = true;
		},
		(err: unknown) => {
			done = true;
			throw err;
		},
	);
	// Yield once so the handler reaches its first await, then pump timers.
	for (let i = 0; i < 5000 && !done; i++) {
		// Flush any micro-tasks first, then advance fake time enough to fire
		// the longest poll interval used by the handlers (500ms).
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(500);
	}
	await settled;
}

const SERVER = "/repo/dist/harness/server.js";
const SOCK = "/repo/.interlinked/harness.sock";
const PID = "/repo/.interlinked/harness.pid";

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockReset();
	logs = [];
	errs = [];
	stderrChunks = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	});
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
		return true;
	}));
	vi.spyOn(process, "cwd").mockReturnValue("/repo");

	// Sensible defaults the individual tests override as needed.
	mocks.parseHarnessProtocol.mockImplementation((raw: string | undefined) =>
		raw === "raw" || raw === "framed" || raw === "dual" ? raw : "dual",
	);
	mocks.getSocketPath.mockReturnValue(SOCK);
	mocks.getPidPath.mockReturnValue(PID);
	mocks.getHarnessServerPath.mockReturnValue(SERVER);
	mocks.expectedSocketPaths.mockReturnValue([SOCK]);
	mocks.classifyDaemonSocket.mockResolvedValue("absent");
	mocks.isDaemonSocketReady.mockImplementation(async (socketPath: string) =>
		mocks.existsSync(socketPath),
	);
	mocks.readFileSync.mockReturnValue("777");
	mocks.readHarnessProcessIdentity.mockReturnValue({
		bootId: "boot",
		startId: "start",
	});
	mocks.reapOrphanHarnesses.mockReturnValue({ candidates: [], killed: [], dryRun: false });
	// The verified sweep delegates to the same mock, so existing assertions on
	// reap arguments keep their meaning.
	mocks.reapOrphanHarnessesVerified.mockImplementation((cwd: string, opts?: unknown) =>
		Promise.resolve(
			opts === undefined ? mocks.reapOrphanHarnesses(cwd) : mocks.reapOrphanHarnesses(cwd, opts),
		),
	);
	// Default: this process WINS the startup mutex (the single-binder path).
	mocks.acquireStartupLock.mockReturnValue({
		acquired: true,
		path: "/repo/.interlinked/.harness-start.lock",
		release: mocks.lockRelease,
	});
	mocks.transferStartupLock.mockReturnValue(true);
	mocks.waitForDaemonSocket.mockResolvedValue(false);
	// Default: no OTHER start is in flight — `harnessRestartCommand`'s
	// `resolveRestartAction` pre-flight takes the "proceed" branch, matching
	// every existing restart test's expectations unchanged.
	mocks.startupInFlight.mockReturnValue(false);
	mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
	mocks.readRecentDaemonEvents.mockReturnValue([]);
	mocks.openDaemonStderrLog.mockReturnValue({ fd: 7, path: "/repo/.interlinked/logs/daemon.log", startOffset: 0 });
	mocks.readDaemonStderrLog.mockReturnValue("");
	mocks.distStaleness.mockReturnValue(null);
	mocks.stalenessWarning.mockReturnValue(null);
	mocks.readActiveMode.mockReturnValue(null);
	mocks.readLastLatencyTimestamp.mockReturnValue(null);
	mocks.readProtocolStatus.mockReturnValue(null);
	mocks.readFramedSocketStatuses.mockResolvedValue([]);
	mocks.readRssMb.mockReturnValue(null);
	mocks.queryHarness.mockResolvedValue(null);

	vi.useFakeTimers();
});

afterEach(() => {
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	process.exitCode = 0;
});

// ===========================================================================
// harnessStartCommand
// ===========================================================================

describe("harnessStartCommand", () => {
	it("treats an answering socket with a missing pid file as already running", async () => {
		mocks.existsSync.mockImplementation((path: unknown) => String(path) === SOCK);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		mocks.isHarnessRunning.mockReturnValue({ running: false });

		await harnessStartCommand({ daemon: true });

		expect(logText()).toContain("Harness already running (socket answered; pid file unavailable)");
		expect(mocks.reapOrphanHarnessesVerified).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
	});

	it("reaps and replaces a pid-live daemon that does not answer the protocol", async () => {
		mocks.existsSync.mockImplementation((path: unknown) => {
			const value = String(path);
			return value === SOCK || value === SERVER;
		});
		mocks.queryHarness.mockResolvedValue(null);
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1234 });
		mocks.reapOrphanHarnesses.mockReturnValue({ candidates: [], killed: [999], dryRun: false });
		mocks.spawn.mockReturnValue(createFakeChild(1234));

		await runWithTimers(harnessStartCommand({}));

		expect(mocks.reapOrphanHarnessesVerified).toHaveBeenCalledWith("/repo", { killAll: true });
		expect(mocks.spawn).toHaveBeenCalledOnce();
		expect(logText()).toContain("Harness started (PID 1234)");
	});

	it("reports already-running in JSON mode", async () => {
		mocks.existsSync.mockImplementation((path: unknown) => String(path) === SOCK);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 42 });
		await runWithTimers(harnessStartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "pid": wireNumber }), "test JSON value");
		expect(parsed.status).toBe("already_running");
		expect(parsed.pid).toBe(42);
	});

	it("errors when the server path resolves but the file is missing", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.getHarnessServerPath.mockReturnValue(SERVER);
		mocks.existsSync.mockReturnValue(false); // server file absent
		await runWithTimers(harnessStartCommand({}));
		expect(errText()).toContain(`Harness server not found at ${SERVER}`);
		expect(process.exitCode).toBe(1);
	});

	it("errors with the generic message when no server path resolves", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.getHarnessServerPath.mockReturnValue("");
		mocks.existsSync.mockReturnValue(false);
		await runWithTimers(harnessStartCommand({}));
		expect(errText()).toContain("Harness server not found. Ensure interlinked-cli is installed");
	});

	it("daemonizes, polls until the socket appears, and reports started", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false }) // initial guard
			.mockReturnValue({ running: true, pid: 1234 }); // after spawn
		// server exists; socket exists immediately so the poll loop exits on
		// its first iteration without awaiting a timer.
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		const child = createFakeChild(1234);
		mocks.spawn.mockReturnValue(child);

		await runWithTimers(harnessStartCommand({ daemon: true, verbose: true }));

		expect(mocks.ensureDistFresh).toHaveBeenCalledOnce();
		expect(mocks.reapOrphanHarnesses).toHaveBeenCalledWith("/repo", { killAll: true });
		expect(mocks.spawn).toHaveBeenCalledOnce();
		const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		expect(spawnArgs).toEqual(expect.arrayContaining(["--protocol", "dual", "--session-id", "default", "--verbose"]));
		expect(spawnArgs.some((a) => a.startsWith("--max-old-space-size="))).toBe(true);
		expect(child.unref).toHaveBeenCalledOnce();
		expect(mocks.closeDaemonStderrLog).toHaveBeenCalledWith({ fd: 7, path: "/repo/.interlinked/logs/daemon.log", startOffset: 0 });
		expect(logText()).toContain("Harness started (PID 1234)");
	});

	it("honors INTERLINKED_HARNESS_HEAP_MB override in the spawn args", async () => {
		const prev = process.env.INTERLINKED_HARNESS_HEAP_MB;
		const prevRss = process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
		process.env.INTERLINKED_HARNESS_HEAP_MB = "2048";
		process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = "3072";
		try {
			mocks.isHarnessRunning
				.mockReturnValueOnce({ running: false })
				.mockReturnValue({ running: true, pid: 1 });
			mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
			mocks.spawn.mockReturnValue(createFakeChild(1));
			await runWithTimers(harnessStartCommand({ daemon: true }));
			const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
			expect(spawnArgs[0]).toBe("--max-old-space-size=2048");
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_HARNESS_HEAP_MB;
			else process.env.INTERLINKED_HARNESS_HEAP_MB = prev;
			if (prevRss === undefined) delete process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
			else process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = prevRss;
		}
	});

	it.each(["0", "-1", "Infinity", "NaN", "0.5"])(
		"falls back to the safe heap default for invalid override %s",
		async (invalidHeap) => {
			const prev = process.env.INTERLINKED_HARNESS_HEAP_MB;
			process.env.INTERLINKED_HARNESS_HEAP_MB = invalidHeap;
			try {
				mocks.isHarnessRunning
					.mockReturnValueOnce({ running: false })
					.mockReturnValue({ running: true, pid: 1 });
				mocks.existsSync.mockImplementation((p: unknown) =>
					String(p) === SERVER || String(p) === SOCK,
				);
				mocks.spawn.mockReturnValue(createFakeChild(1));
				await runWithTimers(harnessStartCommand({ daemon: true }));
				const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
				expect(spawnArgs[0]).toBe("--max-old-space-size=1536");
			} finally {
				if (prev === undefined) delete process.env.INTERLINKED_HARNESS_HEAP_MB;
				else process.env.INTERLINKED_HARNESS_HEAP_MB = prev;
			}
		},
	);

	it("never unlinks a raw socket before the child verifies the incumbent", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 5 });
		// A live incumbent may have lost only its pid file. Parent-side cleanup
		// would deafen it; the child-side anti-stomp check owns this pathname.
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(5));
		await runWithTimers(harnessStartCommand({ daemon: true }));
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
	});

	it("does not attempt parent-side socket cleanup even when unlink would fail", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 6 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.unlinkSync.mockImplementation(() => {
			throw new Error("EBUSY");
		});
		mocks.spawn.mockReturnValue(createFakeChild(6));
		await runWithTimers(harnessStartCommand({ daemon: true }));
		expect(logText()).toContain("Harness started (PID 6)");
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
	});

	it("skips the raw-socket unlink for the framed protocol", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 7 });
		mocks.expectedSocketPaths.mockReturnValue([SOCK]);
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(7));
		await runWithTimers(harnessStartCommand({ daemon: true, protocol: "framed" }));
		expect(mocks.unlinkSync).not.toHaveBeenCalled();
		const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		// framed is non-raw, so --session-id is appended
		expect(spawnArgs).toEqual(expect.arrayContaining(["--protocol", "framed", "--session-id", "default"]));
	});

	it("omits --session-id for the raw protocol", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 8 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(8));
		await runWithTimers(harnessStartCommand({ daemon: true, protocol: "raw", sessionId: "ignored" }));
		const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		expect(spawnArgs).not.toContain("--session-id");
		expect(spawnArgs).toEqual(expect.arrayContaining(["--protocol", "raw"]));
	});

	it("reports a crash with captured stderr when the child exits before the socket appears", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		// server exists, socket never appears
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER);
		mocks.readDaemonStderrLog.mockReturnValue("boom: module not found\n");
		const child = createFakeChild();
		// Emit exit AFTER spawn returns (the handler attaches its listener
		// synchronously right after), so the poll loop observes childExited.
		mocks.spawn.mockImplementation(() => {
			queueMicrotask(() => child.emit("exit", 1));
			return child;
		});
		await runWithTimers(harnessStartCommand({ daemon: true }));
		expect(logText()).toContain("Failed to start harness");
		expect(logText()).toContain("Error output:");
		expect(logText()).toContain("boom: module not found");
	});

	it("reports a crash with no output when the child exits silently", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER);
		mocks.readDaemonStderrLog.mockReturnValue("");
		const child = createFakeChild();
		mocks.spawn.mockImplementation(() => {
			queueMicrotask(() => child.emit("exit", 0));
			return child;
		});
		await runWithTimers(harnessStartCommand({ daemon: true }));
		expect(logText()).toContain("Process exited without output.");
	});

	it("daemon-start JSON failure payload when socket never appears and child never exits", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER);
		mocks.spawn.mockReturnValue(createFakeChild());
		await runWithTimers(harnessStartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "protocol": wireString }), "test JSON value");
		expect(parsed.status).toBe("failed");
		expect(parsed.protocol).toBe("dual");
		// running-but-no-socket path emits the "foreground" hint
		// (covered indirectly by the success/json assertions).
	});

	it("daemon-start JSON success payload when socket appears", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 77 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(77));
		await runWithTimers(harnessStartCommand({ json: true }));
		expect(mocks.ensureDistFresh).toHaveBeenCalledWith({ quiet: true });
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "pid": wireNumber, "sockets": wireArray(wireString) }), "test JSON value");
		expect(parsed.status).toBe("started");
		expect(parsed.pid).toBe(77);
		expect(parsed.sockets).toEqual([SOCK]);
	});

	it("falls back to child.pid when isHarnessRunning has no pid after start", async () => {
		// running:false guard, then running:false again so resolvedPid uses child.pid
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(2468));
		await runWithTimers(harnessStartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "pid": wireNumber }), "test JSON value");
		// socket appeared → ready:true; pid falls back to child.pid (2468)
		expect(parsed.status).toBe("started");
		expect(parsed.pid).toBe(2468);
	});

	it("reports the running-but-no-socket hint in normal mode", async () => {
		// guard false, then running:true but socket never exists → ready stays
		// false, childExited stays false → the "Process is running" hint branch.
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 33 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER);
		mocks.spawn.mockReturnValue(createFakeChild(33));
		await runWithTimers(harnessStartCommand({ daemon: true }));
		expect(logText()).toContain("Process is running but socket not created");
	});

	it("foreground mode execs directly and wires the exit handler", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER);
		const child = createFakeChild();
		mocks.spawn.mockReturnValue(child);
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => { throw new Error("foreground exit"); });
		await runWithTimers(harnessStartCommand({ daemon: false }));
		expect(logText()).toContain("Starting harness in foreground");
		expect(mocks.spawn).toHaveBeenCalledWith(
			process.execPath,
			expect.any(Array),
			expect.objectContaining({ stdio: "inherit", cwd: "/repo" }),
		);
		expect(mocks.transferStartupLock).toHaveBeenCalledWith("/repo", { childPid: 4321 });
		// exit handler maps a numeric code through; null/0 → 0
		expect(() => child.emit("exit", 5)).toThrow("foreground exit");
		expect(exitSpy).toHaveBeenCalledWith(5);
		expect(() => child.emit("exit", null)).toThrow("foreground exit");
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("foreground mode emits the JSON starting_foreground payload", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER);
		mocks.spawn.mockReturnValue(createFakeChild());
		vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("foreground exit"); });
		await runWithTimers(harnessStartCommand({ daemon: false, json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString }), "test JSON value");
		expect(parsed.status).toBe("starting_foreground");
	});

	it("falls back to inherited stderr when the daemon log can't be opened", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 9 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		// openDaemonStderrLog returns null → `stderrLog?.fd ?? "ignore"` takes
		// the nullish-coalescing right-hand path and stdio[2] becomes "ignore".
		mocks.openDaemonStderrLog.mockReturnValue(null);
		mocks.spawn.mockReturnValue(createFakeChild(9));
		await runWithTimers(harnessStartCommand({ daemon: true }));
		expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({
			stdio: ["ignore", "ignore", "ignore"],
		});
		expect(mocks.closeDaemonStderrLog).toHaveBeenCalledWith(null);
	});

	it("catches a thrown error and routes it to outputError", async () => {
		mocks.reapOrphanHarnessesVerified.mockRejectedValue(new Error("ps exploded"));
		await runWithTimers(harnessStartCommand({}));
		expect(errText()).toContain("ps exploded");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error thrown value in the catch path", async () => {
		mocks.reapOrphanHarnessesVerified.mockRejectedValue("raw string failure");
		await runWithTimers(harnessStartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(errText()), wireObject({ "error": wireString }), "test JSON value");
		expect(parsed.error).toBe("raw string failure");
	});
});

// ===========================================================================
// harnessStopCommand
// ===========================================================================

describe("harnessStopCommand", () => {
	it("reports not-running when no daemon is up (normal mode)", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
		await runWithTimers(harnessStopCommand({}));
		expect(logText()).toContain("Harness is not running.");
	});

	it("reports not-running in JSON when nothing was found to stop", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
		await runWithTimers(harnessStopCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString }), "test JSON value");
		expect(parsed.status).toBe("not_running");
	});

	// The 2026-08-15 gap: `interlinked disable` stopped the pid-file daemon and
	// left TWO orphans running. A stop must be complete.
	it("stops EVERY daemon for the repo, not just the pid-file one", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [555, 556, 557], survived: [] });
		await runWithTimers(harnessStopCommand({}));
		// An explicit STOP keeps the default ancestor sparing (only the RESTART
		// path opts out — its CLI is spawned by the daemon it must replace).
		expect(mocks.stopAllDaemons).toHaveBeenCalledWith("/repo");
		expect(logText()).toContain("555, 556, 557");
	});

	it("reports a daemon that survives the built-in SIGKILL escalation", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [666] });
		await runWithTimers(harnessStopCommand({}));
		expect(logText()).toContain("PID(s) 666 survived SIGKILL");
		expect(logText()).toContain("Investigate process permissions or kernel state manually");
	});

	it("emits the stopped JSON payload", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [777], survived: [] });
		await runWithTimers(harnessStopCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "pids": wireArray(wireNumber) }), "test JSON value");
		expect(parsed.status).toBe("stopped");
		expect(parsed.pids).toEqual([777]);
	});

	it("emits the still_running JSON payload", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [888] });
		await runWithTimers(harnessStopCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString }), "test JSON value");
		expect(parsed.status).toBe("still_running");
	});

	it("routes a kill failure to outputError", async () => {
		mocks.stopAllDaemons.mockRejectedValue(new Error("EPERM"));
		await runWithTimers(harnessStopCommand({}));
		expect(errText()).toContain("EPERM");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error thrown value in the catch path", async () => {
		mocks.stopAllDaemons.mockRejectedValue("kill string failure");
		await runWithTimers(harnessStopCommand({}));
		expect(errText()).toContain("kill string failure");
	});
});

// ===========================================================================
// Startup mutex — the restart-storm fix (2026-08-15)
// ===========================================================================

describe("harnessStartCommand — startup mutex", () => {
	it("P: a lock LOSER neither reaps nor spawns; it waits and reports", async () => {
		mocks.acquireStartupLock.mockReturnValue({ acquired: false, holder: { pid: 4242, at: 1 } });
		mocks.waitForDaemonSocket.mockResolvedValue(true);
		await runWithTimers(harnessStartCommand({}));
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.reapOrphanHarnessesVerified).not.toHaveBeenCalled();
		expect(logText()).toContain("already running");
	});

	it("P: a loser whose winner has not answered yet says start pending, not failure", async () => {
		mocks.acquireStartupLock.mockReturnValue({ acquired: false, holder: { pid: 4242, at: 1 } });
		mocks.waitForDaemonSocket.mockResolvedValue(false);
		await runWithTimers(harnessStartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "starter_pid": wireNumber }), "test JSON value");
		expect(parsed.status).toBe("start_pending");
		expect(parsed.starter_pid).toBe(4242);
	});

	it("N: the winner releases the lock when the command finishes", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 42 });
		await runWithTimers(harnessStartCommand({}));
		expect(mocks.lockRelease).toHaveBeenCalledWith();
	});

	it("N: the reaper the winner runs is the liveness-VERIFIED one", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 42 });
		await runWithTimers(harnessStartCommand({}));
		expect(mocks.reapOrphanHarnessesVerified).toHaveBeenCalledWith("/repo", { killAll: true });
	});
});

// ===========================================================================
// harnessRestartCommand
// ===========================================================================

describe("harnessRestartCommand — restart-guard pre-flight (2026-08-22 postmortem)", () => {
	it("defers to an in-flight start that comes up: no stop, no spawn, no throttle collapse", async () => {
		mocks.startupInFlight.mockReturnValue(true);
		mocks.waitForDaemonSocket.mockResolvedValue(true);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		await runWithTimers(harnessRestartCommand({}));
		expect(killSpy).not.toHaveBeenCalled();
		expect(mocks.stopAllDaemons).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(logText()).toContain("already in flight");
		expect(mocks.recordDaemonEvent).toHaveBeenCalledWith(
			"/repo",
			expect.objectContaining({ event: "handover", reason: "deferred-to-inflight" }),
		);
	});

	it("falls through to a real restart when the in-flight holder never answers (wedged)", async () => {
		mocks.startupInFlight.mockReturnValue(true);
		mocks.waitForDaemonSocket.mockResolvedValue(false);
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false }) // restart guard
			.mockReturnValueOnce({ running: false }) // socket cleanup
			.mockReturnValueOnce({ running: false }) // pid cleanup
			.mockReturnValueOnce({ running: false }) // start guard
			.mockReturnValue({ running: true, pid: 777 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(777));
		await runWithTimers(harnessRestartCommand({}));
		expect(mocks.recordDaemonEvent).toHaveBeenCalledWith(
			"/repo",
			expect.objectContaining({ event: "handover", reason: "deferred-timeout" }),
		);
		// Still reached the normal restart path afterward.
		expect(logText()).toContain("Harness started (PID 777)");
	});

	it("backs off under the churn backstop instead of killing or spawning anything", async () => {
		mocks.startupInFlight.mockReturnValue(false);
		mocks.readRecentDaemonEvents.mockReturnValue(
			Array.from({ length: 4 }, (_, i) => ({
				at: Date.now() - 1_000 + i,
				pid: 1,
				event: "handover" as const,
				reason: "build-refresh",
			})),
		);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		await runWithTimers(harnessRestartCommand({}));
		expect(killSpy).not.toHaveBeenCalled();
		expect(mocks.stopAllDaemons).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(errText()).toContain("Too many restart attempts");
		expect(mocks.recordDaemonEvent).toHaveBeenCalledWith(
			"/repo",
			expect.objectContaining({ event: "handover", reason: "churn-backstop" }),
		);
	});

	it("proceeds normally when nothing is in flight and churn is under threshold (baseline unchanged)", async () => {
		mocks.startupInFlight.mockReturnValue(false);
		mocks.readRecentDaemonEvents.mockReturnValue([]);
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 999 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(999));
		await runWithTimers(harnessRestartCommand({}));
		expect(logText()).toContain("Harness started (PID 999)");
	});
});

describe("harnessRestartCommand", () => {
	it.each([
		{ json: false, label: "normal" },
		{ json: true, label: "JSON" },
	])("$label mode rebuilds before stop and preserves the incumbent when the build fails", async ({ json }) => {
		mocks.ensureDistFresh.mockImplementationOnce(() => {
			throw new Error("Build failed; refusing to start the harness with stale code");
		});
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 404 });

		await runWithTimers(harnessRestartCommand({ json }));

		expect(mocks.ensureDistFresh).toHaveBeenCalledWith({ quiet: json });
		expect(mocks.stopAllDaemons).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(errText()).toContain("refusing to start the harness with stale code");
		expect(process.exitCode).toBe(1);
		expect(mocks.recordInheritedDaemonSpawn).toHaveBeenCalledTimes(1);
		expect(mocks.recordInheritedDaemonSpawn).toHaveBeenCalledWith(
			"/repo",
			"start_failed",
			"restart threw",
		);
	});

	it("when nothing is running, skips the kill path and delegates to start (normal)", async () => {
		// No daemon at any point. Subsequent start path: guard false, then
		// running:true after spawn so it reports started.
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false }) // restart guard
			.mockReturnValueOnce({ running: false }) // socket-cleanup liveness
			.mockReturnValueOnce({ running: false }) // pid-cleanup liveness
			.mockReturnValueOnce({ running: false }) // start guard
			.mockReturnValue({ running: true, pid: 222 }); // post-spawn
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(222));
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		await runWithTimers(harnessRestartCommand({}));
		expect(killSpy).not.toHaveBeenCalled();
		expect(logText()).toContain("Harness started (PID 222)");
	});

	// Finding #22 (2026-08-16): restart's stop phase now delegates to
	// `stopAllDaemons` (raw + framed/session pid files + orphans, ancestor-
	// protected, TERM→KILL escalation owned there and pinned by
	// harness-daemon-control.test.ts). These tests pin the DELEGATION contract,
	// not the kill mechanics.

	it("stops every daemon via stopAllDaemons, then delegates to start (normal)", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: true, pid: 100 }) // restart guard (oldPid capture)
			.mockReturnValueOnce({ running: false }) // socket cleanup liveness
			.mockReturnValueOnce({ running: false }) // pid cleanup liveness
			.mockReturnValueOnce({ running: false }) // start guard
			.mockReturnValue({ running: true, pid: 333 }); // post-spawn
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [100, 101], survived: [] });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(333));
		await runWithTimers(harnessRestartCommand({}));
		expect(mocks.ensureDistFresh).toHaveBeenCalledTimes(1);
		expect(mocks.stopAllDaemons).toHaveBeenCalledWith("/repo", { spareAncestralDaemons: false });
		expect(stderrText()).toContain("Stopped harness (was PID 100, 101)");
		expect(logText()).toContain("Harness started (PID 333)");
	});

	it("stops a FRAMED daemon the raw pid file does not know about (the #22 regression)", async () => {
		// Raw pid file empty → the old single-pid path would have skipped the
		// stop entirely and the fresh start would anti-stomp. The delegation
		// must stop it anyway because stopAllDaemons enumerates session files.
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false }) // restart guard sees no raw daemon
			.mockReturnValueOnce({ running: false }) // socket cleanup liveness
			.mockReturnValueOnce({ running: false }) // pid cleanup liveness
			.mockReturnValueOnce({ running: false }) // start guard
			.mockReturnValue({ running: true, pid: 333 }); // post-spawn
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [4242], survived: [] });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(333));
		await runWithTimers(harnessRestartCommand({}));
		expect(mocks.stopAllDaemons).toHaveBeenCalledWith("/repo", { spareAncestralDaemons: false });
		expect(stderrText()).toContain("Stopped harness (was PID 4242)");
		expect(logText()).toContain("Harness started (PID 333)");
	});

	it("reports the survived-SIGKILL fatal error and aborts before the start path", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 300 });
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [300] });
		await runWithTimers(harnessRestartCommand({}));
		expect(errText()).toContain("survived SIGKILL");
		expect(process.exitCode).toBe(1);
		// Must not have reached the start path.
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("proceeds to start when there was nothing to stop (already-dead daemon)", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false }) // restart guard: nothing raw
			.mockReturnValueOnce({ running: false }) // socket cleanup liveness
			.mockReturnValueOnce({ running: false }) // pid cleanup liveness
			.mockReturnValueOnce({ running: false }) // start guard
			.mockReturnValue({ running: true, pid: 555 }); // post-spawn
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(555));
		await runWithTimers(harnessRestartCommand({}));
		// No stop line for a no-op stop; the start still happens.
		expect(stderrText()).not.toContain("Stopped harness");
		expect(logText()).toContain("Harness started (PID 555)");
	});

	it("cleans up stale socket and pid files on the restart path", async () => {
		vi.spyOn(process, "kill").mockReturnValue(true);
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false }) // guard
			.mockReturnValueOnce({ running: false }) // socket cleanup liveness
			.mockReturnValueOnce({ running: false }) // pid cleanup liveness
			.mockReturnValueOnce({ running: false }) // start guard
			.mockReturnValue({ running: true, pid: 11 });
		// SERVER + SOCK + PID exist so both stale-file cleanup branches fire.
		mocks.existsSync.mockImplementation((p: unknown) => {
			const s = String(p);
			return s === SERVER || s === SOCK || s === PID;
		});
		mocks.spawn.mockReturnValue(createFakeChild(11));
		await runWithTimers(harnessRestartCommand({}));
		expect(mocks.unlinkSync).toHaveBeenCalledWith(SOCK);
		expect(mocks.unlinkSync).toHaveBeenCalledWith(PID);
	});

	it("swallows unlink failures during stale-file cleanup", async () => {
		vi.spyOn(process, "kill").mockReturnValue(true);
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 12 });
		mocks.existsSync.mockImplementation((p: unknown) => {
			const s = String(p);
			return s === SERVER || s === SOCK || s === PID;
		});
		mocks.unlinkSync.mockImplementation(() => {
			throw new Error("EBUSY");
		});
		mocks.spawn.mockReturnValue(createFakeChild(12));
		await runWithTimers(harnessRestartCommand({}));
		// Reached start despite both unlink throws.
		expect(logText()).toContain("Harness started (PID 12)");
	});

	it("JSON mode emits a single combined restarted payload", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: true, pid: 900 }) // guard (oldPid capture)
			.mockReturnValueOnce({ running: false }) // socket cleanup
			.mockReturnValueOnce({ running: false }) // pid cleanup
			.mockReturnValueOnce({ running: false }) // initial newStatus in json block
			.mockReturnValue({ running: true, pid: 901 }); // re-polled → running
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [900], survived: [] });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(901));
		await runWithTimers(harnessRestartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "old_pid": wireNumber, "new_pid": wireNumber, "protocol": wireString, "sockets": wireArray(wireString) }), "test JSON value");
		expect(parsed.status).toBe("restarted");
		expect(parsed.old_pid).toBe(900);
		expect(parsed.new_pid).toBe(901);
		expect(parsed.sockets).toEqual([SOCK]);
		// JSON restart is also the automatic-handover launch path, so it must
		// preserve the canonical heap ceiling and idle-GC capability.
		const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		expect(spawnArgs.slice(0, 3)).toEqual([
			"--max-old-space-size=1536",
			"--expose-gc",
			SERVER,
		]);
	});

	it("JSON mode emits an error payload when the server is missing", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.getHarnessServerPath.mockReturnValue("");
		mocks.existsSync.mockReturnValue(false);
		await runWithTimers(harnessRestartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "message": wireString }), "test JSON value");
		expect(parsed.status).toBe("error");
		expect(parsed.message).toBe("Harness server not found");
		expect(mocks.spawn).not.toHaveBeenCalled();
	});

	it("JSON mode emits a failed payload when the new daemon never comes up", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		// server exists, socket never appears → poll loop times out, failed.
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER);
		mocks.spawn.mockReturnValue(createFakeChild());
		await runWithTimers(harnessRestartCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "old_pid": wireAbsentOptional(wireOptional(wireNumber)) }), "test JSON value");
		expect(parsed.status).toBe("failed");
		expect(parsed.old_pid).toBeUndefined();
	});

	it("JSON-mode restart includes verbose + session-id for non-raw protocol", async () => {
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValueOnce({ running: false })
			.mockReturnValue({ running: true, pid: 1212 });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(1212));
		await runWithTimers(harnessRestartCommand({ json: true, verbose: true, sessionId: "alpha", protocol: "framed" }));
		const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		expect(spawnArgs).toEqual(expect.arrayContaining(["--protocol", "framed", "--session-id", "alpha", "--verbose"]));
	});

	it("JSON mode stops silently (no stderr nudge) and uses raw protocol", async () => {
		// JSON mode: the stop phase's `if (mode === "normal")` guard takes its
		// false branch (no stderr writes). raw protocol also exercises the
		// `protocol !== "raw"` false branch in the inline JSON start.
		mocks.expectedSocketPaths.mockReturnValue([SOCK]);
		mocks.isHarnessRunning
			.mockReturnValueOnce({ running: true, pid: 800 }) // guard (oldPid capture)
			.mockReturnValueOnce({ running: false }) // socket cleanup liveness
			.mockReturnValueOnce({ running: false }) // pid cleanup liveness
			.mockReturnValueOnce({ running: false }) // initial newStatus in json block
			.mockReturnValue({ running: true, pid: 801 }); // re-polled → running
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [800], survived: [] });
		mocks.existsSync.mockImplementation((p: unknown) => String(p) === SERVER || String(p) === SOCK);
		mocks.spawn.mockReturnValue(createFakeChild(801));
		await runWithTimers(harnessRestartCommand({ json: true, protocol: "raw" }));
		// No stderr nudges in JSON mode.
		expect(stderrText()).toBe("");
		const spawnArgs = parseWire(mocks.spawn.mock.calls[0]?.[1], wireArray(wireString), "test JSON value");
		expect(spawnArgs).toContain("raw");
		expect(spawnArgs).not.toContain("--session-id");
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "status": wireString, "old_pid": wireNumber, "new_pid": wireNumber }), "test JSON value");
		expect(parsed.status).toBe("restarted");
		expect(parsed.old_pid).toBe(800);
		expect(parsed.new_pid).toBe(801);
	});

	it("routes an unexpected throw to outputError", async () => {
		mocks.isHarnessRunning.mockImplementation(() => {
			throw new Error("status blew up");
		});
		await runWithTimers(harnessRestartCommand({}));
		expect(errText()).toContain("status blew up");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error thrown value in the catch path", async () => {
		mocks.isHarnessRunning.mockImplementation(() => {
			throw "restart string failure";
		});
		await runWithTimers(harnessRestartCommand({}));
		expect(errText()).toContain("restart string failure");
	});
});

// ===========================================================================
// harnessStatusCommand
// ===========================================================================

describe("harnessStatusCommand", () => {
	it("renders the not-running normal report with the start hint", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockReturnValue(false); // no socket
		await runWithTimers(harnessStatusCommand({}));
		const out = logText();
		expect(out).toContain("## Harness Status");
		expect(out).toContain("Status: not running");
		expect(out).toContain("Socket: not found");
		expect(out).toContain("Start with: interlinked harness start");
		expect(out).toContain("Orphans: 0");
		// No socket → queryHarness must not be invoked.
		expect(mocks.queryHarness).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// Three liveness states (audit F1/F12). "running (PID …)" is now reserved
	// for a VERIFIED round-trip, so it can never sit above "Socket: not found"
	// without the line that explains what that combination means.
	// -----------------------------------------------------------------------

	// P: pid alive, socket silent → ZOMBIE, loudly, with the fix command.
	it("renders the ZOMBIE state when the pid is alive but nothing answers", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		mocks.existsSync.mockReturnValue(true); // socket file present…
		mocks.queryHarness.mockResolvedValue(null); // …but nothing answers
		await runWithTimers(harnessStatusCommand({}));
		const out = logText();
		expect(out).toContain("Status: ZOMBIE — process alive (PID 4242), no socket answering");
		expect(out).toContain("ZOMBIE DAEMON: Harness PID 4242 is alive");
		expect(out).toContain("interlinked harness restart");
		expect(out).not.toContain("Status: running (PID 4242)");
	});

	// P: a framed daemon answering its health RPC counts as listening even
	// with no raw socket — otherwise framed-only installs read as zombies.
	it("counts a healthy framed daemon as listening when the raw socket is absent", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 7 });
		mocks.existsSync.mockReturnValue(false); // no raw socket at all
		mocks.readFramedSocketStatuses.mockResolvedValue([
			{
				session_id: "default",
				pid: 7,
				alive: true,
				socket_path: "/repo/.interlinked/harness-default.sock",
				health: { status: "ok", protocol_version: 9 },
				health_error: null,
			},
		]);
		await runWithTimers(harnessStatusCommand({}));
		const out = logText();
		expect(out).toContain("Status: running (PID 7) — socket answering");
		expect(out).not.toContain("ZOMBIE");
	});

	// P: the JSON surface carries the verdict too, so scripts can act on it.
	it("emits liveness + socket_answered in the JSON payload", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue(null);
		await runWithTimers(harnessStatusCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "running": wireBoolean, "liveness": wireString, "socket_answered": wireBoolean }), "test JSON value");
		expect(parsed.running).toBe(true);
		expect(parsed.liveness).toBe("zombie");
		expect(parsed.socket_answered).toBe(false);
	});

	it("renders a fully-populated running report and queries the socket", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 4242 });
		mocks.existsSync.mockReturnValue(true); // socket present
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		mocks.readRssMb.mockReturnValue(321);
		mocks.readActiveMode.mockReturnValue("quality");
		mocks.readLastLatencyTimestamp.mockReturnValue("2026-06-01T00:00:00Z");
		mocks.reapOrphanHarnesses.mockReturnValue({
			candidates: [{ pid: 1, ppid: 2, command: "node server" }],
			killed: [],
			dryRun: true,
		});
		mocks.stalenessWarning.mockReturnValue("dist is 3 commits behind");
		mocks.distStaleness.mockReturnValue({ stale: true });
		mocks.readProtocolStatus.mockReturnValue({
			protocol: "dual",
			protocol_version: "9",
			started_at: "2026-06-01T00:00:00Z",
			raw_socket_path: "/repo/.interlinked/harness.sock",
			framed_socket_path: "/repo/.interlinked/harness-default.sock",
			framed_session_id: "default",
			last_raw_event_at: "2026-06-01T00:01:00Z",
			last_framed_event_at: "2026-06-01T00:02:00Z",
			raw_event_count: 3,
			framed_event_count: 4,
			framed_error_count: 1,
			framed_timeout_count: 2,
		});
		mocks.readFramedSocketStatuses.mockResolvedValue([
			{
				session_id: "alpha",
				pid: 11,
				alive: true,
				socket_path: "/repo/.interlinked/harness-alpha.sock",
				health: { status: "ok", protocol_version: "9" },
				health_error: null,
			},
		]);

		await runWithTimers(harnessStatusCommand({}));
		const out = logText();
		expect(mocks.queryHarness).toHaveBeenCalledOnce();
		expect(out).toContain("Status: running (PID 4242)");
		expect(out).toContain("Protocol: dual");
		expect(out).toContain("Raw socket: /repo/.interlinked/harness.sock");
		expect(out).toContain("Framed socket: /repo/.interlinked/harness-default.sock");
		expect(out).toContain("Last raw event: 2026-06-01T00:01:00Z");
		expect(out).toContain("Last framed event: 2026-06-01T00:02:00Z");
		expect(out).toContain("Framed errors: 1 errors, 2 timeouts");
		expect(out).toContain("Framed alpha: ok (9) — /repo/.interlinked/harness-alpha.sock");
		expect(out).toContain("RSS: 321 MB");
		expect(out).toContain("Build: dist is 3 commits behind");
		expect(out).toContain("Mode: quality");
		expect(out).toContain("Last event: 2026-06-01T00:00:00Z");
		expect(out).toContain("Orphans: 1 (run 'interlinked harness reap' to inspect)");
		// Running → no "Start with" hint.
		expect(out).not.toContain("Start with: interlinked harness start");
	});

	it("renders a framed socket health-error / unknown fallback", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 1 });
		mocks.existsSync.mockReturnValue(true);
		mocks.readFramedSocketStatuses.mockResolvedValue([
			{
				session_id: "beta",
				pid: null,
				alive: false,
				socket_path: "/repo/.interlinked/harness-beta.sock",
				health: null,
				health_error: "process not alive",
			},
			{
				session_id: "gamma",
				pid: null,
				alive: false,
				socket_path: "/repo/.interlinked/harness-gamma.sock",
				health: null,
				health_error: null, // → "unknown"
			},
		]);
		await runWithTimers(harnessStatusCommand({}));
		const out = logText();
		expect(out).toContain("Framed beta: process not alive — /repo/.interlinked/harness-beta.sock");
		expect(out).toContain("Framed gamma: unknown — /repo/.interlinked/harness-gamma.sock");
	});

	it("omits protocol-status sub-lines when their fields are absent", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 2 });
		mocks.existsSync.mockReturnValue(true);
		mocks.readProtocolStatus.mockReturnValue({
			protocol: "raw",
			protocol_version: "1",
			started_at: "",
			raw_socket_path: null,
			framed_socket_path: null,
			framed_session_id: null,
			last_raw_event_at: null,
			last_framed_event_at: null,
			raw_event_count: 0,
			framed_event_count: 0,
			framed_error_count: 0,
			framed_timeout_count: 0,
		});
		await runWithTimers(harnessStatusCommand({}));
		const out = logText();
		expect(out).toContain("Protocol: raw");
		expect(out).not.toContain("Raw socket:");
		expect(out).not.toContain("Framed socket:");
		expect(out).not.toContain("Last raw event:");
	});

	it("emits the full JSON status payload", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true, pid: 7 });
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ ok: true });
		mocks.readRssMb.mockReturnValue(120);
		mocks.readProtocolStatus.mockReturnValue({
			protocol: "framed",
			protocol_version: "5",
			started_at: "t",
			raw_socket_path: null,
			framed_socket_path: "/s",
			framed_session_id: "default",
			last_raw_event_at: "raw-ts",
			last_framed_event_at: "framed-ts",
			raw_event_count: 0,
			framed_event_count: 0,
			framed_error_count: 9,
			framed_timeout_count: 8,
		});
		await runWithTimers(harnessStatusCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "running": wireBoolean, "pid": wireNumber, "socket": wireBoolean, "raw_socket": wireObject({ "health": wireString }), "protocol_version": wireString, "last_raw_event_at": wireNullable(wireString), "framed_error_count": wireNullable(wireNumber), "rss_mb": wireNullable(wireNumber), "build_stale": wireBoolean }), "test JSON value");
		expect(parsed.running).toBe(true);
		expect(parsed.pid).toBe(7);
		expect(parsed.socket).toBe(true);
		expect(parsed.raw_socket.health).toBe("legacy-raw");
		expect(parsed.protocol_version).toBe("5");
		expect(parsed.last_raw_event_at).toBe("raw-ts");
		expect(parsed.framed_error_count).toBe(9);
		expect(parsed.rss_mb).toBe(120);
		expect(parsed.build_stale).toBe(false);
	});

	it("JSON status nulls out protocol fields and marks the raw socket missing", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.existsSync.mockReturnValue(false);
		await runWithTimers(harnessStatusCommand({ json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "raw_socket": wireObject({ "health": wireString }), "protocol_version": wireNullable(wireString), "framed_error_count": wireNullable(wireNumber), "rss_mb": wireNullable(wireNumber) }), "test JSON value");
		expect(parsed.raw_socket.health).toBe("missing");
		expect(parsed.protocol_version).toBeNull();
		expect(parsed.framed_error_count).toBeNull();
		expect(parsed.rss_mb).toBeNull();
	});

	it("does not read RSS when the daemon is running but pid is undefined", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: true });
		mocks.existsSync.mockReturnValue(true);
		await runWithTimers(harnessStatusCommand({ json: true }));
		expect(mocks.readRssMb).not.toHaveBeenCalled();
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "rss_mb": wireNullable(wireNumber) }), "test JSON value");
		expect(parsed.rss_mb).toBeNull();
	});

	it("routes a status throw to outputError", async () => {
		mocks.isHarnessRunning.mockImplementation(() => {
			throw new Error("status read failed");
		});
		await runWithTimers(harnessStatusCommand({}));
		expect(errText()).toContain("status read failed");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error thrown value in the catch path", async () => {
		mocks.isHarnessRunning.mockImplementation(() => {
			throw "status string failure";
		});
		await runWithTimers(harnessStatusCommand({}));
		expect(errText()).toContain("status string failure");
	});
});

// ===========================================================================
// harnessTestCommand
// ===========================================================================

describe("harnessTestCommand", () => {
	it("reports harness-not-running when no socket exists (normal mode)", async () => {
		mocks.existsSync.mockReturnValue(false);
		await runWithTimers(harnessTestCommand("rm -rf /", {}));
		expect(logText()).toContain("Harness not running. Start with: interlinked harness start");
		expect(mocks.queryHarness).not.toHaveBeenCalled();
	});

	it("reports harness-not-running in JSON when the decision is null", async () => {
		mocks.existsSync.mockReturnValue(true); // socket exists
		mocks.queryHarness.mockResolvedValue(null); // but no response
		await runWithTimers(harnessTestCommand("ls", { json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "error": wireString }), "test JSON value");
		expect(parsed.error).toBe("Harness not running");
	});

	it("renders an ALLOWED decision and leaves exitCode at 0 (default tool=Bash)", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		await runWithTimers(harnessTestCommand("ls -la", {}));
		const out = logText();
		expect(out).toContain("ALLOWED");
		expect(out).toContain("Bash:");
		expect(out).toContain("ls -la");
		expect(process.exitCode).toBe(0);
		// default tool is Bash → tool_input carries `command`
		const event = parseWire(mocks.queryHarness.mock.calls[0]?.[1], wireObject({ "tool_name": wireString, "tool_input": wireObject({ "command": wireAbsentOptional(wireOptional(wireString)) }) }), "test JSON value");
		expect(event.tool_name).toBe("Bash");
		expect(event.tool_input.command).toBe("ls -la");
	});

	it("renders a BLOCKED decision with reason + warnings and sets exitCode=1", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({
			decision: "block",
			reason: "destructive command",
			warnings: ["consider a dry run", "this is irreversible"],
		});
		await runWithTimers(harnessTestCommand("rm -rf /", {}));
		const out = logText();
		expect(out).toContain("BLOCKED");
		expect(out).toContain("destructive command");
		expect(out).toContain("consider a dry run");
		expect(out).toContain("this is irreversible");
		expect(process.exitCode).toBe(1);
	});

	it("uses file_path tool_input for a non-shell tool", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		await runWithTimers(harnessTestCommand("/etc/passwd", { tool: "Read" }));
		const event = parseWire(mocks.queryHarness.mock.calls[0]?.[1], wireObject({ "tool_name": wireString, "tool_input": wireObject({ "file_path": wireAbsentOptional(wireOptional(wireString)) }) }), "test JSON value");
		expect(event.tool_name).toBe("Read");
		expect(event.tool_input.file_path).toBe("/etc/passwd");
	});

	it("treats Shell like Bash for tool_input shaping", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		await runWithTimers(harnessTestCommand("echo hi", { tool: "Shell" }));
		const event = parseWire(mocks.queryHarness.mock.calls[0]?.[1], wireObject({ "tool_input": wireObject({ "command": wireAbsentOptional(wireOptional(wireString)) }) }), "test JSON value");
		expect(event.tool_input.command).toBe("echo hi");
	});

	it("emits the raw decision object in JSON mode", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "block", reason: "nope" });
		await runWithTimers(harnessTestCommand("danger", { json: true }));
		const parsed = parseWire(JSON.parse(logText()), wireObject({ "decision": wireString, "reason": wireString }), "test JSON value");
		expect(parsed.decision).toBe("block");
		expect(parsed.reason).toBe("nope");
		expect(process.exitCode).toBe(1);
	});

	it("renders an allowed decision with no reason and non-array warnings (skips both inner branches)", async () => {
		mocks.existsSync.mockReturnValue(true);
		// warnings present but not an array → the Array.isArray guard is false
		mocks.queryHarness.mockResolvedValue({ decision: "allow", warnings: "not-an-array" });
		await runWithTimers(harnessTestCommand("ls", {}));
		const out = logText();
		expect(out).toContain("ALLOWED");
		// no reason line, no warning lines beyond the headline
		expect(out.split("\n").filter((l) => l.includes("consider")).length).toBe(0);
	});

	it("routes a thrown error to outputError", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockRejectedValue(new Error("socket connect failed"));
		await runWithTimers(harnessTestCommand("ls", {}));
		expect(errText()).toContain("socket connect failed");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error thrown value in the catch path", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockRejectedValue("test string failure");
		await runWithTimers(harnessTestCommand("ls", {}));
		expect(errText()).toContain("test string failure");
	});
});
