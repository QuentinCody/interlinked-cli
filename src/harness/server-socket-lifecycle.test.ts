import { nonNull } from "../lib/non-null.js";
// Behavioral unit tests for createSocketLifecycle (server-socket-lifecycle.ts).
//
// What's real vs mocked:
//   - LineFramer (./server/socket-framing.js) is pure → exercised for real
//     through the connection data handler.
//   - node:net createServer → mocked: returns a controllable fake server whose
//     connection handler we capture, plus listen/close spies. This drives the
//     per-connection data/close/error handlers deterministically with no real
//     socket, no real ports, no flakiness.
//   - node:fs writeFileSync → mocked (writePidFile only writes the pid file).
//   - ./server/socket-lifecycle.js (cleanupSocket/ensureDirectory/
//     removeFileIfExists) → mocked spies so we assert orchestration without
//     touching the filesystem.
//   - Process termination → injected callback records each terminal exit code.
//   - Timers → fake (vi.useFakeTimers) only for the 3000ms force-exit umbrella
//     and the 500ms per-step shutdown timeout, so they're clock-driven.
//
// Every dependency the factory closes over arrives through `deps` / setters, so
// the orchestration branches are asserted against injected fakes directly.

import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import {
	cleanupSocket as cleanupSocketAt,
	ensureDirectory,
} from "./server/socket-lifecycle.js";
import { pidFileNames, removePidFileIfOwned } from "./daemon-pid-ownership.js";
import {
	createSocketLifecycle,
	type SocketLifecycleDeps,
} from "./server-socket-lifecycle.js";

vi.mock("node:fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("./server/socket-lifecycle.js", () => ({
	cleanupSocket: vi.fn(),
	ensureDirectory: vi.fn(),
	removeFileIfExists: vi.fn(),
}));
vi.mock("./daemon-pid-ownership.js", () => ({
	pidFileNames: vi.fn(() => true),
	removePidFileIfOwned: vi.fn(() => true),
}));

// --- node:net fake server -------------------------------------------------
// createServer(connectionHandler) returns an object exposing listen() / close()
// spies and the captured handler so tests can simulate a client connecting.
type ConnHandler = (sock: FakeSocket) => void;

class FakeServer extends EventEmitter {
	listen = vi.fn();
	close = vi.fn();
	constructor(readonly __handler: ConnHandler) {
		super();
	}
	emitError(err: unknown): void {
		this.emit("error", err);
	}
	emitListening(): void {
		this.emit("listening");
	}
}

let lastServer: FakeServer | null = null;

function buildFakeServer(handler: ConnHandler): FakeServer {
	const server = new FakeServer(handler);
	vi.spyOn(server, "on");
	lastServer = server;
	return server;
}

const createServerImpl = vi.fn(buildFakeServer);

vi.mock("node:net", () => ({
	createServer: (handler: ConnHandler) => createServerImpl(handler),
}));

// A minimal Socket stand-in: an EventEmitter with write() + destroy() spies.
class FakeSocket extends EventEmitter {
	write = vi.fn(() => true);
	destroy = vi.fn();
}

// --- shared fakes for the injected dependency cluster ---------------------
interface DepFakes {
	deps: SocketLifecycleDeps;
	serverBridge: { shutdown: MockInstance };
	reservations: { shutdown: MockInstance };
	contentScanner: { shutdown: MockInstance };
	asyncAnalysis: { drain: MockInstance };
	evaluateEventLine: MockInstance;
	log: MockInstance;
	logAlways: MockInstance;
}

function makeDeps(overrides: Partial<SocketLifecycleDeps> = {}): DepFakes {
	const serverBridge = { shutdown: vi.fn() };
	const reservations = { shutdown: vi.fn() };
	const contentScanner = { shutdown: vi.fn(() => Promise.resolve()) };
	const asyncAnalysis = { drain: vi.fn(() => Promise.resolve()) };
	const evaluateEventLine = vi.fn<SocketLifecycleDeps["evaluateEventLine"]>(async () => ({ decision: "allow" }));
	const log = vi.fn();
	const logAlways = vi.fn();
	const deps: SocketLifecycleDeps = {
		socketPath: "/tmp/test-harness.sock",
		pidPath: "/tmp/test-harness.pid",
		runRawSocket: true,
		asyncAnalysisDrainTimeoutMs: 10_000,
		serverBridge: serverBridge,
		reservations: reservations,
		contentScanner: contentScanner,
		asyncAnalysis: asyncAnalysis,
		evaluateEventLine: evaluateEventLine,
		log: log,
		logAlways: logAlways,
		exit: exitSpy,
		...overrides,
	};
	return {
		deps,
		serverBridge,
		reservations,
		contentScanner,
		asyncAnalysis,
		evaluateEventLine,
		log,
		logAlways,
	};
}

