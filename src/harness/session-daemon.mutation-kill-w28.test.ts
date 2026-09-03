// Wave 28 mutation-kill pass over session-daemon.ts. Every test here exists to
// distinguish ONE specific surviving mutant from the pristine implementation —
// see the `// test-contract:` comment directly above each case for which
// mutant(s) it targets and why the assertion is the observable that differs.
//
// node:fs is partially mocked (four named exports wrapped in `vi.fn(actual)`,
// everything else passed through untouched) so several tests can assert EXACT
// call arguments/counts on writeFileSync/rmSync/readFileSync/mkdirSync without
// changing their real behavior — a call-count/arg spy on an injectable dep is
// an allowed observable per the campaign's method contract.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as fsMod from "node:fs";
import { createConnection, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import {
	claimSessionPid,
	type SessionDaemonHandle,
	startSessionDaemon,
} from "./session-daemon.js";
import { BIND_BACKOFF_MS, bindSessionSocket } from "./session-daemon-bind.js";
import type { DaemonPaths } from "./session-paths.js";
import type { TsgoRunner } from "./tsgo-runner.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: vi.fn(actual.writeFileSync),
		rmSync: vi.fn(actual.rmSync),
		readFileSync: vi.fn(actual.readFileSync),
		mkdirSync: vi.fn(actual.mkdirSync),
	};
});

let tmp = "";
let daemon: SessionDaemonHandle | null = null;

/** Untyped view of an `EventEmitter.on` spy's recorded calls — Socket.on's
 *  many overloads make TS narrow `mock.calls` to a single event-name literal
 *  (whichever overload it resolves first), which then makes comparisons
 *  against any OTHER event name a compile error. We only need the raw
 *  (name, handler, thisArg) triples here, so drop to unknown deliberately. */
type RawOnCall = [event: string | symbol, handler: (...args: unknown[]) => void];

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-sd-w28-"));
	vi.clearAllMocks();
});

afterEach(async () => {
	if (daemon) {
		await daemon.stop();
		daemon = null;
	}
	rmSync(tmp, { recursive: true, force: true });
});

function makePaths(id: string): DaemonPaths {
	return {
		socket: join(tmp, `harness-${id}.sock`),
		pid: join(tmp, `harness-${id}.pid`),
		log: join(tmp, "logs", `daemon-${id}.log`),
	};
}

function makeTsgo(): TsgoRunner {
	return {
		available: () => true,
		checkFile: vi.fn().mockResolvedValue({ diagnostics: [], cached: false, elapsed_ms: 1 }),
		simulateEdit: vi.fn().mockResolvedValue({ new_diagnostics: [], elapsed_ms: 1 }),
		invalidate: vi.fn(),
		stats: () => ({ cache_size: 0, available: true }),
	};
}

function makeEvaluatorContext(): EvaluateUnifiedContext {
	return {
		rules: { version: 1, enabled: false } as unknown as EvaluateUnifiedContext["rules"],
		session: undefined,
		reservations: {} as EvaluateUnifiedContext["reservations"],
		cohort: {} as EvaluateUnifiedContext["cohort"],
	};
}

