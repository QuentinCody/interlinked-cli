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
//   - process.exit → spied with a RECORDING (non-throwing) impl. exit() is the
//     terminal statement on every path (graceful shutdownAsync + the forceExit
//     timer), so nothing runs after it in the real code; a throwing mock would
//     surface as an unhandled rejection because shutdownAsync is fire-and-forget
//     (`void shutdownAsync().finally(...)`). We assert the recorded exit code.
//   - Timers → fake (vi.useFakeTimers) only for the 3000ms force-exit umbrella
//     and the 500ms per-step shutdown timeout, so they're clock-driven.
//
// Every dependency the factory closes over arrives through `deps` / setters, so
// the orchestration branches are asserted against injected fakes directly.

import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
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
import { removePidFileIfOwned } from "./daemon-pid-ownership.js";
import {
	createSocketLifecycle,
	type SocketLifecycleDeps,
} from "./server-socket-lifecycle.js";

vi.mock("node:fs", () => ({ writeFileSync: vi.fn() }));
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

interface FakeServer {
	listen: MockInstance;
	close: MockInstance;
	on: (event: string, listener: (...args: never[]) => void) => FakeServer;
	/** Fires a registered `on("error", ...)` listener, or re-throws (mirrors
	 *  real EventEmitter default behavior: an 'error' with no listener is
	 *  fatal) so a test omitting `.on("error", ...)` coverage fails loudly
	 *  instead of silently no-op'ing. */
	emitError: (err: unknown) => void;
	/** Fires the registered `on("listening", ...)` listeners — Node's real
	 *  signal that the bind RESOLVED, which `listen()` returning does not
	 *  prove. */
	emitListening: () => void;
	__handler: ConnHandler;
}

let lastServer: FakeServer | null = null;

function buildFakeServer(handler: ConnHandler): FakeServer {
	const errorListeners: Array<(err: unknown) => void> = [];
	const listeningListeners: Array<() => void> = [];
	const server: FakeServer = {
		listen: vi.fn(),
		close: vi.fn(),
		on: vi.fn((event: string, listener: (...args: never[]) => void) => {
			if (event === "error") errorListeners.push(listener as (err: unknown) => void);
			if (event === "listening") listeningListeners.push(listener as () => void);
			return server;
		}),
		emitError: (err: unknown) => {
			if (errorListeners.length === 0) throw err;
			for (const listener of errorListeners) listener(err);
		},
		emitListening: () => {
			for (const listener of listeningListeners) listener();
		},
		__handler: handler,
	};
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
	const evaluateEventLine = vi.fn(async () => ({ decision: "allow" }) as never);
	const log = vi.fn();
	const logAlways = vi.fn();
	const deps: SocketLifecycleDeps = {
		socketPath: "/tmp/test-harness.sock",
		pidPath: "/tmp/test-harness.pid",
		runRawSocket: true,
		asyncAnalysisDrainTimeoutMs: 10_000,
		serverBridge: serverBridge as never,
		reservations: reservations as never,
		contentScanner: contentScanner as never,
		asyncAnalysis: asyncAnalysis as never,
		evaluateEventLine: evaluateEventLine as never,
		log: log as never,
		logAlways: logAlways as never,
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

let exitSpy: MockInstance;

/** The code passed to the most recent process.exit() call (undefined if none). */
function lastExitCode(): number | undefined {
	const calls = exitSpy.mock.calls;
	return calls.length
		? (calls[calls.length - 1]?.[0] as number | undefined)
		: undefined;
}

beforeEach(() => {
	lastServer = null;
	// Reset BOTH call data AND implementations so a per-test `mockImplementation`
	// (the throwing-helper force-exit cases) can't leak into the next test.
	vi.resetAllMocks();
	createServerImpl.mockImplementation(buildFakeServer);
	// Recording, non-throwing exit. exit() is always terminal in the SUT.
	exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
		/* record only */
	}) as never);
});

afterEach(() => {
	vi.useRealTimers();
	exitSpy.mockRestore();
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
		const ensureOrder = (ensureDirectory as unknown as MockInstance).mock
			.invocationCallOrder[0];
		const writeOrder = (writeFileSync as unknown as MockInstance).mock
			.invocationCallOrder[0];
		expect(ensureOrder).toBeLessThan(writeOrder as number);
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
		(lastServer as FakeServer).close.mockImplementationOnce(() => {
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
		lc.setFramedDaemon({ stop } as never);
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
		lc.setFramedDaemon({ stop: vi.fn(() => new Promise<void>(() => {})) } as never);
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
		// setFramedDaemon never called → framedDaemon stays null.
		await runShutdown(lc);
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
		lc.setFramedDaemon({ stop } as never);
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
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {})) as never;

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
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {})) as never;

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
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {})) as never;

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
	});

	it("force-exit swallows a throwing ownership cleanup and still exits 1", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps();
		(removePidFileIfOwned as unknown as MockInstance).mockImplementationOnce(() => {
			throw new Error("rm failed");
		});
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {})) as never;

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
	});

	it("force-exit swallows a throwing cleanupSocket and still exits 1", async () => {
		vi.useFakeTimers();
		const { deps } = makeDeps({ runRawSocket: true });
		(cleanupSocketAt as unknown as MockInstance).mockImplementationOnce(() => {
			throw new Error("unlink failed");
		});
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		deps.asyncAnalysis.drain = vi.fn(() => new Promise<void>(() => {})) as never;

		lc.shutdown();
		await vi.advanceTimersByTimeAsync(3000);

		expect(lastExitCode()).toBe(1);
	});

	it("clears the force-exit timer once shutdownAsync wins the race (exits 0, not 1)", async () => {
		vi.useFakeTimers();
		const clearSpy = vi.spyOn(global, "clearTimeout");
		const { deps } = makeDeps();
		const lc = createSocketLifecycle(deps);
		lc.setUnwatchers(
			() => {},
			() => {},
		);
		// Graceful path resolves immediately → finally() clears the force timer.
		lc.shutdown();
		await vi.runAllTimersAsync();
		expect(lastExitCode()).toBe(0);
		expect(clearSpy).toHaveBeenCalled();
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