let exitSpy = vi.fn<(code: number) => void>();

/** The code passed to the most recent process.exit() call (undefined if none). */
function lastExitCode(): number | undefined {
	return exitSpy.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
	lastServer = null;
	// Reset BOTH call data AND implementations so a per-test `mockImplementation`
	// (the throwing-helper force-exit cases) can't leak into the next test.
	vi.resetAllMocks();
	createServerImpl.mockImplementation(buildFakeServer);
	exitSpy = vi.fn();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("createSocketLifecycle — public surface", () => {
	it("returns all six lifecycle methods", () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		expect(typeof lc.cleanupSocket).toBe("function");
		expect(typeof lc.writePidFile).toBe("function");
		expect(typeof lc.shutdown).toBe("function");
		expect(typeof lc.startRawServer).toBe("function");
		expect(typeof lc.setFramedDaemon).toBe("function");
		expect(typeof lc.setUnwatchers).toBe("function");
	});
});

describe("cleanupSocket", () => {
	it("delegates to the helper with the default socket path", () => {
		const { deps } = makeDeps({ socketPath: "/tmp/abc.sock" });
		const lc = createSocketLifecycle(deps);
		lc.cleanupSocket();
		expect(cleanupSocketAt).toHaveBeenCalledWith("/tmp/abc.sock");
	});

	it("delegates to the helper with an explicit override path", () => {
		const { deps } = makeDeps({ socketPath: "/tmp/default.sock" });
		const lc = createSocketLifecycle(deps);
		lc.cleanupSocket("/tmp/override.sock");
		expect(cleanupSocketAt).toHaveBeenCalledWith("/tmp/override.sock");
	});
});

describe("writePidFile", () => {
	it("ensures the pid directory then writes the current pid", () => {
		const { deps } = makeDeps({ pidPath: "/tmp/h.pid" });
		const lc = createSocketLifecycle(deps);
		lc.writePidFile();
		expect(ensureDirectory).toHaveBeenCalledWith("/tmp/h.pid");
		expect(writeFileSync).toHaveBeenCalledWith("/tmp/h.pid", String(process.pid));
		// Ordering: ensureDirectory must precede writeFileSync.
		const ensureOrder = (vi.mocked(ensureDirectory)).mock
			.invocationCallOrder[0];
		const writeOrder = (vi.mocked(writeFileSync)).mock
			.invocationCallOrder[0];
		expect(ensureOrder).toBeLessThan(nonNull(writeOrder));
	});
});

