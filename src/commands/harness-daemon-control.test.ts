import { nonNull } from "../lib/non-null.js";
// ===========================================
// Daemon control — reaping and stopping
// ===========================================
// Two fixture styles, deliberately:
//   1. Fully injected deps (`DaemonControlDeps`) for the selection rules —
//      who is protected, who is signalled, what the ledger records. No real
//      process is touched, so the storm invariants are cheap to pin.
//   2. One real, disposable child process (`spawnDecoyDaemon`) whose `ps`
//      argv matches a throwaway workspace's daemon shape. That block leaves
//      `kill` / `isAlive` / `wait` at their DEFAULTS, so the module's real
//      `process.kill` wrappers, the `ps`-derived orphan lookup and the poll
//      loop are exercised instead of stubbed away.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonLedgerEvent } from "../harness/daemon-ledger.js";
import {
	collectServingDaemonPids,
	type DaemonControlDeps,
	reapOrphanHarnessesVerified,
	stopAllDaemons,
} from "./harness-daemon-control.js";
import type { ReapOptions, ReapResult } from "./harness-process.js";

const CWD = "/repo";
const identifyDaemon = (cwd: string, pid: number): string => `${cwd}:daemon:${pid}:started`;

function daemon(pid: number | null, socket: string, alive = true) {
	return {
		session_id: socket,
		paths: { socket, pid: `${socket}.pid`, log: "log" },
		pid,
		alive,
	};
}

describe("collectServingDaemonPids — positive (must fire)", () => {
	it("P1: a pid whose socket ANSWERS is reported as serving", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			probe: () => Promise.resolve(true),
		};
		expect([...(await collectServingDaemonPids(CWD, deps))]).toEqual([11]);
	});

	it("P2: several serving daemons are all reported", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock"), daemon(12, "/b.sock")],
			probe: () => Promise.resolve(true),
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(2);
	});

	it("P3: a socket-only serving daemon conservatively protects every verified cwd candidate", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [],
			socketPaths: () => ["/orphaned-metadata.sock"],
			extraPids: () => [22, 33],
			probe: () => Promise.resolve(true),
		};
		expect([...(await collectServingDaemonPids(CWD, deps))]).toEqual([22, 33]);
	});
});

describe("collectServingDaemonPids — negative (must not fire)", () => {
	it("N1: a pid whose socket refuses is NOT serving", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			probe: () => Promise.resolve(false),
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(0);
	});

	it("N2: a dead process is never probed nor reported", async () => {
		let probed = 0;
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock", false)],
			probe: () => {
				probed++;
				return Promise.resolve(true);
			},
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(0);
		expect(probed).toBe(0);
	});

	it("N3: a pid-less entry is skipped", async () => {
		const deps: DaemonControlDeps = {
			discover: () => [daemon(null, "/a.sock")],
			probe: () => Promise.resolve(true),
		};
		expect((await collectServingDaemonPids(CWD, deps)).size).toBe(0);
	});
});

function sweepRecorder(seen: ReapOptions[]) {
	return (_cwd: string, opts: ReapOptions): ReapResult => {
		seen.push(opts);
		return { candidates: [], killed: [], dryRun: opts.dryRun === true };
	};
}

describe("reapOrphanHarnessesVerified — positive (must fire: protect the serving set)", () => {
	it("P1: the answering pid arrives at the sweep in protectPids", async () => {
		const seen: ReapOptions[] = [];
		await reapOrphanHarnessesVerified(
			CWD,
			{},
			{
				discover: () => [daemon(11, "/a.sock")],
				probe: () => Promise.resolve(true),
				reap: sweepRecorder(seen),
			},
		);
		expect([...(seen[0]?.protectPids ?? [])]).toEqual([11]);
	});

	it("P2: caller opts (dryRun/killAll) are forwarded alongside the protected set", async () => {
		const seen: ReapOptions[] = [];
		await reapOrphanHarnessesVerified(
			CWD,
			{ dryRun: true, killAll: true },
			{
				discover: () => [daemon(11, "/a.sock")],
				probe: () => Promise.resolve(true),
				reap: sweepRecorder(seen),
			},
		);
		expect(seen[0]?.dryRun).toBe(true);
		expect(seen[0]?.killAll).toBe(true);
		expect(seen[0]?.protectPids?.has(11)).toBe(true);
	});

	it("P3: force reap cannot select a daemon answering through a socket with no pid file", async () => {
		const seen: ReapOptions[] = [];
		await reapOrphanHarnessesVerified(
			CWD,
			{ killAll: true },
			{
				discover: () => [],
				socketPaths: () => ["/socket-only.sock"],
				extraPids: () => [44],
				probe: () => Promise.resolve(true),
				reap: sweepRecorder(seen),
			},
		);
		expect([...(seen[0]?.protectPids ?? [])]).toEqual([44]);
	});
});

