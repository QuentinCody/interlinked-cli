import { makeServerRuntime } from "./__tests__/fixtures.js";
import { createTsgoRunner } from "../tsgo-runner.js";
// Startup guard — "reach listening, or die loudly" (audit F1, 2026-08-14).
//
// The behavior under test is the one the audit found inverted: a daemon that
// could not bind stayed alive, held the pid file, and answered nothing, while
// both diagnostics called it healthy. Every case below pins one half of the
// replacement contract — the latch that decides pre-listen from post-listen,
// and the terminal exit (distinct code + ledger row) that replaces surviving.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DaemonLedgerEvent } from "../daemon-ledger.js";
import { DaemonOwnershipConflictError } from "../session-daemon.js";
import { acquireStartupLock, startupLockPath } from "../startup-lock.js";
import {
	createStartupGuard,
	EXIT_STARTUP_FAILED,
	startFramedDaemonOrExit,
	type StartupGuardOptions,
} from "./startup-guard.js";

vi.mock("../session-daemon.js", async () => {
	const actual = await vi.importActual<typeof import("../session-daemon.js")>(
		"../session-daemon.js",
	);
	return {
		DaemonOwnershipConflictError: actual.DaemonOwnershipConflictError,
		startSessionDaemon: vi.fn(),
	};
});

function makeGuard(overrides: Partial<StartupGuardOptions> = {}) {
	const events: DaemonLedgerEvent[] = [];
	const exit = vi.fn();
	const logAlways = vi.fn();
	const install = vi.fn();
	const releaseStartup = vi.fn();
	const guard = createStartupGuard({
		cwd: "/repo",
		runRaw: true,
		runFramed: true,
		logAlways,
		exit,
		recordEvent: (evt) => events.push(evt),
		install,
		releaseStartup,
		...overrides,
	});
	return { guard, events, exit, logAlways, install, releaseStartup };
}

