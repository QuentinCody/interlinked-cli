// interlinked-tdd: exempt
// ===========================================
// interlinked harness — lifecycle/status helpers (extracted from harness.ts)
// ===========================================
//
// Leaf helpers for the harness start / restart commands and the status report.
// Moved verbatim out of ./harness.ts to keep that file under the per-file line
// cap; behavior is byte-identical. The public command functions stay in
// ./harness.ts and import these.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { recordInheritedDaemonSpawn } from "../harness/handover-churn.js";
import { isDaemonSocketReady } from "../harness/session-paths.js";
import {
	acquireStartupLock,
	type StartupLockResult,
	touchStartupLockHolder,
	transferStartupLock,
	waitForDaemonSocket,
} from "../harness/startup-lock.js";
import { c } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";
import {
	closeDaemonStderrLog,
	getHarnessServerPath,
	isHarnessRunning,
	openDaemonStderrLog,
	readDaemonStderrLog,
} from "./harness-process.js";
import {
	expectedSocketPaths,
	type HarnessProtocolMode,
} from "./harness-status-helpers.js";
import { buildHarnessSpawnArgs } from "./harness-lifecycle-helpers-build-harness-spawn-args.js";

export { buildHarnessSpawnArgs } from "./harness-lifecycle-helpers-build-harness-spawn-args.js";
export {
	cleanStaleRestartFiles,
	stopRunningHarnessForRestart,
} from "./harness-lifecycle-helpers-restart-socket-state.js";
export {
	framedSocketLines,
	protocolStatusLines,
} from "./harness-lifecycle-status-lines.js";

/**
 * What a startup-lock LOSER does: wait for the winner's socket, then report.
 *
 * The one thing it must not do is start anything. Before the mutex, every
 * concurrent `harness start` bound (or tried to), and the losers wrote
 * `startup-failed` rows while reaping the winner — the storm. A loser now polls
 * and says either "already running" or "start pending", and nobody dies.
 */
export async function reportPendingStart(
	cwd: string,
	holderPid: number | null,
	opts: { json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts);
	// A lock loser spawns no daemon: TERMINAL for any inherited attempt (the
	// winner's start is a different attempt, or id-less).
	recordInheritedDaemonSpawn(cwd, "refused", "startup lock held — deferred to in-flight start");
	const live = await waitForDaemonSocket(cwd);
	const who = holderPid === null ? "another process" : `PID ${holderPid}`;
	output(
		mode,
		{ already_running: live, start_pending: !live, starter_pid: holderPid },
		{
			json: () => ({ status: live ? "already_running" : "start_pending", starter_pid: holderPid }),
			normal: () =>
				live
					? c.green(`Harness already running (started by ${who})`)
					: c.yellow(
							`A harness start is already in flight (${who}); it has not answered yet. ` +
								"Retry in a few seconds — do not start another one.",
						),
		},
	);
}

/** Startup paths are a fixed raw/framed set, but probe them sequentially so a
 * future protocol expansion cannot turn readiness into unbounded socket fanout. */
async function allSocketsReady(socketPaths: readonly string[]): Promise<boolean> {
	for (const socketPath of socketPaths) {
		if (!(await isDaemonSocketReady(socketPath))) return false;
	}
	return true;
}

/** Move the CLI-owned startup lease to its detached daemon. A child that
 * cannot own the shared lease is terminated before another start can overlap
 * it. Split from daemonizeHarness so the readiness orchestrator stays flat. */
function adoptDaemonStartupLease(
	cwd: string,
	child: ReturnType<typeof spawn>,
): number {
	const childPid = child.pid;
	if (childPid !== undefined && transferStartupLock(cwd, { childPid })) return childPid;
	try {
		child.kill("SIGTERM");
	} catch {
		/* intentional: the child may already have exited */
	}
	recordInheritedDaemonSpawn(cwd, "spawn_failed", "startup lease transfer failed");
	throw new Error("Harness child started without a transferable startup lease; terminated it.");
}

/**
 * Daemonize the harness: spawn detached with stderr routed to a log-file fd (a
 * pipe would need closing on CLI exit, breaking later daemon writes), poll for
 * protocol responses, and emit the started/failed payload. The child-side
 * incumbent check exclusively owns stale-socket cleanup: parent-side unlinking
 * can deafen a healthy daemon whose pid file is missing.
 */