describe("reapOrphanHarnessesVerified — negative (must not fire)", () => {
	it("N1: a refusing socket leaves the protected set empty", async () => {
		const seen: ReapOptions[] = [];
		await reapOrphanHarnessesVerified(
			CWD,
			{},
			{
				discover: () => [daemon(11, "/a.sock")],
				probe: () => Promise.resolve(false),
				reap: sweepRecorder(seen),
			},
		);
		expect(seen[0]?.protectPids?.size).toBe(0);
	});

	it("N2: with no discovered daemons the sweep still runs, with nothing protected", async () => {
		const seen: ReapOptions[] = [];
		const result = await reapOrphanHarnessesVerified(
			CWD,
			{},
			{ discover: () => [], reap: sweepRecorder(seen) },
		);
		expect(seen).toHaveLength(1);
		expect(result.killed).toEqual([]);
	});
});

describe("stopAllDaemons — positive (must fire: stop EVERY daemon for this repo)", () => {
	it("P1: signals the pid-file daemon AND the orphans the pid file never knew about", async () => {
		const killed: number[] = [];
		const alive = new Set([11, 22, 33]);
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			extraPids: () => [22, 33],
			identify: identifyDaemon,
			probe: () => Promise.resolve(true),
			kill: (pid) => {
				killed.push(pid);
				alive.delete(pid);
			},
			isAlive: (pid) => alive.has(pid),
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(killed.sort((a, b) => a - b)).toEqual([11, 22, 33]);
		expect(result.stopped.sort((a, b) => a - b)).toEqual([11, 22, 33]);
		expect(result.survived).toEqual([]);
	});

	it("P2: records an explicit-stop ledger marker BEFORE signalling", async () => {
		const order: string[] = [];
		let alive = true;
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			identify: identifyDaemon,
			recordEvent: (evt) => order.push(`record:${evt.reason}`),
			kill: (pid) => {
				order.push(`kill:${pid}`);
				alive = false;
			},
			isAlive: () => alive,
			wait: () => Promise.resolve(),
		};
		await stopAllDaemons(CWD, deps);
		expect(order).toEqual(["record:explicit-stop", "kill:11"]);
	});

	// test-contract: bug — live-reproduced 2026-08-29: an automatic handover's
	// restart CLI is spawned BY the daemon it must replace, so the daemon is
	// the CLI's ANCESTOR; the default sparing turned every automatic handover
	// into a silent "already running" no-op the watcher retried forever. The
	// restart path opts out; the daemon target must then be signalled.
	it("P4: spareAncestralDaemons:false signals an ancestral daemon (the handover parent)", async () => {
		const killed: number[] = [];
		let alive = true;
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			identify: identifyDaemon,
			protectedPids: () => new Set([process.pid, 11]),
			spareAncestralDaemons: false,
			kill: (pid) => {
				killed.push(pid);
				alive = false;
			},
			isAlive: () => alive,
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(killed).toEqual([11]);
		expect(result.stopped).toEqual([11]);
	});

	it("P3: a daemon still alive after SIGKILL is reported as survived", async () => {
		const signals: string[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			identify: identifyDaemon,
			kill: (_pid, signal) => signals.push(signal),
			isAlive: () => true,
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(result.survived).toEqual([11]);
		expect(result.stopped).toEqual([]);
	});

	it("P5: allows a graceful SIGTERM exit without escalating", async () => {
		let alive = true;
		const signals: string[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			identify: identifyDaemon,
			kill: (_pid, signal) => signals.push(signal),
			isAlive: () => alive,
			wait: async () => {
				alive = false;
			},
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(signals).toEqual(["SIGTERM"]);
		expect(result).toEqual({ stopped: [11], survived: [] });
	});
});

describe("stopAllDaemons — negative (must not fire)", () => {
	// test-contract: invariant — even with ancestor sparing OFF, this process
	// itself is never a target: killing yourself mid-stop leaves no one to
	// finish the restart.
	it("N4: spareAncestralDaemons:false still never signals this process", async () => {
		const killed: number[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(process.pid, "/self.sock")],
			identify: identifyDaemon,
			protectedPids: () => new Set([process.pid]),
			spareAncestralDaemons: false,
			kill: (pid) => killed.push(pid),
			isAlive: () => false,
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(killed).toEqual([]);
		expect(result.stopped).toEqual([]);
	});

	it("N1: never signals this process or an ancestor", async () => {
		const killed: number[] = [];
		const deps: DaemonControlDeps = {
			discover: () => [daemon(process.pid, "/self.sock")],
			identify: identifyDaemon,
			extraPids: () => [4242],
			protectedPids: () => new Set([process.pid, 4242]),
			kill: (pid) => killed.push(pid),
			isAlive: () => false,
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(killed).toEqual([]);
		expect(result.stopped).toEqual([]);
	});

	it("N2: no daemons at all is a no-op with no ledger row", async () => {
		let recorded = 0;
		const deps: DaemonControlDeps = {
			discover: () => [],
			extraPids: () => [],
			recordEvent: () => {
				recorded++;
			},
			kill: () => {
				throw new Error("must not signal");
			},
			wait: () => Promise.resolve(),
		};
		const result = await stopAllDaemons(CWD, deps);
		expect(result.stopped).toEqual([]);
		expect(recorded).toBe(0);
	});

	it("N3: a pid appearing in BOTH sources is signalled once", async () => {
		const killed: number[] = [];
		let alive = true;
		const deps: DaemonControlDeps = {
			discover: () => [daemon(11, "/a.sock")],
			extraPids: () => [11],
			identify: identifyDaemon,
			kill: (pid) => {
				killed.push(pid);
				alive = false;
			},
			isAlive: () => alive,
			wait: () => Promise.resolve(),
		};
		await stopAllDaemons(CWD, deps);
		expect(killed).toEqual([11]);
	});

	it("N5: a live PID that is not this project's daemon is never signaled", async () => {
		const signals: string[] = [];
		const result = await stopAllDaemons(CWD, {
			discover: () => [daemon(11, "/a.sock")],
			identify: () => null,
			kill: (_pid, signal) => signals.push(signal),
			isAlive: () => true,
		});
		expect(signals).toEqual([]);
		expect(result).toEqual({ stopped: [], survived: [] });
	});

	it("N6: PID reuse between TERM and KILL never signals the replacement", async () => {
		const signals: string[] = [];
		let identity = "daemon:start-a";
		const result = await stopAllDaemons(CWD, {
			discover: () => [daemon(11, "/a.sock")],
			identify: () => identity,
			kill: (_pid, signal) => signals.push(signal),
			isAlive: () => true,
			wait: async () => {
				identity = "unrelated:start-b";
			},
		});
		expect(signals).toEqual(["SIGTERM"]);
		expect(result).toEqual({ stopped: [11], survived: [] });
	});
});

interface DecoyDaemon {
	pid: number;
	/** Resolves with the signal that ended the process, or null on a clean exit. */
	exitSignal: Promise<NodeJS.Signals | null>;
	dispose: () => void;
}

/**
 * A real, disposable process whose `ps` argv is exactly the daemon shape
 * `isHarnessDaemonCommandForCwd` accepts for `workspace`. The `ps`-derived
 * orphan lookup, `process.kill` and the liveness probe therefore run against a
 * live process we own instead of a stub. Resolves once `execve` succeeded, so
 * the new argv is already visible to `ps`.
 */
async function spawnDecoyDaemon(workspace: string): Promise<DecoyDaemon> {
	const serverDir = join(workspace, "dist", "harness");
	mkdirSync(serverDir, { recursive: true });
	const script = join(serverDir, "server.js");
	writeFileSync(script, "setTimeout(() => {}, 30000);\n");
	const child = spawn(process.execPath, [script, "--cwd", workspace], { stdio: "ignore" });
	const exitSignal = new Promise<NodeJS.Signals | null>((resolve) => {
		child.on("exit", (_code, signal) => resolve(signal));
	});
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
	} catch (err) {
		child.kill("SIGKILL");
		throw err;
	}
	return {
		// SAFETY: `pid` is only undefined when the spawn failed, which the
		// awaited "spawn"/"error" race above has already turned into a throw.
		pid: nonNull(child.pid),
		exitSignal,
		dispose: () => {
			child.kill("SIGKILL");
		},
	};
}

describe("stopAllDaemons — default kill / liveness / wait against a real process", () => {
	let workspace = "";
	let decoy: DecoyDaemon | null = null;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "interlinked-daemon-control-"));
		decoy = null;
	});

	afterEach(() => {
		decoy?.dispose();
		rmSync(workspace, { recursive: true, force: true });
	});

	it("finds a daemon that no pid file names through ps and SIGTERMs it", async () => {
		decoy = await spawnDecoyDaemon(workspace);
		const ledgerDetails: string[] = [];
		const result = await stopAllDaemons(workspace, {
			identify: identifyDaemon,
			protectedPids: () => new Set<number>(),
			recordEvent: (evt: DaemonLedgerEvent) => ledgerDetails.push(evt.detail ?? ""),
		});
		expect(ledgerDetails).toEqual([`stopping 1 daemon(s): ${decoy.pid}`]);
		expect(await decoy.exitSignal).toBe("SIGTERM");
		expect(result).toEqual({ stopped: [decoy.pid], survived: [] });
	});

	it("reports a daemon that exited before the stop as stopped, not survived", async () => {
		decoy = await spawnDecoyDaemon(workspace);
		const pid = decoy.pid;
		decoy.dispose();
		expect(await decoy.exitSignal).toBe("SIGKILL");

		const result = await stopAllDaemons(workspace, {
			discover: () => [daemon(pid, join(workspace, "harness.sock"))],
			extraPids: () => [],
			protectedPids: () => new Set<number>(),
			identify: identifyDaemon,
			recordEvent: () => {},
		});
		expect(result).toEqual({ stopped: [pid], survived: [] });
	});
});