// The self-heal tick (writePidFile's 60 s interval) exists because a
// dual-protocol newcomer overwrites `harness.pid` before losing the framed
// anti-stomp race; if it is killed mid-exit it leaves a corpse pid behind and
// every reader then diagnoses a dead daemon next to a healthy one (the
// perpetual-"restarting" of 2026-08-16). The serving daemon must re-assert
// ownership until it shuts down, and must never be stopped by a failing tick.
describe("writePidFile — pid-ownership self-heal tick", () => {
	const HEAL_INTERVAL_MS = 60_000;

	/** The node:fs mock's readFileSync, typed for per-test implementations. */
	function readMock(): MockInstance {
		return vi.mocked(readFileSync);
	}

	it("rewrites the pid file on a heal tick when another pid owns it", () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ pidPath: "/tmp/heal-foreign.pid" });
		readMock().mockReturnValue(`${process.pid + 1}\n`);
		createSocketLifecycle(deps).writePidFile();
		expect(writeFileSync).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(HEAL_INTERVAL_MS);

		expect(readMock()).toHaveBeenCalledWith("/tmp/heal-foreign.pid", "utf-8");
		expect(writeFileSync).toHaveBeenNthCalledWith(
			2,
			"/tmp/heal-foreign.pid",
			String(process.pid),
		);
		expect(ensureDirectory).toHaveBeenNthCalledWith(2, "/tmp/heal-foreign.pid");
	});

	it("leaves the pid file untouched on a heal tick while it still names this process", () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ pidPath: "/tmp/heal-ours.pid" });
		readMock().mockReturnValue(`${process.pid}\n`);
		createSocketLifecycle(deps).writePidFile();

		vi.advanceTimersByTime(HEAL_INTERVAL_MS * 3);

		// Only the initial write; three ticks read and returned early.
		expect(writeFileSync).toHaveBeenCalledTimes(1);
		expect(readMock()).toHaveBeenCalledTimes(3);
		expect(readMock()).toHaveBeenLastCalledWith("/tmp/heal-ours.pid", "utf-8");
	});

	it("rewrites the pid file on a heal tick when it is missing or unreadable", () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ pidPath: "/tmp/heal-missing.pid" });
		readMock().mockImplementation(() => {
			throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
		});
		createSocketLifecycle(deps).writePidFile();

		vi.advanceTimersByTime(HEAL_INTERVAL_MS);

		expect(writeFileSync).toHaveBeenNthCalledWith(
			2,
			"/tmp/heal-missing.pid",
			String(process.pid),
		);
	});

	it("swallows a failing heal write and heals again on the next tick", () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ pidPath: "/tmp/heal-readonly.pid" });
		readMock().mockReturnValue(`${process.pid + 1}`);
		// Initial write succeeds; the first heal write fails (read-only dir).
		(vi.mocked(writeFileSync))
			.mockImplementationOnce(() => {})
			.mockImplementationOnce(() => {
				throw Object.assign(new Error("EROFS: read-only file system"), {
					code: "EROFS",
				});
			});
		createSocketLifecycle(deps).writePidFile();

		vi.advanceTimersByTime(HEAL_INTERVAL_MS * 2);

		// The failed tick did not stop the interval: initial + 2 heal attempts.
		expect(writeFileSync).toHaveBeenCalledTimes(3);
		expect(writeFileSync).toHaveBeenNthCalledWith(
			3,
			"/tmp/heal-readonly.pid",
			String(process.pid),
		);
	});

	it("arms exactly one heal interval across repeated writePidFile calls", () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ pidPath: "/tmp/heal-once.pid" });
		readMock().mockReturnValue(`${process.pid + 1}`);
		const lc = createSocketLifecycle(deps);
		lc.writePidFile();
		lc.writePidFile();

		vi.advanceTimersByTime(HEAL_INTERVAL_MS);

		// 2 explicit writes + exactly 1 heal write (a second interval would make 4).
		expect(writeFileSync).toHaveBeenCalledTimes(3);
		expect(writeFileSync).toHaveBeenLastCalledWith("/tmp/heal-once.pid", String(process.pid));
	});

	it("stops healing the pid file once shutdown() runs", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ pidPath: "/tmp/heal-stop.pid" });
		readMock().mockReturnValue(`${process.pid + 1}`);
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		lc.writePidFile();
		vi.advanceTimersByTime(HEAL_INTERVAL_MS);
		expect(writeFileSync).toHaveBeenCalledTimes(2);
		expect(writeFileSync).toHaveBeenLastCalledWith("/tmp/heal-stop.pid", String(process.pid));

		lc.shutdown();
		await vi.runAllTimersAsync();
		expect(lastExitCode()).toBe(0);

		vi.advanceTimersByTime(HEAL_INTERVAL_MS * 5);
		// Interval cleared: still the initial write plus the single pre-shutdown heal.
		expect(writeFileSync).toHaveBeenCalledTimes(2);
	});
});