export async function daemonizeHarness(args: {
	mode: ReturnType<typeof getOutputMode>;
	cwd: string;
	nodePath: string;
	spawnArgs: string[];
	protocol: HarnessProtocolMode;
	sessionId: string;
	serverPath: string;
}): Promise<void> {
	const { mode, cwd, nodePath, spawnArgs, protocol, sessionId, serverPath } = args;
	const stderrLog = openDaemonStderrLog(cwd);
	const daemonStdio: ["ignore", "ignore", "ignore" | number] = ["ignore", "ignore", stderrLog?.fd ?? "ignore"];
	const child = (() => {
		try {
			return spawn(nodePath, spawnArgs, { stdio: daemonStdio, detached: true, cwd });
		} catch (err) {
			// Attempt-ID protocol: a thrown daemon spawn is a TERMINAL outcome for
			// the inherited attempt — the row resolves it so the churn reducer
			// never waits on a daemon that was never created.
			recordInheritedDaemonSpawn(cwd, "spawn_failed");
			throw err;
		} finally {
			closeDaemonStderrLog(stderrLog);
		}
	})();
	// A mutable object property (rather than a bare `let`) so the compiler's
	// flow analysis doesn't (incorrectly) narrow the exit-callback assignment
	// away as unreachable at the later read sites below.
	const exitState = { childExited: false };
	child.on("exit", () => {
		exitState.childExited = true;
	});
	const childPid = adoptDaemonStartupLease(cwd, child);
	// The COUNTING row of the attempt-ID chain: a daemon process now exists for
	// the inherited attempt; only its `listening` ack (or a terminal row)
	// resolves it. No-op for an id-less manual start.
	recordInheritedDaemonSpawn(cwd, "daemon_spawned");
	let stderrOutput = "";
	child.unref();
	// Poll for expected sockets to appear (harness may take 10-30s to compile TypeScript)
	const socketPaths = expectedSocketPaths(cwd, protocol, sessionId);
	const maxWaitMs = 60_000;
	const pollMs = 500;
	const startTime = Date.now();
	let ready = false;
	while (Date.now() - startTime < maxWaitMs) {
		if (exitState.childExited) break; // Process crashed — stop waiting
		if (await allSocketsReady(socketPaths)) {
			ready = true;
			break;
		}
		// Heartbeat the startup lock every poll tick: this loop can legitimately
		// run well past STARTUP_LOCK_TTL_MS (a cold compile, a loaded machine), and
		// without a refresh a concurrent `harness start`/self-heal reads the fixed
		// acquisition timestamp as stale and steals the lock mid-boot — see
		// startup-lock.ts's `touchStartupLock` doc comment for the full race.
		touchStartupLockHolder(cwd, { holderPid: childPid });
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	const newStatus = isHarnessRunning(cwd);
	const resolvedPid = newStatus.pid ?? child.pid;
	const elapsed = Math.round((Date.now() - startTime) / 1000);
	if (!ready) stderrOutput = readDaemonStderrLog(stderrLog);
	// A child that EXITED before readiness is terminal for the attempt. A
	// timeout with the child still alive is NOT terminalized: the daemon may
	// yet listen (resolving), die with an id-stamped startup-failed exit
	// (resolving), or wedge — and a wedged non-listening daemon SHOULD keep
	// counting toward the churn backstop.
	if (!ready && exitState.childExited) {
		recordInheritedDaemonSpawn(cwd, "start_failed", `daemon exited before listening (${elapsed}s)`);
	}
	// Automation contract: a start that never reached its sockets exits nonzero.
	if (!ready) process.exitCode = 1;
	output(mode, newStatus, {
		json: () => ({ status: ready ? "started" : "failed", pid: resolvedPid, protocol, sockets: socketPaths }),
		normal: () => {
			if (ready) return c.green(`Harness started (PID ${resolvedPid})`);
			const lines = [c.red(`Failed to start harness after ${elapsed}s.`)];
			if (exitState.childExited && stderrOutput) {
				lines.push(c.dim("Error output:"));
				lines.push(c.dim(stderrOutput.trim().slice(0, 500)));
			} else if (exitState.childExited) {
				lines.push(c.dim("Process exited without output."));
			} else {
				lines.push(c.dim("Process is running but socket not created. Try foreground:"));
			}
			lines.push(c.dim(`  node ${serverPath} --cwd ${cwd} --verbose`));
			return lines.join("\n");
		},
	});
}

/** Foreground start: exec directly so the harness replaces this process. */
export function startHarnessForeground(
	mode: ReturnType<typeof getOutputMode>,
	nodePath: string,
	spawnArgs: string[],
	cwd: string,
): void {
	output(
		mode,
		{},
		{
			json: () => ({ status: "starting_foreground" }),
			normal: () => c.dim("Starting harness in foreground (Ctrl+C to stop)..."),
		},
	);
	const child = spawn(nodePath, spawnArgs, { stdio: "inherit", cwd });
	// The caller releases its CLI-owned mutex as soon as this helper returns.
	// Transfer first so a concurrent hook cannot start a second daemon during
	// the foreground child's bind window.
	adoptDaemonStartupLease(cwd, child);
	child.on("exit", (code) => process.exit(code || 0));
}

/**
 * JSON-mode restart start: inline the start logic so the whole restart emits one
 * JSON document. Spawns the daemon, polls for its sockets, and emits a single
 * `restarted` / `failed` / `error` payload (never a human-readable line).
 */
export async function inlineJsonRestartStart(
	cwd: string,
	opts: { verbose?: boolean },
	protocol: HarnessProtocolMode,
	sessionId: string,
	oldPid: number | undefined,
	mode: ReturnType<typeof getOutputMode>,
): Promise<void> {
	const serverPath = getHarnessServerPath();
	if (!serverPath || !existsSync(serverPath)) {
		// Terminal: no artifact means no daemon is coming from this attempt.
		recordInheritedDaemonSpawn(cwd, "no_artifact", "harness server artifact missing (JSON restart)");
		// Automation contract (review 2026-08-30): a failed restart must exit
		// nonzero — output() only prints.
		process.exitCode = 1;
		output(
			mode,
			{},
			{
				json: () => ({ status: "error", message: "Harness server not found" }),
				normal: () => "",
			},
		);
		return;
	}
	const nodePath = process.execPath;
	// JSON restart is also used by automatic handover. It must carry the same
	// heap ceiling and idle-GC capability as an ordinary `harness start`; a
	// handover that silently drops those flags can recreate the machine-wide
	// OOM condition immediately after replacing a healthy bounded daemon.
	const args = buildHarnessSpawnArgs(serverPath, cwd, protocol, sessionId, opts);
	const child = (() => {
		try {
			return spawn(nodePath, args, { stdio: "ignore", detached: true, cwd });
		} catch (err) {
			// Terminal: the daemon spawn itself threw — same contract as
			// daemonizeHarness's catch.
			recordInheritedDaemonSpawn(cwd, "spawn_failed");
			throw err;
		}
	})();
	const childPid = adoptDaemonStartupLease(cwd, child);
	child.unref();
	// Attempt-ID protocol: the JSON restart path spawns the daemon too, so it
	// records the same counting row daemonizeHarness does.
	recordInheritedDaemonSpawn(cwd, "daemon_spawned");
	// Poll for socket (harness may take 10+ seconds to compile and load)
	const socketPaths = expectedSocketPaths(cwd, protocol, sessionId);
	const maxWaitMs = 30_000;
	const pollMs = 500;
	const startTime = Date.now();
	let newStatus = isHarnessRunning(cwd);
	let socketsReady = await allSocketsReady(socketPaths);
	while (
		(!newStatus.running || !socketsReady) &&
		Date.now() - startTime < maxWaitMs
	) {
		touchStartupLockHolder(cwd, { holderPid: childPid });
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		newStatus = isHarnessRunning(cwd);
		socketsReady = await allSocketsReady(socketPaths);
	}
	// JSON-restart timeout with no running daemon: terminal for the attempt
	// (same contract as daemonizeHarness's exited-child branch).
	if (!newStatus.running) {
		recordInheritedDaemonSpawn(cwd, "start_failed", "JSON restart timed out with no running daemon");
	}
	// Honest final state (review 2026-08-30): "restarted" requires the SOCKETS,
	// not just a live pid — a child that is running but never bound is reported
	// as failed_not_listening (deliberately NOT terminalized: it may yet listen,
	// die with an id-stamped exit, or wedge — and a wedged non-listening daemon
	// should keep counting toward the churn backstop).
	const status = !newStatus.running ? "failed" : socketsReady ? "restarted" : "failed_not_listening";
	// Automation contract: every unsuccessful outcome exits nonzero.
	if (status !== "restarted") process.exitCode = 1;
	output(
		mode,
		{},
		{
			json: () => ({
				status,
				old_pid: oldPid,
				new_pid: newStatus.pid,
				protocol,
				sockets: socketPaths,
			}),
			normal: () => "",
		},
	);
}

interface RestartStartDeps {
	acquire?: (cwd:string) => StartupLockResult;
	start?: typeof inlineJsonRestartStart;
	reportPending?: typeof reportPendingStart;
}

/**
 * The JSON restart's spawn, behind the SAME startup mutex the human path uses.
 *
 * `harness restart --json` called {@link inlineJsonRestartStart} directly, so it
 * was the one start path outside the lock: two concurrent restarts (or a restart
 * racing a hook self-heal) both bound, one died `EADDRINUSE`, and the loser's
 * reaper took the winner with it. A loser now waits on the winner's socket and
 * reports `start_pending` — one JSON document either way, which is the contract
 * this branch exists to keep.
 */
export async function lockedJsonRestartStart(
	cwd: string,
	opts: { verbose?: boolean; json?: boolean },
	protocol: HarnessProtocolMode,
	sessionId: string,
	oldPid: number | undefined,
	mode: ReturnType<typeof getOutputMode>,
	deps: RestartStartDeps = {},
): Promise<void> {
	const lock = (deps.acquire ?? acquireStartupLock)(cwd);
	if (!lock.acquired) {
		await (deps.reportPending ?? reportPendingStart)(cwd, lock.holder?.pid ?? null, opts);
		return;
	}
	try {
		await (deps.start ?? inlineJsonRestartStart)(cwd, opts, protocol, sessionId, oldPid, mode);
	} finally {
		lock.release();
	}
}
