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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
	type ProcessIdentityReader,
	readHarnessProcessIdentity,
} from "../harness/daemon-process-identity.js";
import { recordInheritedDaemonSpawn } from "../harness/handover-churn.js";
import { configuredHeapMb } from "../harness/memory-ceiling.js";
import {
	classifyDaemonSocket,
	isDaemonSocketReady,
} from "../harness/session-paths.js";
import type { HarnessSocketState } from "../harness/socket-readiness.js";
import {
	acquireStartupLock,
	type StartupLockResult,
	touchStartupLockHolder,
	transferStartupLock,
	waitForDaemonSocket,
} from "../harness/startup-lock.js";
import { c } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import {
	type DaemonControlDeps,
	reapOrphanHarnessesVerified,
	stopAllDaemons,
} from "./harness-daemon-control.js";
import {
	closeDaemonStderrLog,
	getHarnessServerPath,
	getPidPath,
	getSocketPath,
	isHarnessRunning,
	openDaemonStderrLog,
	readDaemonStderrLog,
} from "./harness-process.js";
import {
	expectedSocketPaths,
	type HarnessProtocolMode,
} from "./harness-status-helpers.js";

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

/**
 * Build the `node` argv for every harness server launch. Caps the V8 heap at
 * the shared daemon default; override via `INTERLINKED_HARNESS_HEAP_MB`.
 */