describe("startRawServer + createRawSocketServer connection handling", () => {
	it("binds the raw listener on the configured socket path", () => {
		const { deps } = makeDeps({ socketPath: "/tmp/listen.sock" });
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		// `createServer` (imported) is the thin arrow wrapper around the spy.
		expect(createServerImpl).toHaveBeenCalledTimes(1);
		expect(typeof createServer).toBe("function");
		expect(lastServer?.listen).toHaveBeenCalledWith("/tmp/listen.sock");
	});

	it("registers an 'error' listener before listen() (a bind failure is FATAL, not survivable)", () => {
		// Regression: `rawServer.listen()` with no 'error' listener lets a bind
		// failure become an uncaught exception, which `installCrashResilience()`
		// deliberately SURVIVES — leaving a process alive with no working raw
		// listener even though `writePidFile()` already claimed the pid file
		// earlier in startup (the exact zombie shape `isDaemonSocketServing`
		// exists to detect from the outside). This asserts the hole is closed
		// at the source: a listen failure exits the process instead.
		const { deps, logAlways } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		expect(lastServer?.on).toHaveBeenCalledWith("error", expect.any(Function));

		const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
		lastServer?.emitError(err);

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(logAlways).toHaveBeenCalledTimes(1);
		expect(String(logAlways.mock.calls[0]?.[0])).toContain("EADDRINUSE");
	});

	// -----------------------------------------------------------------------
	// Bind-outcome reporting (audit F1). The daemon passes its startup guard
	// as the reporter, which is how a raw bind failure gets the distinct exit
	// code + ledger row, and how "we are serving" becomes an observed fact.
	// -----------------------------------------------------------------------

	// P: a reporter takes over the whole failure contract.
	it("hands a bind failure to the reporter instead of the legacy exit path", () => {
		const { deps, logAlways } = makeDeps();
		const reporter = { note: vi.fn(), fail: vi.fn() };
		const lc = createSocketLifecycle(deps);
		lc.startRawServer(reporter);

		const err = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
		lastServer?.emitError(err);

		expect(reporter.fail).toHaveBeenCalledWith("raw socket bind", err);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(logAlways).not.toHaveBeenCalled();
	});

	// P: 'listening' — not `listen()` returning — is what reports success.
	it("reports the raw bind only when the 'listening' event fires", () => {
		const { deps } = makeDeps();
		const reporter = { note: vi.fn(), fail: vi.fn() };
		const lc = createSocketLifecycle(deps);
		lc.startRawServer(reporter);
		expect(reporter.note).not.toHaveBeenCalled();

		lastServer?.emitListening();
		expect(reporter.note).toHaveBeenCalledWith("raw");
	});

	// N: with no reporter, nothing subscribes to 'listening' (the legacy
	// caller shape stays byte-identical).
	it("registers no 'listening' listener when no reporter is supplied", () => {
		const { deps } = makeDeps();
		createSocketLifecycle(deps).startRawServer();
		expect(lastServer?.on).not.toHaveBeenCalledWith("listening", expect.any(Function));
	});

	it("on connect: counts the connection and logs the total", () => {
		const { deps, log } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		lastServer?.__handler(sock);
		expect(log).toHaveBeenCalledWith("Connection opened (total: 1)");
	});

	it("evaluates each complete line and writes the JSON decision back", async () => {
		const { deps, evaluateEventLine } = makeDeps();
		evaluateEventLine.mockResolvedValueOnce({ decision: "block", reason: "no" });
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		lastServer?.__handler(sock);
		await emitData(sock, '{"x":1}\n');
		expect(evaluateEventLine).toHaveBeenCalledWith('{"x":1}', "raw");
		expect(sock.write).toHaveBeenCalledWith(
			`${JSON.stringify({ decision: "block", reason: "no" })}\n`,
		);
	});

	it("processes multiple lines in one chunk in arrival order", async () => {
		const { deps, evaluateEventLine } = makeDeps();
		evaluateEventLine
			.mockResolvedValueOnce({ decision: "allow", n: 1 })
			.mockResolvedValueOnce({ decision: "allow", n: 2 });
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		lastServer?.__handler(sock);
		await emitData(sock, '{"a":1}\n{"b":2}\n');
		expect(evaluateEventLine).toHaveBeenNthCalledWith(1, '{"a":1}', "raw");
		expect(evaluateEventLine).toHaveBeenNthCalledWith(2, '{"b":2}', "raw");
		expect(sock.write).toHaveBeenCalledTimes(2);
	});

	it("buffers a partial line until its newline arrives (LineFramer pending)", async () => {
		const { deps, evaluateEventLine } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		lastServer?.__handler(sock);
		await emitData(sock, '{"par');
		expect(evaluateEventLine).not.toHaveBeenCalled();
		await emitData(sock, 'tial":1}\n');
		expect(evaluateEventLine).toHaveBeenCalledWith('{"partial":1}', "raw");
	});

	it("drops a whitespace-only line (no evaluation, no write)", async () => {
		const { deps, evaluateEventLine } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		lastServer?.__handler(sock);
		await emitData(sock, "   \n");
		expect(evaluateEventLine).not.toHaveBeenCalled();
		expect(sock.write).not.toHaveBeenCalled();
	});

	it("swallows a write() failure on the socket (inner catch branch)", async () => {
		const { deps, evaluateEventLine } = makeDeps();
		evaluateEventLine.mockResolvedValueOnce({ decision: "allow" });
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		sock.write.mockImplementationOnce(() => {
			throw new Error("EPIPE");
		});
		lastServer?.__handler(sock);
		// Must not throw despite write() throwing.
		await expect(emitData(sock, '{"y":1}\n')).resolves.toBeUndefined();
	});

	it("on close: decrements the count and logs remaining", () => {
		const { deps, log } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		lastServer?.__handler(sock);
		sock.emit("close");
		expect(log).toHaveBeenCalledWith("Connection closed (remaining: 0)");
	});

	it("on error: logs the socket error message", () => {
		const { deps, log } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const sock = new FakeSocket();
		lastServer?.__handler(sock);
		sock.emit("error", new Error("boom"));
		expect(log).toHaveBeenCalledWith("Socket error: boom");
	});

	it("tracks two concurrent connections in the counter", () => {
		const { deps, log } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.startRawServer();
		const a = new FakeSocket();
		const b = new FakeSocket();
		lastServer?.__handler(a);
		lastServer?.__handler(b);
		expect(log).toHaveBeenCalledWith("Connection opened (total: 2)");
		a.emit("close");
		expect(log).toHaveBeenCalledWith("Connection closed (remaining: 1)");
	});
});