// ---------------------------------------------------------------------------
// claimSessionPid
// ---------------------------------------------------------------------------
describe("claimSessionPid — mutation kills", () => {
	// test-contract: security — arbitration may create its companion lock, but
	// a live foreign owner prevents any replacement file from being authored.
	it("does not author a PID replacement when a live foreign owner holds the pid", () => {
		const pidPath = join(tmp, "live-foreign.pid");
		writeFileSync(pidPath, String(process.pid)); // self — guaranteed alive
		const writeSpy = vi.mocked(fsMod.writeFileSync);
		writeSpy.mockClear();
		const foreignClaimant = process.pid === 1 ? 2 : 1;
		const claim = claimSessionPid(pidPath, foreignClaimant);
		expect(claim).toEqual({ claimed: false, ownerPid: process.pid });
		expect(writeSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalledWith(
			`${pidPath}.claim`,
			expect.stringContaining(`"pid":${process.pid}`),
			{ flag: "wx" },
		);
	});

	// test-contract: kill (mutantId 90e6fe99049dc35a, `existingPid !== null` ->
	// true; mutantId 86ebe08701775a90, `!==` -> `===`) — with no pid file at
	// all, the real `existingPid !== null` clause is false and short-circuits
	// the whole `&&` chain, so `isProcessAlive` (and its `process.kill` probe)
	// is NEVER reached. Either mutant forces that first clause true, which then
	// evaluates the remaining clauses and DOES call `process.kill`.
	it("never probes process liveness when no pid file exists yet", () => {
		const pidPath = join(tmp, "fresh-claim.pid");
		const writeSpy = vi.mocked(fsMod.writeFileSync);
		writeSpy.mockClear();
		const killSpy = vi.spyOn(process, "kill");
		const claim = claimSessionPid(pidPath, process.pid);
		expect(claim).toEqual({ claimed: true });
		expect(killSpy).not.toHaveBeenCalled();
		expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(
			writeSpy.mock.calls.every((call) => {
				const options = call[2];
				return (
					typeof options === "object" &&
					options !== null &&
					"flag" in options &&
					options.flag === "wx"
				);
			}),
		).toBe(true);
		expect(writeSpy.mock.calls.some((call) => call[0] === pidPath)).toBe(false);
		killSpy.mockRestore();
	});

	// test-contract: boundary — a reported EEXIST with no durable lock record
	// is retried as a vanished contender, never interpreted as a live owner.
	it("never probes process liveness when a raced claim lock vanished", () => {
		const pidPath = join(tmp, "raced-claim.pid");
		const writeSpy = vi.mocked(fsMod.writeFileSync);
		writeSpy.mockClear();
		writeSpy.mockImplementationOnce(() => {
			const err = new Error("EEXIST: file already exists") as NodeJS.ErrnoException;
			err.code = "EEXIST";
			throw err;
		});
		const killSpy = vi.spyOn(process, "kill");
		const claim = claimSessionPid(pidPath, process.pid);
		expect(claim).toEqual({ claimed: true });
		expect(killSpy).not.toHaveBeenCalled();
		expect(readFileSync(pidPath, "utf-8")).toBe(String(process.pid));
		killSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// readPidFile (exercised only through claimSessionPid — not exported)
// ---------------------------------------------------------------------------
describe("readPidFile — mutation kills (via claimSessionPid)", () => {
	// test-contract: kill (mutantId 9346fee2c36b513b, `!existsSync(path)` ->
	// false) — with no file present, the real code returns null WITHOUT ever
	// calling readFileSync. The mutant skips that guard and calls readFileSync
	// on a nonexistent path (caught, same eventual null, but the CALL itself is
	// the distinguishing side effect).
	it("never touches readFileSync when no pid file exists", () => {
		const pidPath = join(tmp, "no-pidfile-read-spy.pid");
		const readSpy = vi.mocked(fsMod.readFileSync);
		readSpy.mockClear();
		const claim = claimSessionPid(pidPath, process.pid);
		expect(claim).toEqual({ claimed: true });
		expect(readSpy).not.toHaveBeenCalledWith(pidPath, "utf-8");
	});

	// test-contract: kill (mutantId 2beecd5cb8602a0f, catch block `{return
	// null;}` -> `{}`) — a pidPath that is a directory makes readFileSync throw
	// EISDIR inside readPidFile's try/catch. The real catch returns null,
	// giving `existingPid !== null` == false (no `isProcessAlive` probe). The
	// mutant's empty catch falls through, implicitly returning undefined,
	// whose `!== null` is TRUE — reaching (and calling) `isProcessAlive`.
	it("treats an unreadable pid path as no-claim without probing process liveness", () => {
		const dirAsPidPath = join(tmp, "pid-dir-catch-null");
		mkdirSync(dirAsPidPath);
		const killSpy = vi.spyOn(process, "kill");
		let caught: unknown;
		try {
			claimSessionPid(dirAsPidPath, process.pid);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined(); // still throws on the subsequent write attempt (EISDIR)
		expect(killSpy).not.toHaveBeenCalled();
		killSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// closeQuietly / listenOnce / prepareBindRetry / default sleep
// ---------------------------------------------------------------------------
describe("bindSessionSocket internals — mutation kills", () => {
	// test-contract: kill (mutantId 358352b790bc78ad and e0094de580f620cb,
	// closeQuietly's block bodies -> {}) — a failed bind attempt must close the
	// failed server object. Either empty-block mutant skips that call entirely.
	it("closes the failed server object after a bind attempt fails", async () => {
		const closeSpy = vi.spyOn(Server.prototype, "close");
		const notADir = join(tmp, "closequietly-not-a-dir");
		writeFileSync(notADir, "");
		await expect(
			bindSessionSocket({
				socketPath: join(notADir, "x.sock"),
				onConnection: () => {},
				attempts: 1,
				isServing: async () => false,
				sleep: async () => {},
			}),
		).rejects.toThrow();
		expect(closeSpy).toHaveBeenCalledTimes(1);
		closeSpy.mockRestore();
	});

	// test-contract: kill (mutantId 31c117acc9d7d3c0, `"error"` -> `""` on
	// `server.once("error", reject)`) — with the wrong event name, the promise
	// never settles via reject (no matching listener fires), so the whole call
	// hangs past a short bounded window instead of rejecting quickly with the
	// real ENOTDIR.
	it("rejects promptly via the real 'error' event with the underlying error code", async () => {
		const notADir = join(tmp, "listenonce-not-a-dir");
		writeFileSync(notADir, "");
		const TIMED_OUT = Symbol("timed-out");
		let settledError: NodeJS.ErrnoException | undefined;
		const bindPromise = bindSessionSocket({
			socketPath: join(notADir, "y.sock"),
			onConnection: () => {},
			attempts: 1,
			isServing: async () => false,
			sleep: async () => {},
		}).catch((err: NodeJS.ErrnoException) => {
			settledError = err;
		});
		const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 400));
		const winner = await Promise.race([bindPromise.then(() => "settled"), timeoutPromise]);
		expect(winner).not.toBe(TIMED_OUT);
		expect(settledError?.code).toBe("ENOTDIR");
	});

	// test-contract: kill (mutantId 21760db02bebce41, `{force:true}` -> `{}`;
	// mutantId 26dee907168761fd, the nested `true` -> `false`) — assert the
	// EXACT rmSync call arguments used to clear a stale socket file, not just
	// that a retry succeeds.
	it("clears a stale socket via the exact rmSync(path, { force: true }) call", async () => {
		const socketPath = join(tmp, "retry-force-args.sock");
		writeFileSync(socketPath, "");
		const rmSpy = vi.mocked(fsMod.rmSync);
		rmSpy.mockClear();
		const server = await bindSessionSocket({
			socketPath,
			onConnection: () => {},
			isServing: async () => false,
			sleep: vi.fn(async () => {}),
		});
		expect(rmSpy).toHaveBeenCalledWith(socketPath, { force: true });
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	// test-contract: kill (mutantId 1a43f78a8e71f513, the default sleep arrow
	// -> `() => undefined`) — when no custom `sleep` is supplied, the real
	// default performs an actual timed delay (>= the first backoff entry);
	// the mutant returns instantly, so the whole retry completes far faster.
	it("uses the real default sleep (an actual timed delay) when none is supplied", async () => {
		const socketPath = join(tmp, "default-sleep.sock");
		writeFileSync(socketPath, "");
		const start = Date.now();
		const server = await bindSessionSocket({
			socketPath,
			onConnection: () => {},
			isServing: async () => false,
		});
		const elapsed = Date.now() - start;
		expect(server.listening).toBe(true);
		const firstBackoffMs = BIND_BACKOFF_MS[0] ?? 50;
		expect(elapsed).toBeGreaterThanOrEqual(firstBackoffMs - 10);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
});

// ---------------------------------------------------------------------------
// startSessionDaemon — directory setup, socket cleanup, onConnection wiring
// ---------------------------------------------------------------------------
describe("startSessionDaemon — mutation kills", () => {
	// test-contract: kill (mutantId 54fbd7eba1529c47, `15 * 60` -> `15 / 60`)
	// — the default idle window is 15 MINUTES; a mutant computing `15/60`
	// (~0.25s) would have self-stopped long before 14 minutes elapse.
	it("the default idle window is minutes, not a fraction of a second", async () => {
		vi.useFakeTimers();
		try {
			const paths = makePaths("idle-15min");
			daemon = await startSessionDaemon({
				paths,
				session_id: "idle-15min",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			});
			await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
			expect(existsSync(paths.pid)).toBe(true);
			await daemon.stop();
			daemon = null;
		} finally {
			vi.useRealTimers();
		}
	});

	// test-contract: kill (mutantIds a0cd963bd79d985d / 75fbf7b680e87a1c —
	// `.interlinked/` mkdir object+bool; 7ace9725beddff7d / 2cb414feba5f2251 —
	// `logs/` mkdir object+bool; and the negation/conditional variants
	// bda21b6d01f603ad / 161e4c9c1fd6d693 which would skip the call entirely)
	// — when both dirs are missing, mkdirSync must be called for EACH with the
	// exact `{ recursive: true }` option.
	it("creates both missing directories via the exact mkdirSync(path, { recursive: true }) calls", async () => {
		const root = join(tmp, "missing-root");
		const paths: DaemonPaths = {
			socket: join(root, "x.sock"),
			pid: join(root, "x.pid"),
			log: join(root, "logs", "x.log"),
		};
		expect(existsSync(root)).toBe(false);
		const mkdirSpy = vi.mocked(fsMod.mkdirSync);
		mkdirSpy.mockClear();
		daemon = await startSessionDaemon({
			paths,
			session_id: "missing-root",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(mkdirSpy).toHaveBeenCalledWith(root, { recursive: true });
		expect(mkdirSpy).toHaveBeenCalledWith(join(root, "logs"), { recursive: true });
	});

	// test-contract: kill (mutantId 0428b5ccdc46f6d9, `!existsSync(interlinkedDir)`
	// -> true; mutantId 29462d1971aa1664, `!existsSync(logsDir)` -> true) —
	// when both directories ALREADY exist, mkdirSync must not be invoked for
	// either path at all. A forced-true conditional would call it anyway
	// (harmless under real fs, but a real observable extra call).
	it("skips mkdirSync entirely for both dirs when they already exist", async () => {
		const logsDir = join(tmp, "logs");
		mkdirSync(logsDir, { recursive: true });
		const mkdirSpy = vi.mocked(fsMod.mkdirSync);
		mkdirSpy.mockClear();
		const paths = makePaths("exists-both");
		daemon = await startSessionDaemon({
			paths,
			session_id: "exists-both",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const calledPaths = mkdirSpy.mock.calls.map((c) => c[0]);
		expect(calledPaths).not.toContain(tmp);
		expect(calledPaths).not.toContain(logsDir);
	});

	// test-contract: kill (mutantId c315db352feadc1f, `existsSync(paths.socket)`
	// -> false; mutantId ccd8fa575186b704, `{force:true}` -> `{}`; mutantId
	// 26ee248fddfe4ed8, the nested `true` -> `false`) — a stale socket file
	// present at start must be removed via the exact rmSync call before bind.
	it("removes a stale leftover socket file via the exact rmSync(path, { force: true }) call", async () => {
		const paths = makePaths("stale-sock-args");
		writeFileSync(paths.socket, "stale");
		const rmSpy = vi.mocked(fsMod.rmSync);
		rmSpy.mockClear();
		daemon = await startSessionDaemon({
			paths,
			session_id: "stale-sock-args",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(rmSpy).toHaveBeenCalledWith(paths.socket, { force: true });
	});

	// test-contract: kill (mutantId fd164bfc8f08a784, `"error"` -> `""`;
	// mutantId 1bd6c3d70e861abe, the error handler arrow -> `() => undefined`)
	// — capture the REAL registration for the accepted socket's "error"
	// listener and invoke it directly: it must call `.destroy()` on that exact
	// socket. Either mutant makes the registration unfindable under "error" or
	// the invoked handler a no-op.
	it("the accepted socket's error handler destroys it", async () => {
		const paths = makePaths("error-handler-kill");
		const onSpy = vi.spyOn(Socket.prototype, "on");
		daemon = await startSessionDaemon({
			paths,
			session_id: "error-handler-kill",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const client = createConnection(paths.socket);
		await new Promise<void>((resolve) => client.on("connect", resolve));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const calls = onSpy.mock.calls as unknown as RawOnCall[];
		const contexts = onSpy.mock.contexts as unknown[];
		const index = calls.findIndex(([event], i) => event === "error" && contexts[i] !== client);
		expect(index).toBeGreaterThanOrEqual(0);
		const acceptedSocket = contexts[index] as Socket;
		const handler = calls[index]?.[1];
		const destroySpy = vi.spyOn(acceptedSocket, "destroy");
		handler?.();
		expect(destroySpy).toHaveBeenCalledTimes(1);
		onSpy.mockRestore();
		destroySpy.mockRestore();
		client.destroy();
	});

	// test-contract: kill (mutantId 3bf5d36ed0e35558, `"close"` -> `""`;
	// mutantId 7b05cac74ce59ec2, the close handler arrow -> `() => undefined`)
	// — capture the REAL registration for the accepted socket's "close"
	// listener, invoke it directly (removing it from the live client set), then
	// call `stop()`: stop()'s own destroy-loop over `clients` must NOT destroy
	// that socket again, since it was already removed. Either mutant leaves it
	// in the set, so stop() destroys it a second time.
	// Note: the client connection here is never actually closed (only the JS
	// "close" callback is invoked directly, not a real socket teardown), so
	// `stop()`'s later `server.close(callback)` legitimately never resolves —
	// awaiting the full stop() promise hangs until the suite times out. The
	// observable this test needs (whether stop()'s synchronous destroy-loop,
	// which runs before that await, touched the socket again) is available
	// as soon as that loop has run — so check it after a single microtask
	// flush rather than after full completion, and let the real connection
	// close (and the deferred stop() promise settle) afterward for cleanup.
	it("the accepted socket's close handler removes it from the live client set", async () => {
		const paths = makePaths("close-handler-kill");
		const onSpy = vi.spyOn(Socket.prototype, "on");
		daemon = await startSessionDaemon({
			paths,
			session_id: "close-handler-kill",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const client = createConnection(paths.socket);
		await new Promise<void>((resolve) => client.on("connect", resolve));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const calls = onSpy.mock.calls as unknown as RawOnCall[];
		const contexts = onSpy.mock.contexts as unknown[];
		const index = calls.findIndex(([event], i) => event === "close" && contexts[i] !== client);
		expect(index).toBeGreaterThanOrEqual(0);
		const acceptedSocket = contexts[index] as Socket;
		const handler = calls[index]?.[1];
		const destroySpy = vi.spyOn(acceptedSocket, "destroy");
		handler?.();
		const stopPromise = daemon.stop();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(destroySpy).toHaveBeenCalledTimes(0);
		onSpy.mockRestore();
		destroySpy.mockRestore();
		client.destroy();
		await stopPromise;
		daemon = null;
	});
});

// ---------------------------------------------------------------------------
// handle.stop() — re-entrancy guard, idle-timer guard, cleanup-loop exactness
// ---------------------------------------------------------------------------
describe("handle.stop() — mutation kills", () => {
	// test-contract: kill (mutantId d80eb80fda2578d3, `stopped = true` inner
	// literal -> false; mutantId 82bab4c1bbc3db53, the `if (stopped) return;`
	// guard -> false; mutantId 89d58f269d39bac8, the inner `!server` -> true;
	// mutantId afc0368ffbfd0e98, `!server` -> `server`) — a second stop() call
	// must be a total no-op: server.close() runs exactly once total across
	// BOTH calls. Any of these four mutants either lets the second call
	// re-execute the body (2 closes) or skips closing entirely (0 closes).
	it("guards re-entrancy: a second call performs zero additional server-close work", async () => {
		const paths = makePaths("reentrant-stop");
		daemon = await startSessionDaemon({
			paths,
			session_id: "reentrant-stop",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const closeSpy = vi.spyOn(Server.prototype, "close");
		await daemon.stop("first");
		await daemon.stop("second");
		expect(closeSpy).toHaveBeenCalledTimes(1);
		daemon = null;
		closeSpy.mockRestore();
	});

	// test-contract: kill (mutantId 6ebe7557b395de82, `if (idleTimer)` -> true)
	// — with idle_shutdown_ms 0, no timer is ever armed; stop() must not call
	// clearInterval at all. The mutant forces the guard true regardless.
	it("does not call clearInterval when no idle timer was armed", async () => {
		const paths = makePaths("idle-guard-none");
		daemon = await startSessionDaemon({
			paths,
			session_id: "idle-guard-none",
			idle_shutdown_ms: 0,
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const clearSpy = vi.spyOn(global, "clearInterval");
		await daemon.stop();
		daemon = null;
		expect(clearSpy).not.toHaveBeenCalled();
		clearSpy.mockRestore();
	});

	// test-contract: kill (mutantId 500431bf228874f5, `if (idleTimer)` -> false)
	// — with a real idle timer armed, stop() must clear it exactly once. The
	// mutant forces the guard false, skipping the clear entirely.
	it("clears the idle timer exactly once when one is armed", async () => {
		const paths = makePaths("idle-guard-some");
		daemon = await startSessionDaemon({
			paths,
			session_id: "idle-guard-some",
			idle_shutdown_ms: 5000,
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const clearSpy = vi.spyOn(global, "clearInterval");
		await daemon.stop();
		daemon = null;
		expect(clearSpy).toHaveBeenCalledTimes(1);
		clearSpy.mockRestore();
	});

	// test-contract: public-api — stop releases the PID ownership record; the
	// helper's own suite pins the successor-preserving conditional unlink.
	it("removes its owned pid record on stop", async () => {
		const paths = makePaths("stop-cleanup-args");
		daemon = await startSessionDaemon({
			paths,
			session_id: "stop-cleanup-args",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		await daemon.stop();
		daemon = null;
		expect(existsSync(paths.pid)).toBe(false);
	});

	// test-contract: boundary — external PID removal before stop remains an
	// idempotent cleanup case and is never recreated.
	it("tolerates a pid record removed externally before stop", async () => {
		const paths = makePaths("stop-skip-missing");
		daemon = await startSessionDaemon({
			paths,
			session_id: "stop-skip-missing",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		rmSync(paths.pid, { force: true });
		expect(existsSync(paths.pid)).toBe(false);
		await daemon.stop();
		daemon = null;
		expect(existsSync(paths.pid)).toBe(false);
	});
});
