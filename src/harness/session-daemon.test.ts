import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileMutationProcessIdentity } from "../lib/file-mutation-lock-identity.js";
import { nonNull } from "../lib/non-null.js";
import { encodeFrame, type RpcMessage, splitFrames } from "./daemon-protocol.js";
import type { EvaluateUnifiedContext } from "./evaluator-unified.js";
import {
	claimSessionPid,
	DaemonOwnershipConflictError,
	removeOwnedSessionArtifacts,
	type SessionDaemonHandle,
	startSessionDaemon,
} from "./session-daemon.js";
import { BIND_ATTEMPTS, BIND_BACKOFF_MS, bindSessionSocket } from "./session-daemon-bind.js";
import type { DaemonPaths } from "./session-paths.js";
import type { TsgoRunner } from "./tsgo-runner.js";
import type { HarnessDecision } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

// Partial mock: keep every real helper (daemonPathsFor, sanitizeSessionId, ...)
// except `classifyDaemonSocket`, which the anti-stomp zombie-reap tests below
// need to control deterministically (serving / not-serving / throwing) rather
// than depend on a real socket-connect race.
vi.mock("./session-paths.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./session-paths.js")>();
	return { ...actual, classifyDaemonSocket: vi.fn(actual.classifyDaemonSocket) };
});

vi.mock("./daemon-process-identity.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./daemon-process-identity.js")>();
	return { ...actual, readHarnessProcessIdentity: vi.fn(() => "verified-daemon") };
});

let tmp = "";
let daemon: SessionDaemonHandle | null = null;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-sd-"));
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
	// Minimal stub — only used when hook.* RPCs are sent; most tests avoid those.
	return {
		rules: { version: 1, enabled: false } as unknown as EvaluateUnifiedContext["rules"],
		session: undefined,
		reservations: {} as EvaluateUnifiedContext["reservations"],
		cohort: {} as EvaluateUnifiedContext["cohort"],
	};
}

async function roundTrip(
	paths: DaemonPaths,
	request: RpcMessage,
	timeoutMs = 1500,
): Promise<RpcMessage> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(paths.socket);
		let pending = "";
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("timeout"));
		}, timeoutMs);
		socket.on("connect", () => {
			socket.write(encodeFrame(request));
		});
		socket.on("data", (b: Buffer) => {
			const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
			pending = remainder;
			if (frames.length > 0) {
				clearTimeout(timer);
				socket.destroy();
				try {
					resolve(JSON.parse(nonNull(frames[0])));
				} catch (err) {
					reject(err);
				}
			}
		});
		socket.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