export function buildHarnessSpawnArgs(
	serverPath: string,
	cwd: string,
	protocol: HarnessProtocolMode,
	sessionId: string,
	opts: { verbose?: boolean },
): string[] {
	const heapMb = configuredHeapMb();
	// --expose-gc powers the idle shrink (daemon-timers): a forced collection
	// after the manifest cache drops, so idle RSS actually falls.
	const args = [`--max-old-space-size=${heapMb}`, "--expose-gc", serverPath, "--cwd", cwd];
	args.push("--protocol", protocol);
	if (protocol !== "raw") args.push("--session-id", sessionId);
	if (opts.verbose) args.push("--verbose");
	return args;
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
 * Stop a running harness for a restart: SIGTERM, wait, then escalate to SIGKILL
 * if it ignores the term. Owns its own stderr nudges (normal mode only) and the
 * survived-SIGKILL fatal error. Returns the prior pid (for the JSON payload) and
 * whether the daemon survived SIGKILL — when `survived` is true the caller must
 * abort the restart.
 *
 * Behavior-identical to the inline block it replaces: the `Sending termination
 * signals` rule blocks an agent from running `kill -9` itself, so owning the
 * escalation here is what makes `harness restart` actually restart.
 */
export async function stopRunningHarnessForRestart(
	cwd: string,
	mode: ReturnType<typeof getOutputMode>,
): Promise<{ oldPid: number | undefined; survived: boolean }> {
	// Finding #22 (2026-08-16): the old single-pid path here read only the RAW
	// pid file, so a framed daemon (harness-default.pid) survived the "stop"
	// holding its socket, and the fresh start exited anti-stomp — a restart
	// that un-restarts. `stopAllDaemons` is the stop verb's own path: it
	// enumerates raw + framed/session pid files AND orphans, protects this
	// process's ancestors, and owns the TERM→wait→KILL escalation.
	const status = isHarnessRunning(cwd);
	const priorPid = status.running ? status.pid : undefined;
	// spareAncestralDaemons:false — an automatic handover spawns THIS restart
	// from the daemon it must replace, so that daemon is our ancestor; sparing
	// it turned every automatic handover into a silent "already running" no-op
	// (review 2026-08-29, live-reproduced). Targets are verified daemons only.
	const { stopped, survived } = await stopAllDaemons(cwd, { spareAncestralDaemons: false });
	if (stopped.length === 0 && survived.length === 0) {
		return { oldPid: undefined, survived: false };
	}
	const oldPid = priorPid ?? stopped[0];
	if (survived.length > 0) {
		outputError(
			mode,
			`PID(s) ${survived.join(", ")} survived SIGKILL — possibly kernel-protected. Investigate manually.`,
		);
		return { oldPid, survived: true };
	}
	if (mode === "normal") {
		process.stderr.write(c.dim(`Stopped harness (was PID ${stopped.join(", ")})\n`));
	}
	return { oldPid, survived: false };
}

/**
 * Resilience pass before respawn: sweep orphan daemons and remove stale socket /
 * pid files left by a previous crash. Without this a stale pid+sock pair can make
 * the new daemon double-bind on the socket or confuse `isHarnessRunning` callers.
 * Run on the happy path too — a fresh restart should never inherit dirt.
 *
 * LIVENESS-VERIFIED (2026-08-16). This was one of the last two reapers that
 * still picked victims straight out of `ps`, so a healthy daemon this repo's
 * pid file did not name was SIGTERM'd by every restart — exactly the kill that
 * opens the guard gap the 2026-08-15 storm fed on. It now goes through
 * `reapOrphanHarnessesVerified`, which probes each candidate's socket first and
 * protects whatever answers. Async for that probe; callers must await.
 */
type RestartSocketState = HarnessSocketState | "probe_failed";

interface RestartCleanupDeps extends DaemonControlDeps {
	classifySocket?: (socketPath: string) => Promise<HarnessSocketState>;
	fileExists?: (path: string) => boolean;
	readText?: (path: string) => string;
	unlinkFile?: (path: string) => void;
	runningStatus?: (cwd: string) => ReturnType<typeof isHarnessRunning>;
	identify?: ProcessIdentityReader;
}

async function confirmedRestartSocketState(
	socketPath: string,
	classify: (socketPath: string) => Promise<HarnessSocketState>,
): Promise<RestartSocketState> {
	try {
		const first = await classify(socketPath);
		if (first !== "absent") return first;
		return classify(socketPath);
	} catch {
		return "probe_failed";
	}
}

async function removeConfirmedStaleSocket(
	socketPath: string,
	deps: RestartCleanupDeps,
): Promise<RestartSocketState> {
	const fileExists = deps.fileExists ?? existsSync;
	if (!fileExists(socketPath)) return "absent";
	const state = await confirmedRestartSocketState(
		socketPath,
		deps.classifySocket ?? classifyDaemonSocket,
	);
	if (state !== "absent" || !fileExists(socketPath)) return state;
	try {
		(deps.unlinkFile ?? unlinkSync)(socketPath);
	} catch {
		/* intentional: best-effort cleanup after two absent classifications */
	}
	return state;
}

function readTextOrNull(path: string, readText: (path: string) => string): string | null {
	try {
		return readText(path);
	} catch {
		return null;
	}
}

function runningPidNeedsMetadata(
	cwd: string,
	socketState: RestartSocketState,
	deps: RestartCleanupDeps,
): boolean {
	const status = (deps.runningStatus ?? isHarnessRunning)(cwd);
	if (!status.running) return false;
	if (socketState !== "absent" || status.pid === undefined) return true;
	return (deps.identify ?? readHarnessProcessIdentity)(cwd, status.pid) !== null;
}

function removeConfirmedStalePid(
	cwd: string,
	pidPath: string,
	socketState: RestartSocketState,
	deps: RestartCleanupDeps,
): void {
	const fileExists = deps.fileExists ?? existsSync;
	if (!fileExists(pidPath) || runningPidNeedsMetadata(cwd, socketState, deps)) return;
	const readText = deps.readText ?? ((path: string) => readFileSync(path, "utf8"));
	const snapshot = readTextOrNull(pidPath, readText);
	if (snapshot === null || readTextOrNull(pidPath, readText) !== snapshot) return;
	try {
		(deps.unlinkFile ?? unlinkSync)(pidPath);
	} catch {
		/* intentional: best-effort cleanup of unchanged stale metadata */
	}
}

export async function cleanStaleRestartFiles(
	cwd: string,
	deps: RestartCleanupDeps = {},
): Promise<void> {
	await reapOrphanHarnessesVerified(cwd, {}, deps);
	const socketPath = getSocketPath(cwd);
	const socketState = await removeConfirmedStaleSocket(socketPath, deps);
	const stalePidPath = getPidPath(cwd);
	removeConfirmedStalePid(cwd, stalePidPath, socketState, deps);
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