describe("createStartupGuard — the listening latch", () => {
	// P1: dual mode is complete only when BOTH sockets have reported.
	it("stays incomplete until every socket this mode runs reports", () => {
		const { guard, events, releaseStartup } = makeGuard();
		expect(guard.isStartupComplete()).toBe(false);
		guard.note("framed");
		expect(guard.isStartupComplete()).toBe(false);
		expect(events).toHaveLength(0);
		expect(releaseStartup).not.toHaveBeenCalled();
		guard.note("raw");
		expect(guard.isStartupComplete()).toBe(true);
		expect(events).toEqual([
			{ at: expect.any(Number), pid: process.pid, event: "listening" },
		]);
		expect(releaseStartup).toHaveBeenCalledTimes(1);
	});

	// P2: a mode that runs one socket waits for exactly that one.
	it("completes on the single socket a raw-only daemon runs", () => {
		const { guard, events } = makeGuard({ runFramed: false });
		guard.note("raw");
		expect(guard.isStartupComplete()).toBe(true);
		expect(events).toHaveLength(1);
	});

	it("completes on the single socket a framed-only daemon runs", () => {
		const { guard, events } = makeGuard({ runRaw: false });
		guard.note("framed");
		expect(guard.isStartupComplete()).toBe(true);
		expect(events).toHaveLength(1);
	});

	// P3: the ledger row is written once, not once per report.
	it("records the `listening` row exactly once however often sockets report", () => {
		const { guard, events, releaseStartup } = makeGuard();
		guard.note("raw");
		guard.note("framed");
		guard.note("framed");
		guard.note("raw");
		expect(events.filter((e) => e.event === "listening")).toHaveLength(1);
		expect(releaseStartup).toHaveBeenCalledTimes(1);
	});

	// P4 (attempt-ID protocol, 2026-08-29): a daemon spawned by a handover
	// acknowledges the attempt on its listening row — the pairing key that
	// makes churn counting order-independent.
	it("stamps the handover attempt id on the listening row", () => {
		const { guard, events } = makeGuard({ attemptId: "abc12345" });
		guard.note("raw");
		guard.note("framed");
		expect(events).toEqual([
			{ at: expect.any(Number), pid: process.pid, event: "listening", attempt_id: "abc12345" },
		]);
	});

	// P5: the default path consumes (reads + CLEARS) the inherited env var, so
	// a later handover this daemon spawns cannot leak a stale id.
	it("consumes INTERLINKED_HANDOVER_ATTEMPT from the env by default", () => {
		process.env.INTERLINKED_HANDOVER_ATTEMPT = "feed5eed";
		try {
			const { guard, events } = makeGuard();
			expect(process.env.INTERLINKED_HANDOVER_ATTEMPT).toBeUndefined();
			guard.note("raw");
			guard.note("framed");
			expect(events[0]?.attempt_id).toBe("feed5eed");
		} finally {
			delete process.env.INTERLINKED_HANDOVER_ATTEMPT;
		}
	});

	// N1: a guard that has not been told about any bind must never claim to be
	// serving — that claim is what re-enables survive-on-error.
	it("is incomplete with no reports at all", () => {
		expect(makeGuard().guard.isStartupComplete()).toBe(false);
		expect(makeGuard({ runRaw: false, runFramed: false }).guard.isStartupComplete()).toBe(false);
	});

	// P4: creating the guard ARMS the process handlers with itself — the two
	// halves of one policy, so neither can be wired without the other.
	it("installs itself as the crash-resilience policy", () => {
		const { guard, install } = makeGuard();
		expect(install).toHaveBeenCalledWith(guard);
	});

	it("releases the real daemon-owned startup lease after the final listener", () => {
		const root = mkdtempSync(join(tmpdir(), "interlinked-startup-guard-"));
		try {
			const lease = acquireStartupLock(root);
			expect(lease.acquired).toBe(true);
			const guard = createStartupGuard({
				cwd: root,
				runRaw: false,
				runFramed: true,
				logAlways: vi.fn(),
				recordEvent: vi.fn(),
				install: vi.fn(),
			});
			expect(existsSync(startupLockPath(root))).toBe(true);
			guard.note("framed");
			expect(existsSync(startupLockPath(root))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("releases the startup lease even when recording the listening row fails", () => {
		const releaseStartup = vi.fn();
		const guard = createStartupGuard({
			cwd: "/repo",
			runRaw: true,
			runFramed: false,
			logAlways: vi.fn(),
			recordEvent: () => {
				throw new Error("ledger unavailable");
			},
			releaseStartup,
			install: vi.fn(),
		});
		expect(() => guard.note("raw")).toThrow("ledger unavailable");
		expect(releaseStartup).toHaveBeenCalledTimes(1);
	});
});

describe("createStartupGuard — fail()", () => {
	// P1: distinct exit code + a `startup-failed` ledger row for THIS pid.
	it("logs, records startup-failed, and exits with the distinct code", () => {
		const { guard, events, exit, logAlways, releaseStartup } = makeGuard();
		guard.fail("raw socket bind", Object.assign(new Error("listen EADDRINUSE"), {
			code: "EADDRINUSE",
		}));
		expect(exit).toHaveBeenCalledWith(EXIT_STARTUP_FAILED);
		expect(EXIT_STARTUP_FAILED).not.toBe(0);
		const row = events.find((e) => e.event === "exit");
		expect(row?.reason).toBe("startup-failed");
		expect(row?.pid).toBe(process.pid);
		expect(row?.detail).toContain("raw socket bind");
		expect(row?.detail).toContain("listen EADDRINUSE");
		// The detail stays ONE line even though the log carries the full stack.
		expect(row?.detail).not.toContain("\n");
		expect(String(logAlways.mock.calls[0]?.[0])).toContain("FATAL during startup");
		expect(releaseStartup).toHaveBeenCalledTimes(1);
		expect(releaseStartup.mock.invocationCallOrder[0]).toBeLessThan(
			exit.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	// P2: a non-Error rejection value still produces a usable row.
	it("stringifies a non-Error failure", () => {
		const { guard, events } = makeGuard();
		guard.fail("framed bind", "socket path too long");
		expect(events.find((e) => e.event === "exit")?.detail).toContain("socket path too long");
	});

	// P3: `onStartupFailure` (what crash-resilience calls) is the same contract.
	it("routes onStartupFailure through fail()", () => {
		const { guard, exit, events } = makeGuard();
		guard.onStartupFailure?.("uncaughtException", new Error("boom"));
		expect(exit).toHaveBeenCalledWith(EXIT_STARTUP_FAILED);
		expect(events.find((e) => e.event === "exit")?.detail).toContain("uncaughtException");
	});

	it("still releases the startup lease and exits when the ledger write fails", () => {
		const exit = vi.fn();
		const releaseStartup = vi.fn();
		const guard = createStartupGuard({
			cwd: "/repo",
			runRaw: true,
			runFramed: false,
			logAlways: vi.fn(),
			exit,
			recordEvent: () => {
				throw new Error("ledger unavailable");
			},
			releaseStartup,
			install: vi.fn(),
		});
		expect(() => guard.fail("raw bind", new Error("boom"))).toThrow("ledger unavailable");
		expect(releaseStartup).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(EXIT_STARTUP_FAILED);
	});
});

describe("startFramedDaemonOrExit", () => {
	/** Spy set standing in for the anti-stomp loser contract. Inferred (not
	 *  annotated as `AntiStompDeps`) so the `.mock` handles stay typed. */
	function antiStomp() {
		return { logAlways: vi.fn(), recordExit: vi.fn(), exit: vi.fn() };
	}
	const runtime = makeServerRuntime();
	const opts: Parameters<typeof startFramedDaemonOrExit>[0] = {
		paths: { socket: "/repo/.interlinked/harness-default.sock", pid: "/p", log: "/l" },
		session_id: "default",
		state: {
			tsgo: createTsgoRunner(),
			getEvaluatorContext: () => ({ rules: runtime.rules, session: undefined, reservations: runtime.reservations, cohort: runtime.cohort }),
			evaluateHook: async () => ({ decision: "allow" }),
		},
	};

	// P1: success flips the framed half of the latch and returns the handle.
	it("notes the framed bind and returns the handle on success", async () => {
		const sd = await import("../session-daemon.js");
		const handle: Awaited<ReturnType<typeof sd.startSessionDaemon>> = { session_id: "default", paths: opts.paths, started_at: 0, stop: vi.fn(async () => {}), rpcInflight: vi.fn(() => 0) };
		vi.mocked(sd.startSessionDaemon).mockResolvedValueOnce(
			handle,
		);
		const { guard } = makeGuard({ runRaw: false });
		const result = await startFramedDaemonOrExit(opts, {
			cwd: "/repo",
			antiStomp: antiStomp(),
			startup: guard,
		});
		expect(result).toBe(handle);
		expect(guard.isStartupComplete()).toBe(true);
	});

	// P2: an ownership conflict is an ORDERLY loss — anti-stomp contract, not
	// a startup failure (different exit code, different ledger reason).
	it("routes an ownership conflict to the anti-stomp loser contract", async () => {
		const sd = await import("../session-daemon.js");
		vi.mocked(sd.startSessionDaemon).mockRejectedValueOnce(
			new DaemonOwnershipConflictError("default", 4242),
		);
		const deps = antiStomp();
		const { guard, exit, events } = makeGuard();
		await startFramedDaemonOrExit(opts, { cwd: "/repo", antiStomp: deps, startup: guard });
		expect(deps.exit).toHaveBeenCalledTimes(1);
		expect(deps.recordExit).toHaveBeenCalledTimes(1);
		expect(String(deps.logAlways.mock.calls[0]?.[0])).toContain(
			'already owns the framed session "default"',
		);
		// NOT a startup failure: no exit-78, no startup-failed row.
		expect(exit).not.toHaveBeenCalled();
		expect(events.some((e) => e.reason === "startup-failed")).toBe(false);
	});

	// P3: every other failure is terminal — this is the path that used to
	// rethrow into the survive handler and leave a socket-less daemon up.
	it("routes any other failure to the loud startup exit (never rethrows)", async () => {
		const sd = await import("../session-daemon.js");
		vi.mocked(sd.startSessionDaemon).mockRejectedValueOnce(
			Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
		);
		const deps = antiStomp();
		const { guard, exit, events } = makeGuard();
		await expect(
			startFramedDaemonOrExit(opts, { cwd: "/repo", antiStomp: deps, startup: guard }),
		).resolves.toBeNull();
		expect(exit).toHaveBeenCalledWith(EXIT_STARTUP_FAILED);
		expect(events.some((e) => e.reason === "startup-failed")).toBe(true);
		expect(deps.exit).not.toHaveBeenCalled();
		// A failed bind must not mark the daemon as serving.
		expect(guard.isStartupComplete()).toBe(false);
	});
});