// ---------------------------------------------------------------------------
// Bounded bind retry (audit F1). A transient EADDRINUSE at startup used to
// make the whole daemon fail; the retry converts the common cases (a
// predecessor's socket file left behind, a slow teardown) into a normal start
// — but never by stomping a socket that is actually answering.
// ---------------------------------------------------------------------------
describe("bindSessionSocket", () => {
	// P1: a stale socket file blocks the first attempt; the retry clears it and
	// binds. The point of the whole mechanism.
	it("clears a stale (non-answering) socket file and succeeds on a retry", async () => {
		const socketPath = join(tmp, "retry-stale.sock");
		writeFileSync(socketPath, ""); // a plain file at the socket path → EADDRINUSE
		const sleep = vi.fn(async () => {});
		const server = await bindSessionSocket({
			socketPath,
			onConnection: () => {},
			isServing: async () => false,
			sleep,
		});
		expect(server.listening).toBe(true);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(BIND_BACKOFF_MS[0]);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	// N1: a socket that ANSWERS belongs to a live incumbent — never unlink it,
	// and do not burn the remaining attempts pretending otherwise.
	it("refuses to stomp a SERVING socket: fails immediately, file intact", async () => {
		const socketPath = join(tmp, "retry-serving.sock");
		writeFileSync(socketPath, "incumbent");
		const sleep = vi.fn(async () => {});
		await expect(
			bindSessionSocket({
				socketPath,
				onConnection: () => {},
				isServing: async () => true,
				sleep,
			}),
		).rejects.toThrow(/EADDRINUSE/);
		expect(sleep).not.toHaveBeenCalled();
		expect(readFileSync(socketPath, "utf-8")).toBe("incumbent");
	});

	// N2: the retry is BOUNDED — a permanently unbindable path throws the last
	// error after exactly `attempts` tries rather than looping.
	it("gives up after the bounded number of attempts and throws the last error", async () => {
		const notADir = join(tmp, "retry-not-a-dir");
		writeFileSync(notADir, "");
		const sleep = vi.fn(async () => {});
		await expect(
			bindSessionSocket({
				socketPath: join(notADir, "nested.sock"),
				onConnection: () => {},
				isServing: async () => false,
				sleep,
			}),
		).rejects.toThrow();
		// attempts - 1 backoffs for BIND_ATTEMPTS attempts.
		expect(sleep).toHaveBeenCalledTimes(BIND_ATTEMPTS - 1);
	});

	// N3: one attempt means no retry at all (the knob is honored).
	it("honors an explicit attempts=1 (no retry, no backoff)", async () => {
		const socketPath = join(tmp, "retry-once.sock");
		writeFileSync(socketPath, "");
		const sleep = vi.fn(async () => {});
		await expect(
			bindSessionSocket({
				socketPath,
				onConnection: () => {},
				attempts: 1,
				isServing: async () => false,
				sleep,
			}),
		).rejects.toThrow(/EADDRINUSE/);
		expect(sleep).not.toHaveBeenCalled();
	});

	// P2: a happy first bind neither sleeps nor probes.
	it("binds on the first attempt without sleeping or probing", async () => {
		const sleep = vi.fn(async () => {});
		const isServing = vi.fn(async () => false);
		const server = await bindSessionSocket({
			socketPath: join(tmp, "retry-clean.sock"),
			onConnection: () => {},
			isServing,
			sleep,
		});
		expect(server.listening).toBe(true);
		expect(sleep).not.toHaveBeenCalled();
		expect(isServing).not.toHaveBeenCalled();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	// P3: a non-EADDRINUSE failure retries without touching the socket path —
	// the ownership rule only governs the "someone may own this" case.
	it("retries a non-EADDRINUSE failure without probing or unlinking", async () => {
		const socketPath = join(tmp, "retry-other.sock");
		writeFileSync(socketPath, "untouched");
		const isServing = vi.fn(async () => false);
		// Binding under a plain file yields ENOTDIR, not EADDRINUSE — the
		// branch that retries without consulting ownership at all.
		const sleep = vi.fn(async () => {});
		await expect(
			bindSessionSocket({
				socketPath: join(socketPath, "nested.sock"),
				onConnection: () => {},
				isServing,
				sleep,
			}),
		).rejects.toThrow();
		expect(isServing).not.toHaveBeenCalled();
		expect(readFileSync(socketPath, "utf-8")).toBe("untouched");
	});
});

describe("startSessionDaemon", () => {
	// P: the daemon's bind goes THROUGH the retry — a stale socket file left by
	// a dead predecessor no longer fails the start.
	it("starts over a stale leftover socket file (retry path, end to end)", async () => {
		const paths = makePaths("stale-retry");
		mkdirSync(tmp, { recursive: true });
		writeFileSync(paths.socket, "");
		daemon = await startSessionDaemon({
			paths,
			session_id: "stale-retry",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(existsSync(paths.socket)).toBe(true);
		expect(existsSync(paths.pid)).toBe(true);
	});

	it("creates pid + socket files and returns a handle", async () => {
		const paths = makePaths("t1");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t1",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(existsSync(paths.pid)).toBe(true);
		expect(existsSync(paths.socket)).toBe(true);
		expect(daemon.rpcInflight()).toBe(0);
	});

	it("serves daemon.health over the socket", async () => {
		const paths = makePaths("t2");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t2",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const response = await roundTrip(paths, {
			schema_version: "1",
			id: "h-1",
			method: "daemon.health",
			params: {},
		} as RpcMessage);
		const result = (response as { result: { status: string } }).result;
		expect(result.status).toBe("ready");
	});

	it("handles multiple framed requests on one connection", async () => {
		const paths = makePaths("t2b");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t2b",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const responses = await new Promise<RpcMessage[]>((resolve, reject) => {
			const socket = createConnection(paths.socket);
			let pending = "";
			const out: RpcMessage[] = [];
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timeout"));
			}, 1000);
			socket.on("connect", () => {
				socket.write(
					encodeFrame({
						schema_version: "1",
						id: "multi-1",
						method: "daemon.health",
						params: {},
					} as RpcMessage),
				);
				socket.write(
					encodeFrame({
						schema_version: "1",
						id: "multi-2",
						method: "daemon.invalidate",
						params: { path: "/a.ts" },
					} as RpcMessage),
				);
			});
			socket.on("data", (b: Buffer) => {
				const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
				pending = remainder;
				for (const frame of frames) out.push(JSON.parse(frame) as RpcMessage);
				if (out.length === 2) {
					clearTimeout(timer);
					socket.destroy();
					resolve(out);
				}
			});
			socket.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		expect(responses.map((response) => response.id).sort()).toEqual(["multi-1", "multi-2"]);
	});

	it("invalidate forwards to tsgo.invalidate and acks", async () => {
		const paths = makePaths("t3");
		const tsgo = makeTsgo();
		daemon = await startSessionDaemon({
			paths,
			session_id: "t3",
			state: { tsgo, getEvaluatorContext: makeEvaluatorContext },
		});
		await roundTrip(paths, {
			schema_version: "1",
			id: "inv-1",
			method: "daemon.invalidate",
			params: { path: "/x/y.ts" },
		} as RpcMessage);
		expect(nonNull((tsgo.invalidate as ReturnType<typeof vi.fn>).mock.calls[0])[0]).toBe("/x/y.ts");
	});

	it("responds with bad_request for malformed frames", async () => {
		const paths = makePaths("t4");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t4",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const response = await new Promise<RpcMessage>((resolve, reject) => {
			const socket = createConnection(paths.socket);
			let pending = "";
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timeout"));
			}, 1000);
			socket.on("connect", () => {
				socket.write("not valid json\n");
			});
			socket.on("data", (b: Buffer) => {
				const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
				pending = remainder;
				if (frames.length > 0) {
					clearTimeout(timer);
					socket.destroy();
					resolve(JSON.parse(nonNull(frames[0])));
				}
			});
			socket.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
		const asError = response as { error?: { code: string } };
		expect(asError.error?.code).toBe("bad_request");
		expect(response.id).toBe("unknown");
	});

	// -------------------------------------------------------------------------
	// Zombie-incumbent reap (regression: a live PID alone is NOT proof of a
	// healthy incumbent — `installCrashResilience()` keeps a daemon process
	// resident through an unexpected error even after its socket LISTENER
	// died. Mirrors the raw-socket path's four cases in
	// `server.ts` / `server.test.ts`'s "anti-stomp loser paths": a serving
	// incumbent still wins, a live-but-silent incumbent is reaped and taken
	// over, a dead pid takes over without even probing, and a throwing probe
	// fails safe by deferring.
	// -------------------------------------------------------------------------

	it("(a) refuses to steal a framed socket owned by a live AND SERVING PID", async () => {
		const paths = makePaths("owned-serving");
		writeFileSync(paths.pid, "1");
		writeFileSync(paths.socket, "");
		const sp = await import("./session-paths.js");
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValueOnce("ready");

		let caught: unknown;
		try {
			await startSessionDaemon({
				paths,
				session_id: "owned-serving",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			});
		} catch (err) {
			caught = err;
		}
		// Typed so server.ts can route it through the anti-stomp loser
		// contract instead of the generic survive-on-error crash handler.
		expect(caught).toBeInstanceOf(DaemonOwnershipConflictError);
		expect((caught as DaemonOwnershipConflictError).ownerPid).toBe(1);
		expect((caught as DaemonOwnershipConflictError).name).toBe("DaemonOwnershipConflictError");
		expect((caught as Error).message).toContain("already running");
		// A losing claim must never touch the socket or pid path — the
		// pre-seeded placeholder content proves nothing rebound over them.
		expect(readFileSync(paths.socket, "utf-8")).toBe("");
		expect(readFileSync(paths.pid, "utf-8")).toBe("1");
	});

	it("refuses a protocol-ready framed socket whose pid file is missing", async () => {
		const paths = makePaths("ready-no-pid");
		writeFileSync(paths.socket, "listener-placeholder");
		const sp = await import("./session-paths.js");
		vi.mocked(sp.classifyDaemonSocket).mockResolvedValueOnce("ready");
		await expect(
			startSessionDaemon({
				paths,
				session_id: "ready-no-pid",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			}),
		).rejects.toBeInstanceOf(DaemonOwnershipConflictError);
		expect(existsSync(paths.pid)).toBe(false);
		expect(readFileSync(paths.socket, "utf8")).toBe("listener-placeholder");
	});

	it("preserves a protocol-silent listener with no pid rather than unlinking it", async () => {
		const paths = makePaths("silent-no-pid");
		writeFileSync(paths.socket, "listener-placeholder");
		const sp = await import("./session-paths.js");
		vi.mocked(sp.classifyDaemonSocket)
			.mockResolvedValueOnce("occupied_unready")
			.mockResolvedValueOnce("occupied_unready");
		await expect(
			startSessionDaemon({
				paths,
				session_id: "silent-no-pid",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			}),
		).rejects.toThrow("did not prove the Interlinked protocol");
		expect(existsSync(paths.pid)).toBe(false);
		expect(readFileSync(paths.socket, "utf8")).toBe("listener-placeholder");
	});

	it("(b) a live but NOT SERVING incumbent is reaped and taken over (no throw)", async () => {
		const paths = makePaths("owned-zombie");
		writeFileSync(paths.pid, "1");
		writeFileSync(paths.socket, "");
		const sp = await import("./session-paths.js");
		vi.mocked(sp.classifyDaemonSocket)
			.mockResolvedValueOnce("occupied_unready")
			.mockResolvedValueOnce("occupied_unready");
		let alive = true;
		const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			if (signal === "SIGTERM") alive = false;
			if (signal === 0 && !alive) {
				const error = new Error("gone") as NodeJS.ErrnoException;
				error.code = "ESRCH";
				throw error;
			}
			return true;
		});

		daemon = await startSessionDaemon({
			paths,
			session_id: "owned-zombie",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(killSpy).toHaveBeenCalledWith(1, "SIGTERM");
		// The stale claim is force-taken over: OUR pid now owns the file, and
		// the daemon bound its own socket over the placeholder.
		expect(readFileSync(paths.pid, "utf-8")).toBe(String(process.pid));
		expect(existsSync(paths.socket)).toBe(true);
		killSpy.mockRestore();
	});

	it("(b2) a failed verified reap aborts takeover and preserves the incumbent metadata", async () => {
		const paths = makePaths("owned-zombie-log");
		writeFileSync(paths.pid, "1");
		writeFileSync(paths.socket, "");
		const sp = await import("./session-paths.js");
		vi.mocked(sp.classifyDaemonSocket)
			.mockResolvedValueOnce("occupied_unready")
			.mockResolvedValueOnce("occupied_unready");
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			const error = new Error("operation not permitted") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		try {
			await expect(
				startSessionDaemon({
				paths,
				session_id: "owned-zombie-log",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
				}),
			).rejects.toThrow("could not be stopped");
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not signal zombie incumbent PID 1"));
			expect(readFileSync(paths.pid, "utf-8")).toBe("1");
			expect(readFileSync(paths.socket, "utf-8")).toBe("");
		} finally {
			killSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("(c) a dead pid takes over without probing the socket", async () => {
		const paths = makePaths("owned-dead");
		writeFileSync(paths.pid, "2147480000"); // effectively never live on a test host
		const sp = await import("./session-paths.js");
		vi.mocked(sp.classifyDaemonSocket).mockClear();

		daemon = await startSessionDaemon({
			paths,
			session_id: "owned-dead",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(vi.mocked(sp.classifyDaemonSocket)).not.toHaveBeenCalled();
		expect(readFileSync(paths.pid, "utf-8")).toBe(String(process.pid));
	});

	it("reclaims metadata whose numeric pid was reused by an unrelated process", async () => {
		const paths = makePaths("reused-unrelated-pid");
		writeFileSync(paths.pid, String(process.ppid));
		const identity = await import("./daemon-process-identity.js");
		vi.mocked(identity.readHarnessProcessIdentity).mockReturnValueOnce(null);
		const killSpy = vi.spyOn(process, "kill");

		daemon = await startSessionDaemon({
			paths,
			session_id: "reused-unrelated-pid",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});

		expect(readFileSync(paths.pid, "utf8")).toBe(String(process.pid));
		expect(killSpy.mock.calls.some((call) => call[1] === "SIGTERM" || call[1] === "SIGKILL")).toBe(
			false,
		);
		killSpy.mockRestore();
	});

	it("(d) a throwing probe fails safe and defers to the incumbent (throws)", async () => {
		const paths = makePaths("owned-throw");
		writeFileSync(paths.pid, "1");
		writeFileSync(paths.socket, "");
		const sp = await import("./session-paths.js");
		vi.mocked(sp.classifyDaemonSocket).mockRejectedValueOnce(new Error("unexpected probe failure"));

		let caught: unknown;
		try {
			await startSessionDaemon({
				paths,
				session_id: "owned-throw",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("Could not determine");
		// Never stomped the placeholder socket while deferring.
		expect(readFileSync(paths.socket, "utf-8")).toBe("");
	});

	it("releases its pid claim if the socket bind subsequently fails", async () => {
		// Force a genuine bind failure (ENOTDIR) unrelated to file existence:
		// the socket's parent path component is a plain FILE, not a
		// directory. `paths.pid` lives in a normal directory so the claim
		// still succeeds; only the LATER bind fails, exercising the release
		// path without the pre-bind `rmSync(paths.socket, …)` cleanup (which
		// only ever removes a STALE artifact — never a live rival's socket,
		// since a live rival would already have failed the pid claim above)
		// masking the scenario.
		const notADir = join(tmp, "not-a-directory");
		writeFileSync(notADir, "");
		const paths = {
			socket: join(notADir, "harness-bindfail.sock"),
			pid: join(tmp, "harness-bindfail.pid"),
			log: join(tmp, "logs", "daemon-bindfail.log"),
		};
		await expect(
			startSessionDaemon({
				paths,
				session_id: "bindfail",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			}),
		).rejects.toThrow();
		expect(existsSync(paths.pid)).toBe(false);
	});

	it("claimSessionPid: two different (both-alive) pids racing for the same path — exactly one wins, regardless of call order", () => {
		const pidPath = join(tmp, "claim-race.pid");

		const a = claimSessionPid(pidPath, process.pid);
		const b = claimSessionPid(pidPath, process.ppid);
		expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
		expect(a.claimed).toBe(true);
		expect(b).toEqual({ claimed: false, ownerPid: process.pid });

		rmSync(pidPath, { force: true });

		// Reversed order: confirms the winner is whoever claims FIRST, not a
		// fixed argument-position bias.
		const c = claimSessionPid(pidPath, process.ppid);
		const d = claimSessionPid(pidPath, process.pid);
		expect([c.claimed, d.claimed].filter(Boolean)).toHaveLength(1);
		expect(c.claimed).toBe(true);
		expect(d).toEqual({ claimed: false, ownerPid: process.ppid });
	});

	it("claimSessionPid: a dead process's stale claim is stolen, not treated as a conflict", () => {
		const pidPath = join(tmp, "stale-claim.pid");
		writeFileSync(pidPath, "2147480000"); // effectively never live on a test host

		const claim = claimSessionPid(pidPath, process.pid);
		expect(claim).toEqual({ claimed: true });
		expect(readFileSync(pidPath, "utf-8")).toBe(String(process.pid));
	});

	it("claimSessionPid: an expired claim lock is recovered even when its pid was reused", () => {
		const pidPath = join(tmp, "reused-lock-owner.pid");
		const identity = readFileMutationProcessIdentity(process.pid, Date.now());
		writeFileSync(
			`${pidPath}.claim`,
			`${JSON.stringify({
				pid: process.pid,
				token: "abandoned-before-pid-reuse",
				created_at_ms: Date.now() - 60_000,
				boot_id: identity.bootId,
				process_start_id: `${identity.processStartId ?? "unavailable"}:prior-owner`,
			})}\n`,
		);

		expect(claimSessionPid(pidPath, process.pid)).toEqual({ claimed: true });
		expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid));
		expect(existsSync(`${pidPath}.claim`)).toBe(false);
	});

	it("claimSessionPid: an existing claim by this same pid is re-claimed", () => {
		const pidPath = join(tmp, "self-claim.pid");
		writeFileSync(pidPath, String(process.pid));

		expect(claimSessionPid(pidPath, process.pid)).toEqual({ claimed: true });
		expect(readFileSync(pidPath, "utf-8")).toBe(String(process.pid));
	});

	it("claimSessionPid: zero is not a valid persisted pid", () => {
		const pidPath = join(tmp, "zero-claim.pid");
		writeFileSync(pidPath, "0");

		expect(claimSessionPid(pidPath, process.pid)).toEqual({ claimed: true });
		expect(readFileSync(pidPath, "utf-8")).toBe(String(process.pid));
	});

	it("claimSessionPid: a valid foreign pid remains a conflict", () => {
		const pidPath = join(tmp, "valid-foreign-claim.pid");
		writeFileSync(pidPath, String(process.pid));
		const claimingPid = process.pid === 1 ? 2 : 1;

		expect(claimSessionPid(pidPath, claimingPid)).toEqual({
			claimed: false,
			ownerPid: process.pid,
		});
	});

	it("stop() removes the pid and socket files", async () => {
		const paths = makePaths("t5");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t5",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		await daemon.stop();
		daemon = null;
		expect(existsSync(paths.pid)).toBe(false);
		expect(existsSync(paths.socket)).toBe(false);
	});

	it("predecessor cleanup after handover preserves the successor pid and socket path", () => {
		const paths = makePaths("handover-cleanup");
		const predecessorPid = 41;
		const successorPid = 42;
		writeFileSync(paths.pid, String(successorPid));
		writeFileSync(paths.socket, "successor-socket");
		removeOwnedSessionArtifacts(paths, predecessorPid);
		expect(readFileSync(paths.pid, "utf8")).toBe(String(successorPid));
		expect(readFileSync(paths.socket, "utf8")).toBe("successor-socket");
	});

	it("daemon.shutdown RPC drives state.shutdown -> handle.stop() (line 134)", async () => {
		const paths = makePaths("t6");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t6",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		// `state.shutdown` (the daemon.shutdown handler) fires `void handle.stop()`
		// SYNCHRONOUSLY inside `dispatchRpc`, before the handler writes its ack —
		// and `stop()` destroys every connected client (including this one) as
		// its very first synchronous act. So the client-visible contract here is
		// "the connection is torn down", not "an ack frame arrives" — assert the
		// socket closes and the daemon actually tore itself down.
		const closed = await new Promise<boolean>((resolve, reject) => {
			const socket = createConnection(paths.socket);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timeout"));
			}, 1500);
			socket.on("connect", () => {
				socket.write(
					encodeFrame({
						schema_version: "1",
						id: "shut-1",
						method: "daemon.shutdown",
						params: { reason: "test" },
					} as RpcMessage),
				);
			});
			socket.on("close", () => {
				clearTimeout(timer);
				resolve(true);
			});
			socket.on("error", () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		expect(closed).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(existsSync(paths.pid)).toBe(false);
		expect(existsSync(paths.socket)).toBe(false);
	});

	it("a decoded response-shaped (non-request) frame is dropped silently (line 169)", async () => {
		const paths = makePaths("t7");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t7",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		const responses = await new Promise<RpcMessage[]>((resolve, reject) => {
			const socket = createConnection(paths.socket);
			let pending = "";
			const out: RpcMessage[] = [];
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("timeout"));
			}, 1000);
			socket.on("connect", () => {
				// A well-formed, decodable frame with an `id` but no `method` —
				// isRequest() returns false, so the daemon must drop it silently
				// and never write a reply for it.
				socket.write(`${JSON.stringify({ schema_version: "1", id: "resp-1", result: { ok: true } })}\n`);
				socket.write(
					encodeFrame({
						schema_version: "1",
						id: "real-1",
						method: "daemon.health",
						params: {},
					} as RpcMessage),
				);
			});
			socket.on("data", (b: Buffer) => {
				const { frames, remainder } = splitFrames(b.toString("utf-8"), pending);
				pending = remainder;
				for (const frame of frames) out.push(JSON.parse(frame) as RpcMessage);
			});
			socket.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			// Only one real response is ever written back; give the socket a
			// moment to prove no second frame follows, then resolve.
			setTimeout(() => {
				clearTimeout(timer);
				socket.destroy();
				resolve(out);
			}, 300);
		});
		expect(responses.map((r) => r.id)).toEqual(["real-1"]);
	});

	it("a rejecting evaluateHook makes dispatchRpc throw, caught into an internal error (line 177)", async () => {
		const paths = makePaths("t8");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t8",
			state: {
				tsgo: makeTsgo(),
				getEvaluatorContext: makeEvaluatorContext,
				evaluateHook: vi.fn().mockRejectedValue(new Error("boom")),
			},
		});
		const response = await roundTrip(paths, {
			schema_version: "1",
			id: "hook-1",
			method: "hook.pre_tool_use",
			params: {
				schema_version: "1",
				event_id: "e1",
				session_id: "t8",
				ts: "2026-08-05T00:00:00.000Z",
				runner: "claude",
				runner_native_event: "PreToolUse",
				phase: "pre-tool",
				context: { cwd: "/repo" },
				action: { kind: "tool_call", tool_name: "Bash", tool_input: {} },
			},
		} as unknown as RpcMessage);
		const asError = response as { error?: { code: string; message: string } };
		expect(asError.error?.code).toBe("internal");
		expect(asError.error?.message).toBe("boom");
	});

	it("the idle-shutdown poller stops the daemon after true inactivity (lines 202-204)", async () => {
		const paths = makePaths("t9");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t9",
			idle_shutdown_ms: 50,
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		// No activity at all after start — wait past the idle window plus the
		// poller's own tick interval (Math.min(idleMs, 60_000) = 50ms).
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(paths.pid)).toBe(false);
		expect(existsSync(paths.socket)).toBe(false);
		daemon = null;
	});

	it("the idle-shutdown poller stops at the inactivity threshold", async () => {
		vi.useFakeTimers();
		try {
			const paths = makePaths("idle-boundary");
			daemon = await startSessionDaemon({
				paths,
				session_id: "idle-boundary",
				idle_shutdown_ms: 100,
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			});

			await vi.advanceTimersByTimeAsync(99);
			expect(existsSync(paths.pid)).toBe(true);
			await vi.advanceTimersByTimeAsync(1);
			expect(existsSync(paths.pid)).toBe(false);
			daemon = null;
		} finally {
			vi.useRealTimers();
		}
	});

	it("the default idle window does not shut down immediately", async () => {
		vi.useFakeTimers();
		try {
			const paths = makePaths("idle-default");
			daemon = await startSessionDaemon({
				paths,
				session_id: "idle-default",
				state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
			});

			await vi.advanceTimersByTimeAsync(1);
			expect(existsSync(paths.pid)).toBe(true);
			await daemon.stop();
			daemon = null;
		} finally {
			vi.useRealTimers();
		}
	});

	it("the idle-shutdown poller does not fire while requests are still in flight (line 202 true side)", async () => {
		const paths = makePaths("t10");
		daemon = await startSessionDaemon({
			paths,
			session_id: "t10",
			idle_shutdown_ms: 50,
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		// A live connection kept open plus recent traffic resets lastActivity
		// on every frame, so a single idle-window wait alone would already
		// prove the timer branch — assert the daemon is still alive right up
		// against the idle window as the direct evidence.
		await roundTrip(paths, {
			schema_version: "1",
			id: "keepalive-1",
			method: "daemon.health",
			params: {},
		} as RpcMessage);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(existsSync(paths.pid)).toBe(true);
		expect(existsSync(paths.socket)).toBe(true);
	});

	it("claimSessionPid: a path that is a directory fails the read as null, then throws on the write attempt (line 241)", () => {
		const dirPidPath = join(tmp, "pid-is-a-dir");
		mkdirSync(dirPidPath);
		expect(() => claimSessionPid(dirPidPath, process.pid)).toThrow();
	});

	it("claimSessionPid: a non-EEXIST wx-write failure (permission denied) is rethrown, not swallowed (branch 88 true side)", () => {
		const readonlyDir = join(tmp, "readonly");
		mkdirSync(readonlyDir);
		chmodSync(readonlyDir, 0o555);
		const target = join(readonlyDir, "harness.pid");
		try {
			expect(() => claimSessionPid(target, process.pid)).toThrow(/EACCES|permission denied/);
		} finally {
			// Restore write permission so afterEach's rmSync(tmp, {recursive:true}) can clean up.
			chmodSync(readonlyDir, 0o755);
		}
	});

	it("claimSessionPid: readPidFile treats non-numeric / non-positive content as absent (branch 239 false side)", () => {
		const pidPath = join(tmp, "garbage.pid");
		writeFileSync(pidPath, "not-a-pid");
		// existingPid resolves to null (NaN is not finite), so the claim
		// proceeds as if nothing were there and succeeds outright.
		const claim = claimSessionPid(pidPath, process.pid);
		expect(claim).toEqual({ claimed: true });
	});

	it("startSessionDaemon creates missing .interlinked/ and logs/ directories on first start (lines 111, 113 true side)", async () => {
		const nestedRoot = join(tmp, "not-yet-created");
		const paths: DaemonPaths = {
			socket: join(nestedRoot, "harness-nested.sock"),
			pid: join(nestedRoot, "harness-nested.pid"),
			log: join(nestedRoot, "logs", "daemon-nested.log"),
		};
		expect(existsSync(nestedRoot)).toBe(false);
		daemon = await startSessionDaemon({
			paths,
			session_id: "nested",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(existsSync(nestedRoot)).toBe(true);
		expect(existsSync(join(nestedRoot, "logs"))).toBe(true);
	});

	it("skips mkdirSync for the logs/ directory when it already exists (branch 113 false side)", async () => {
		const preexistingLogsDir = join(tmp, "logs");
		mkdirSync(preexistingLogsDir, { recursive: true });
		expect(existsSync(preexistingLogsDir)).toBe(true);
		const paths = makePaths("preexisting-logs");
		daemon = await startSessionDaemon({
			paths,
			session_id: "preexisting-logs",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		expect(existsSync(paths.pid)).toBe(true);
	});

	it("startSessionDaemon removes a stale leftover socket file before binding (line 122 true side)", async () => {
		const paths = makePaths("stale-sock");
		writeFileSync(paths.socket, "stale placeholder, not a real socket");
		expect(existsSync(paths.socket)).toBe(true);
		daemon = await startSessionDaemon({
			paths,
			session_id: "stale-sock",
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		// The real bind succeeded (the stale file was removed first) — the path
		// now exists again, but as a genuine live socket, not the placeholder.
		expect(existsSync(paths.socket)).toBe(true);
	});

	it("idle_shutdown_ms: 0 disables the poller entirely — stop() then skips clearInterval (branches 199, 219 false sides)", async () => {
		const paths = makePaths("no-idle");
		daemon = await startSessionDaemon({
			paths,
			session_id: "no-idle",
			idle_shutdown_ms: 0,
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		// No idle timer was armed; give it well past any short idle window to
		// prove it never self-stops.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(existsSync(paths.pid)).toBe(true);
		await daemon.stop();
		daemon = null;
		expect(existsSync(paths.pid)).toBe(false);
	});

	it("the idle poller's inflight guard defers shutdown while a slow RPC is still in flight (branch 202 true side)", async () => {
		const paths = makePaths("slow-inflight");
		let resolveHook: (() => void) | undefined;
		const slowEvaluateHook = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveHook = () => resolve({ decision: "allow" });
				}),
		);
		daemon = await startSessionDaemon({
			paths,
			session_id: "slow-inflight",
			idle_shutdown_ms: 50,
			state: {
				tsgo: makeTsgo(),
				getEvaluatorContext: makeEvaluatorContext,
				evaluateHook: slowEvaluateHook as unknown as (
					event: UnifiedHookEvent,
				) => Promise<HarnessDecision>,
			},
		});
		// Fire the slow hook RPC without awaiting it — it stays in flight.
		const pending = roundTrip(paths, {
			schema_version: "1",
			id: "slow-1",
			method: "hook.pre_tool_use",
			params: {
				schema_version: "1",
				event_id: "e-slow",
				session_id: "slow-inflight",
				ts: "2026-08-05T00:00:00.000Z",
				runner: "claude",
				runner_native_event: "PreToolUse",
				phase: "pre-tool",
				context: { cwd: "/repo" },
				action: { kind: "tool_call", tool_name: "Bash", tool_input: {} },
			},
		} as unknown as RpcMessage);
		// Let at least two idle-poller ticks (50ms each) pass while inflight>0.
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(existsSync(paths.pid)).toBe(true);
		expect(daemon.rpcInflight()).toBe(1);
		resolveHook?.();
		await pending;
		expect(daemon.rpcInflight()).toBe(0);
	});

	it("the idle poller's window check survives a tick when recent activity keeps the daemon under the threshold (branch 203 true side)", async () => {
		const paths = makePaths("under-window");
		daemon = await startSessionDaemon({
			paths,
			session_id: "under-window",
			idle_shutdown_ms: 200,
			state: { tsgo: makeTsgo(), getEvaluatorContext: makeEvaluatorContext },
		});
		// Wait most of the way through the first 200ms tick period, THEN send
		// activity — so when the first tick fires (~200ms from start),
		// `Date.now() - lastActivity` is small (a comfortable margin under the
		// threshold, not a borderline value right at it) and the poller must
		// take the "survive" branch rather than stopping.
		await new Promise((resolve) => setTimeout(resolve, 150));
		await roundTrip(paths, {
			schema_version: "1",
			id: "keepalive-2",
			method: "daemon.health",
			params: {},
		} as RpcMessage);
		// Land the check comfortably after the first tick (~200ms) but well
		// before the second (~400ms).
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(existsSync(paths.pid)).toBe(true);
	});
});