describe("shutdown — graceful path (shutdownAsync)", () => {
	it("runs the full teardown sequence and exits 0", async () => {
		const { deps, serverBridge, reservations, contentScanner, asyncAnalysis } =
			makeDeps();
		const lc = createSocketLifecycle(deps);
		const unwatchRules = vi.fn();
		const unwatchSettings = vi.fn();
		lc.setUnwatchers(unwatchRules, unwatchSettings);
		lc.startRawServer();

		await runShutdown(lc);

		expect(serverBridge.shutdown).toHaveBeenCalledTimes(1);
		expect(reservations.shutdown).toHaveBeenCalledTimes(1);
		expect(contentScanner.shutdown).toHaveBeenCalledTimes(1);
		expect(asyncAnalysis.drain).toHaveBeenCalledWith(10_000);
		expect(lastServer?.close).toHaveBeenCalledTimes(1);
		// runRawSocket=true → cleanupSocket fired; pid removed; unwatchers called.
		expect(cleanupSocketAt).toHaveBeenCalledWith(deps.socketPath);
		expect(removePidFileIfOwned).toHaveBeenCalledWith(deps.pidPath, process.pid);
		expect(unwatchRules).toHaveBeenCalledTimes(1);
		expect(unwatchSettings).toHaveBeenCalledTimes(1);
		expect(lastExitCode()).toBe(0);
	});

	it("tolerates a null serverBridge / undefined contentScanner", async () => {
		const { deps } = makeDeps({ serverBridge: null, contentScanner: undefined });
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		await runShutdown(lc);
		expect(lastExitCode()).toBe(0);
	});

	it("destroys every open raw client before closing the server", async () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		lc.startRawServer();
		const a = new FakeSocket();
		const b = new FakeSocket();
		lastServer?.__handler(a);
		lastServer?.__handler(b);
		await runShutdown(lc);
		expect(a.destroy).toHaveBeenCalledTimes(1);
		expect(b.destroy).toHaveBeenCalledTimes(1);
	});

	it("swallows a throwing client.destroy() during shutdown (catch branch)", async () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		lc.startRawServer();
		const sock = new FakeSocket();
		sock.destroy.mockImplementationOnce(() => {
			throw new Error("already destroyed");
		});
		lastServer?.__handler(sock);
		await runShutdown(lc);
		expect(lastExitCode()).toBe(0);
	});

	it("does NOT clean up the socket when runRawSocket is false", async () => {
		const { deps } = makeDeps({ runRawSocket: false });
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		await runShutdown(lc);
		expect(cleanupSocketAt).not.toHaveBeenCalled();
		expect(lastExitCode()).toBe(0);
	});

	it("swallows a throwing socketServer.close() (catch branch)", async () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		lc.startRawServer();
		(nonNull(lastServer)).close.mockImplementationOnce(() => {
			throw new Error("already closed");
		});
		await runShutdown(lc);
		expect(lastExitCode()).toBe(0);
	});

	it("handles shutdown when the raw server was never started (null socketServer)", async () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		// startRawServer NOT called → socketServer stays null; `?.close()` no-ops.
		await runShutdown(lc);
		expect(lastExitCode()).toBe(0);
	});

	it("swallows a rejected contentScanner.shutdown() (best-effort catch)", async () => {
		const { deps, contentScanner } = makeDeps();
		contentScanner.shutdown.mockRejectedValueOnce(new Error("scanner gone"));
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		await runShutdown(lc);
		expect(lastExitCode()).toBe(0);
	});

	it("invokes the default no-op unwatchers when setUnwatchers was never called", async () => {
		// Covers the `() => {}` initializers for unwatchRules/unwatchSettings: with
		// setUnwatchers never called, shutdownAsync's `unwatchRules()` /
		// `unwatchSettings()` execute the no-op defaults. Production wires the real
		// shutdown only after setUnwatchers, but the defaults must be safe to call.
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		await runShutdown(lc);
		expect(lastExitCode()).toBe(0);
	});

	it("is idempotent: a second shutdown() call is a no-op", async () => {
		const { deps, logAlways } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		await runShutdown(lc);
		const exitCallsAfterFirst = exitSpy.mock.calls.length;
		const logCallsAfterFirst = logAlways.mock.calls.length;
		// Second call returns immediately (shuttingDown guard) — no new exit/log.
		lc.shutdown();
		await flushMacrotasks();
		expect(exitSpy.mock.calls.length).toBe(exitCallsAfterFirst);
		expect(logAlways.mock.calls.length).toBe(logCallsAfterFirst);
	});
});

