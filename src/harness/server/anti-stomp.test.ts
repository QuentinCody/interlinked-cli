import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type AntiStompDeps,
	antiStompDepsFor,
	loseAntiStompRace,
	reapZombieIncumbent,
	removeOwnPidLitter,
} from "./anti-stomp.js";

function makeDeps(): AntiStompDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		logAlways: vi.fn(() => calls.push("log")),
		recordExit: vi.fn(() => calls.push("recordExit")),
		exit: vi.fn(() => calls.push("exit")),
	};
}

describe("antiStompDepsFor", () => {
	// P: the real deps append an `anti-stomp` exit row for THIS pid. Losing a
	// race is orderly, so it is code 0 — a FAILED startup is not (exit 78,
	// reason `startup-failed`; see ./startup-guard.ts).
	it("records an anti-stomp exit row for this process", () => {
		const dir = mkdtempSync(join(tmpdir(), "anti-stomp-deps-"));
		// interlinked: defer conditional_in_test -- try/finally is tmpdir cleanup, not case branching; the assertion path is single
		try {
			const logAlways = vi.fn();
			antiStompDepsFor(dir, logAlways).recordExit();
			const row = readFileSync(join(dir, ".interlinked", "daemon-events.jsonl"), "utf-8");
			expect(JSON.parse(row.trim())).toMatchObject({
				event: "exit",
				reason: "anti-stomp",
				pid: process.pid,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// test-contract: invariant — a loser spawned for a handover attempt stamps
	// the attempt id on its exit row, so the churn reducer RESOLVES the
	// attempt (four lost races in a window must never re-trip the backoff).
	it("stamps the inherited handover attempt id on the exit row", () => {
		const dir = mkdtempSync(join(tmpdir(), "anti-stomp-attempt-"));
		process.env.INTERLINKED_HANDOVER_ATTEMPT = "dead0002";
		// interlinked: defer conditional_in_test -- try/finally is env+tmpdir cleanup, not case branching
		try {
			antiStompDepsFor(dir, vi.fn()).recordExit();
			const row = readFileSync(join(dir, ".interlinked", "daemon-events.jsonl"), "utf-8");
			expect(JSON.parse(row.trim())).toMatchObject({
				event: "exit",
				reason: "anti-stomp",
				attempt_id: "dead0002",
			});
		} finally {
			delete process.env.INTERLINKED_HANDOVER_ATTEMPT;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// P: the logger is passed straight through — the daemon's own stderr.
	it("delegates logging to the supplied logger", () => {
		const seen: string[] = [];
		antiStompDepsFor("/repo", (msg) => seen.push(msg)).logAlways("hello");
		expect(seen).toEqual(["hello"]);
	});
});

describe("loseAntiStompRace", () => {
	it("logs, records the ledger exit, then exits — in that exact order (must fire)", () => {
		const deps = makeDeps();
		loseAntiStompRace({ ownerPid: 4242, detail: "the raw socket", cwd: "/repo", deps });

		expect(deps.calls).toEqual(["log", "recordExit", "exit"]);
		expect(deps.logAlways).toHaveBeenCalledTimes(1);
		expect(deps.recordExit).toHaveBeenCalledTimes(1);
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});

	it("includes the owner pid, the contested detail, and the cwd in the logged message", () => {
		const deps = makeDeps();
		loseAntiStompRace({
			ownerPid: 9999,
			detail: 'the framed session "default"',
			cwd: "/Users/x/project",
			deps,
		});

		const logged = String(vi.mocked(deps.logAlways).mock.calls[0]?.[0]);
		expect(logged).toContain("PID 9999");
		expect(logged).toContain('the framed session "default"');
		expect(logged).toContain("/Users/x/project");
		expect(logged).toContain("interlinked harness restart");
	});

	it("still calls recordExit and exit even though the log message differs per call (must not skip on differing input)", () => {
		// Negative-shape case: a caller passing an unusual detail string
		// (empty, or containing the ownerPid's own digits) must not
		// short-circuit the contract — recordExit/exit are unconditional.
		const deps = makeDeps();
		loseAntiStompRace({ ownerPid: 1, detail: "", cwd: "", deps });
		expect(deps.calls).toEqual(["log", "recordExit", "exit"]);
	});

	it("propagates a throwing exit() (the real process.exit test-double shape) rather than swallowing it", () => {
		// Test doubles for `process.exit` in this codebase throw a sentinel
		// (see server.test.ts's ProcessExitError) since a real exit() never
		// returns. loseAntiStompRace must not catch that — a caller relying
		// on "exit() throws to unwind the stack" needs it to actually
		// propagate, and recordExit must already have run by then.
		const deps = makeDeps();
		const boom = new Error("process.exit(0)");
		vi.mocked(deps.exit).mockImplementation(() => {
			deps.calls.push("exit");
			throw boom;
		});
		expect(() =>
			loseAntiStompRace({ ownerPid: 7, detail: "the raw socket", cwd: "/x", deps }),
		).toThrow(boom);
		expect(deps.calls).toEqual(["log", "recordExit", "exit"]);
	});
});

describe("reapZombieIncumbent", () => {
	it("SIGTERMs a twice-verified daemon and waits until that process is gone", async () => {
		const signalsSent: Array<[number, string]> = [];
		const logAlways = vi.fn();
		let alive = true;
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways,
			deps: {
				identify: () => "daemon-identity",
				kill: (pid, signal) => {
					signalsSent.push([pid, signal]);
					alive = false;
				},
				isAlive: () => alive,
				sleep: async () => {},
			},
		});
		expect(result).toBe("gone");
		expect(signalsSent).toEqual([[4242, "SIGTERM"]]);
		expect(logAlways).not.toHaveBeenCalled();
	});

	it("silently accepts ESRCH when the verified process is already gone", async () => {
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways: vi.fn(),
			deps: { identify: () => "daemon-identity", isAlive: () => true, kill: () => {
			// SAFETY: ErrnoException is Error plus optional string fields; adding `code` below makes the shape real.
			const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
			err.code = "ESRCH";
			throw err;
			} },
		});
		expect(result).toBe("gone");
	});

	it("returns failed and logs an unexpected signalling failure", async () => {
		const logAlways = vi.fn();
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways,
			deps: { identify: () => "daemon-identity", isAlive: () => true, kill: () => {
			// SAFETY: ErrnoException is Error plus optional string fields; adding `code` below makes the shape real.
			const err = new Error("kill EPERM") as NodeJS.ErrnoException;
			err.code = "EPERM";
			throw err;
			} },
		});
		expect(result).toBe("failed");
		expect(logAlways).toHaveBeenCalledTimes(1);
		expect(String(logAlways.mock.calls[0]?.[0])).toContain("4242");
	});

	it("never signals an unverified pid", async () => {
		const kill = vi.fn();
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways: vi.fn(),
			deps: { identify: () => null, isAlive: () => true, kill },
		});
		expect(result).toBe("unverified");
		expect(kill).not.toHaveBeenCalled();
	});

	it("treats already-exited stale pid metadata as gone even when identity is unavailable", async () => {
		const kill = vi.fn();
		const logAlways = vi.fn();
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways,
			deps: { identify: () => null, isAlive: () => false, kill },
		});
		expect(result).toBe("gone");
		expect(kill).not.toHaveBeenCalled();
		expect(logAlways).not.toHaveBeenCalled();
	});

	it("does not SIGKILL a replacement that reuses the numeric pid", async () => {
		const identify = vi
			.fn<() => string | null>()
			.mockReturnValueOnce("original")
			.mockReturnValueOnce("original")
			.mockReturnValue("replacement");
		const kill = vi.fn();
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways: vi.fn(),
			deps: { identify, kill, isAlive: () => true, sleep: async () => {} },
		});
		expect(result).toBe("replaced");
		expect(kill).toHaveBeenCalledTimes(1);
		expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
	});

	it("polls with its own timer-backed sleeper when no sleep is injected", async () => {
		// No `sleep` dep: the loop must fall back to the module's real
		// setTimeout-backed sleeper, so one poll interval of wall time elapses.
		const kill = vi.fn();
		// Alive for the entry guard and the first poll, gone by the second — so
		// exactly one poll interval is waited through.
		let aliveChecks = 0;
		// interlinked: defer non_deterministic_test -- elapsed wall time IS the
		// observable here; fake timers would erase the behavior under test
		const startedAt = Date.now();
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways: vi.fn(),
			deps: { identify: () => "daemon-identity", kill, isAlive: () => ++aliveChecks <= 2 },
		});
		expect(result).toBe("gone");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20); // one real 25 ms poll
		expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]]);
	});

	it("reports failed when the incumbent's identity becomes unverifiable after SIGTERM", async () => {
		// Identity goes unreadable mid-reap: the wait loop ignores null (it only
		// aborts on a DIFFERENT verified identity), so the post-wait recheck is
		// the one that must refuse to escalate — an unverifiable pid is never
		// SIGKILLed.
		let identityCalls = 0;
		const identify = (): string | null => (++identityCalls <= 2 ? "daemon-identity" : null);
		const kill = vi.fn();
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways: vi.fn(),
			deps: { identify, kill, isAlive: () => true },
		});
		expect(result).toBe("failed");
		expect(kill.mock.calls.map((call) => call[1])).toEqual(["SIGTERM"]);
	});

	it("identity-rechecks before escalating a SIGTERM-deaf daemon to SIGKILL", async () => {
		let alive = true;
		const kill = vi.fn((_pid: number, signal: "SIGTERM" | "SIGKILL") => {
			if (signal === "SIGKILL") alive = false;
		});
		const result = await reapZombieIncumbent({
			pid: 4242,
			cwd: "/repo",
			logAlways: vi.fn(),
			deps: { identify: () => "original", kill, isAlive: () => alive, sleep: async () => {} },
		});
		expect(result).toBe("gone");
		expect(kill.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

describe("removeOwnPidLitter — positive (must fire)", () => {
	// The 2026-08-16 perpetual-restart illusion: a dual-protocol loser wrote
	// the raw harness.pid, exited without cleaning it, and every reader then
	// diagnosed a dead daemon next to a healthy incumbent. The ownership rule:
	// a loser removes exactly the pid files that name ITSELF.
	it("P1: removes the raw harness.pid when it names this process", () => {
		const dir = mkdtempSync(join(tmpdir(), "pid-litter-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const raw = join(dir, ".interlinked", "harness.pid");
		writeFileSync(raw, String(process.pid));
		removeOwnPidLitter(dir);
		expect(existsSync(raw)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("P2: removes a framed/session pid file that names this process", () => {
		const dir = mkdtempSync(join(tmpdir(), "pid-litter-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const framed = join(dir, ".interlinked", "harness-default.pid");
		writeFileSync(framed, `${process.pid}\n`); // trailing newline must not defeat the match
		removeOwnPidLitter(dir);
		expect(existsSync(framed)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("removeOwnPidLitter — negative (must not fire)", () => {
	it("N1: never touches a pid file naming a FOREIGN process (the winner's)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pid-litter-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const raw = join(dir, ".interlinked", "harness.pid");
		const foreign = process.pid + 1;
		writeFileSync(raw, String(foreign));
		removeOwnPidLitter(dir);
		expect(existsSync(raw)).toBe(true);
		expect(readFileSync(raw, "utf-8")).toBe(String(foreign));
		rmSync(dir, { recursive: true, force: true });
	});

	it("N2: leaves garbage-content pid files alone and never throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "pid-litter-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const raw = join(dir, ".interlinked", "harness.pid");
		writeFileSync(raw, "not-a-pid");
		expect(() => removeOwnPidLitter(dir)).not.toThrow();
		expect(existsSync(raw)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	it("N3: an unreadable pid entry survives and does not stop the sweep of its own litter", () => {
		const dir = mkdtempSync(join(tmpdir(), "pid-litter-"));
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		// A DIRECTORY named like a pid file: readFileSync throws EISDIR, so this
		// entry is unreadable — foreign files must survive an unreadable one.
		mkdirSync(join(dir, ".interlinked", "harness-unreadable.pid"));
		writeFileSync(join(dir, ".interlinked", "harness.pid"), String(process.pid));
		removeOwnPidLitter(dir);
		expect(readdirSync(join(dir, ".interlinked")).sort()).toEqual(["harness-unreadable.pid"]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("N4: a repo with no .interlinked directory is a silent no-op", () => {
		const dir = mkdtempSync(join(tmpdir(), "pid-litter-"));
		expect(() => removeOwnPidLitter(dir)).not.toThrow();
		rmSync(dir, { recursive: true, force: true });
	});
});