describe("shutdown — framed daemon stop", () => {
	it("awaits framedDaemon.stop with the shutdown reason when it resolves fast", async () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		const stop = vi.fn(() => Promise.resolve());
		lc.setFramedDaemon({ stop });
		await runShutdown(lc);
		expect(stop).toHaveBeenCalledWith("server_shutdown");
		expect(lastExitCode()).toBe(0);
	});

	it("bounds a hung framedDaemon.stop with the 500ms step timeout, then exits 0", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		// stop() never resolves → the Promise.race must fall through to the 500ms
		// timer so shutdownAsync can continue to process.exit(0).
		lc.setFramedDaemon({ stop: vi.fn(() => new Promise<void>(() => {})) });
		lc.shutdown();
		await vi.runAllTimersAsync();
		expect(lastExitCode()).toBe(0);
	});

	it("skips the framed-daemon stop when no handle was set (null branch)", async () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		// setFramedDaemon never called → framedDaemon stays null, even while
		// the independent raw-server shutdown path remains active.
		lc.startRawServer();
		await runShutdown(lc);
		expect(lastServer?.close).toHaveBeenCalledOnce();
		expect(lastExitCode()).toBe(0);
	});

	it("setFramedDaemon(null) keeps the daemon branch skipped", async () => {
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		const stop = vi.fn();
		lc.setFramedDaemon({ stop });
		lc.setFramedDaemon(null);
		await runShutdown(lc);
		expect(stop).not.toHaveBeenCalled();
		expect(lastExitCode()).toBe(0);
	});
});

describe("shutdown — force-exit umbrella (forceExit timer)", () => {
	it("force-exits with code 1 when shutdownAsync stalls past the grace window", async () => {
		vi.useFakeTimers();
		const { deps, logAlways } = makeDeps({ runRawSocket: true });
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		lc.startRawServer();
		// drain() never resolves → shutdownAsync hangs → the 3000ms force-exit
		// timer must fire and call process.exit(1).
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {}));

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
		expect(logAlways).toHaveBeenCalledWith(
			"Graceful shutdown stalled after 3000ms — forcing exit",
		);
		// Force-exit path also best-effort cleans pid + socket.
		expect(removePidFileIfOwned).toHaveBeenCalledWith(deps.pidPath, process.pid);
		expect(cleanupSocketAt).toHaveBeenCalledWith(deps.socketPath);
	});

	it("force-exit skips socket cleanup when runRawSocket is false", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ runRawSocket: false });
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {}));

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
		expect(cleanupSocketAt).not.toHaveBeenCalled();
	});

	it("force-exit swallows a throwing logAlways and still exits 1", async () => {
		vi.useFakeTimers();
		const { deps, logAlways } = makeDeps();
		// The FIRST logAlways call is shutdownAsync's "Shutting down..." (not in a
		// try/catch). Only the force-exit callback's logAlways is guarded, so make
		// just that later call throw — exercising the forceExit try/catch.
		logAlways.mockImplementationOnce(() => {}).mockImplementation(() => {
			throw new Error("logger torn down");
		});
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {}));

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
	});

	it("force-exit swallows a throwing ownership cleanup and still exits 1", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		(vi.mocked(removePidFileIfOwned)).mockImplementationOnce(() => {
			throw new Error("rm failed");
		});
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {}));

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
	});

	it("force-exit swallows a throwing cleanupSocket and still exits 1", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ runRawSocket: true });
		(vi.mocked(cleanupSocketAt)).mockImplementationOnce(() => {
			throw new Error("unlink failed");
		});
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {}));

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
	});

	it("clears the force-exit timer once shutdownAsync wins the race (exits 0, not 1)", async () => {
		vi.useFakeTimers();
		const clearSpy = vi.spyOn(global, "clearTimeout");
		const scheduleSpy = vi.spyOn(global, "setTimeout");
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		// Graceful path resolves immediately → finally() clears the force timer.
		lc.shutdown();
		expect(scheduleSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 3000);
		const forceExitTimer = scheduleSpy.mock.results[0]?.value;
		await vi.runAllTimersAsync();
		expect(lastExitCode()).toBe(0);
		expect(clearSpy).toHaveBeenCalledWith(forceExitTimer);
		scheduleSpy.mockRestore();
		clearSpy.mockRestore();
	});
});

// --- helpers --------------------------------------------------------------

/** Yield to the macrotask queue so awaited async-listener work can settle. */
function flushMacrotasks(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

/** Emit a "data" event and flush the async data handler's microtasks. The
 *  handler is `async (data) => { for (line of framer.push) await evaluate(...) }`;
 *  awaiting a macrotask lets those awaited evaluations settle. */
async function emitData(sock: FakeSocket, chunk: string): Promise<void> {
	sock.emit("data", Buffer.from(chunk, "utf-8"));
	await flushMacrotasks();
}

/** Drive shutdown() through to its (recorded) process.exit on the graceful
 *  path. Uses real timers; the graceful path resolves without the force-exit
 *  timer firing, so a couple of macrotask flushes settle every awaited step. */
async function runShutdown(lc: { shutdown: () => void }): Promise<void> {
	lc.shutdown();
	await flushMacrotasks();
	await flushMacrotasks();
}


describe("socket ownership preservation", () => {
    it("leaves raw artifacts owned by a successor intact during shutdown", async () => {
        vi.useFakeTimers();
        vi.mocked(pidFileNames).mockReturnValue(false);
        const { deps } = makeDeps();
        createSocketLifecycle(deps).shutdown();
        await vi.runAllTimersAsync();
        expect(cleanupSocketAt).not.toHaveBeenCalled();
        expect(removePidFileIfOwned).not.toHaveBeenCalled();
        expect(lastExitCode()).toBe(0);
    });

    it("reports a bind error message when the runtime supplies no errno code", () => {
        const { deps, logAlways } = makeDeps();
        createSocketLifecycle(deps).startRawServer();
        nonNull(lastServer).emitError(new Error("listener unavailable"));
        expect(logAlways).toHaveBeenCalledWith(expect.stringContaining("listener unavailable"));
        expect(lastExitCode()).toBe(1);
    });
});
