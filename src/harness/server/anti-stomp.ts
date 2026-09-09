// ===========================================
// Anti-stomp loser exit — one decision, shared by both startup races
// ===========================================
// Two independent checks can find that THIS process lost the race to own a
// daemon socket: the legacy raw-socket PID check (`liveForeignDaemonPid`,
// run synchronously at the top of server.ts) and the framed per-session
// ownership check inside `startSessionDaemon()` (session-daemon.ts), which
// throws `DaemonOwnershipConflictError` when a live PID already holds the
// session's pid file. Both losers must do the SAME two things: record the
// `anti-stomp` ledger row, then terminate — anything less leaves a
// timer-holding zombie. Before this fix, the framed path's throw reached
// `installCrashResilience()`'s survive-on-error handler, which logs and
// keeps the process running BY DESIGN (continuity for a genuinely
// unexpected check failure) — exactly wrong for an EXPECTED, already-decided
// ownership conflict, where every earlier `process.on`/`setInterval`
// registration in that same startup script keeps the event loop alive with
// no answering socket. This module names that decision so server.ts can
// route both callers through it, and a test can assert it without a real
// process exit or a real ledger write (see anti-stomp.test.ts).
//
// Deliberately bypasses the full graceful `shutdown()`: at the point either
// check fires, THIS process hasn't bound anything (that is the definition
// of losing before the bind), while the WINNER may already be live on the
// very socket path `shutdown()`'s cleanup unconditionally unlinks — calling
// it here would reintroduce the original stomp bug through a different
// door. A bare exit is safe: `process.exit()` tears down every
// timer/watcher/interval this script has registered so far, ref'd or not.

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { recordDaemonEvent } from "../daemon-ledger.js";
import {
	type ProcessIdentityReader,
	readHarnessProcessIdentity,
} from "../daemon-process-identity.js";
import { currentProcessAttemptId } from "../handover-churn.js";
import { releaseStartupLock } from "../startup-lock.js";

export interface AntiStompDeps {
	logAlways: (msg: string) => void;
	/** Appends the `anti-stomp` exit row for THIS process to the daemon ledger. */
	recordExit: () => void;
	/** Terminates the process. */
	exit: () => void;
}

/** The real deps for a daemon process: its own stderr logger, the `anti-stomp`
 *  exit row for THIS pid (not the winner's — matching the start/handover
 *  rows' convention), and a plain exit 0. Losing a race is an ORDERLY
 *  outcome, so the code is 0; a startup that could not bind exits non-zero
 *  instead (see ./startup-guard.ts). Tests build the interface directly. */
export function antiStompDepsFor(cwd: string, logAlways: (msg: string) => void): AntiStompDeps {
	return {
		logAlways,
		recordExit: () => {
			// Stamp the handover attempt this loser was spawned to serve (env or
			// already consumed by the startup guard): an exit row carrying the id
			// RESOLVES the attempt in the churn reducer, so a lost race never
			// counts toward the restart backoff (review 2026-08-29: four such
			// races in ten minutes could re-trip it).
			const attemptId = currentProcessAttemptId();
			recordDaemonEvent(cwd, {
				at: Date.now(),
				pid: process.pid,
				event: "exit",
				reason: "anti-stomp",
				...(attemptId !== undefined ? { attempt_id: attemptId } : {}),
			});
		},
		exit: () => {
			releaseStartupLock(cwd);
			process.exit(0);
		},
	};
}

export interface AntiStompLossArgs {
	/** PID of the daemon that won the race. */
	ownerPid: number;
	/** What was contested — e.g. "the raw socket" or `the framed session "default"`. */
	detail: string;
	cwd: string;
	deps: AntiStompDeps;
}

/** The loser's full contract, in order: clean own pid litter, log, record,
 *  exit. Callers decide WHETHER this fires (the two checks above have
 *  different trigger conditions); this function only owns WHAT happens once
 *  that's decided.
 *
 *  The pid-litter sweep exists because a dual-protocol newcomer writes the
 *  RAW `harness.pid` before it loses the FRAMED race — without the sweep
 *  that file permanently names a corpse, every `harness.pid` reader (the
 *  statusline glyph, the cold gate's pid discovery) concludes "daemon dead"
 *  next to a healthy incumbent, and the statusline's revive loop
 *  manufactures a fresh corpse every throttle window (the perpetual
 *  "restarting" of 2026-08-16). Ownership rule: remove a pid file ONLY when
 *  it names THIS process — the winner's files are never touched. */
export function loseAntiStompRace(args: AntiStompLossArgs): void {
	const { ownerPid, detail, cwd, deps } = args;
	removeOwnPidLitter(cwd);
	deps.logAlways(
		`[interlinked] A harness daemon (PID ${ownerPid}) already owns ${detail} for ${cwd}. ` +
			"Refusing to start a second one (would stomp its socket). " +
			"Use `interlinked harness restart` to replace it.",
	);
	deps.recordExit();
	deps.exit();
}

/** Remove every `.interlinked/harness*.pid` whose content is THIS process's
 *  pid. Best-effort and never throws — this runs on an exit path. Foreign
 *  pids (the winner's, or garbage) are left untouched. */
export function removeOwnPidLitter(cwd: string, ownPid: number = process.pid): void {
	const dir = join(cwd, ".interlinked");
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => /^harness(-.+)?\.pid$/.test(n));
	} catch (err) {
		void err; // unreadable dir — nothing to clean
		return;
	}
	for (const name of names) {
		const p = join(dir, name);
		try {
			if (Number.parseInt(readFileSync(p, "utf-8").trim(), 10) === ownPid) unlinkSync(p);
		} catch (err) {
			void err; // unreadable/gone/permission — leave it; foreign files must survive
		}
	}
}

// ===========================================
// Zombie incumbent reap — the "live PID, dead socket" case
// ===========================================
// `liveForeignDaemonPid` proves a PID exists; `isDaemonSocketServing`
// (session-paths.ts) proves it actually answers. When the PID is alive but
// the socket is not serving, the incumbent is a zombie kept resident by
// `installCrashResilience()`'s survive-on-error design — exactly the process
// this module's loser contract does NOT apply to, because THIS process is
// the one taking over, not losing. Reap it (best effort) instead of
// deferring to it forever.

/**
 * Terminate a live-but-not-serving incumbent without ever signalling a PID
 * whose verified process identity changed. SIGTERM gets a bounded grace
 * period; a still-matching process is then SIGKILLed and confirmed gone.
 * Callers may take over only on `gone`; replacement, unverifiable identity,
 * or failed termination preserves the incumbent metadata and aborts startup.
 */
export type ZombieReapResult = "gone" | "replaced" | "unverified" | "failed";

export interface ZombieReapDeps {
	identify?: ProcessIdentityReader;
	kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	isAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
}

const ZOMBIE_TERM_WAIT_MS = 1_000;
const ZOMBIE_KILL_WAIT_MS = 500;
const ZOMBIE_EXIT_POLL_MS = 25;

function matchingZombieIdentity(
	cwd: string,
	pid: number,
	identify: ProcessIdentityReader,
): string | null {
	const expected = identify(cwd, pid);
	if (expected === null) return null;
	return identify(cwd, pid) === expected ? expected : null;
}

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function signalZombie(
	pid: number,
	signal: "SIGTERM" | "SIGKILL",
	logAlways: (msg: string) => void,
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void,
): "signaled" | "gone" | "failed" {
	try {
		kill(pid, signal);
		return "signaled";
	} catch (err) {
		const code = errorCode(err);
		if (code === "ESRCH") return "gone";
		logAlways(`[interlinked] Could not signal zombie incumbent PID ${pid}: ${String(err)}`);
		return "failed";
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return errorCode(err) === "EPERM";
	}
}

function sleepBriefly(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForZombieExit(args: {
	pid: number;
	cwd: string;
	expectedIdentity: string;
	identify: ProcessIdentityReader;
	isAlive: (pid: number) => boolean;
	sleep: (ms: number) => Promise<void>;
	timeoutMs: number;
}): Promise<"gone" | "replaced" | "alive"> {
	const deadline = Date.now() + args.timeoutMs;
	while (Date.now() < deadline) {
		if (!args.isAlive(args.pid)) return "gone";
		const currentIdentity = args.identify(args.cwd, args.pid);
		// A different verified identity means the original daemon exited and
		// the numeric PID was reused. Never signal the replacement.
		if (currentIdentity !== null && currentIdentity !== args.expectedIdentity) return "replaced";
		await args.sleep(ZOMBIE_EXIT_POLL_MS);
	}
	return args.isAlive(args.pid) ? "alive" : "gone";
}

async function forceZombieExit(args: {
	pid: number;
	cwd: string;
	expectedIdentity: string;
	identify: ProcessIdentityReader;
	isAlive: (pid: number) => boolean;
	sleep: (ms: number) => Promise<void>;
	logAlways: (msg: string) => void;
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}): Promise<ZombieReapResult> {
	if (!args.isAlive(args.pid)) return "gone";
	const currentIdentity = args.identify(args.cwd, args.pid);
	if (currentIdentity !== args.expectedIdentity) {
		return currentIdentity === null ? "failed" : "replaced";
	}
	const signalResult = signalZombie(args.pid, "SIGKILL", args.logAlways, args.kill);
	if (signalResult !== "signaled") return signalResult;
	const outcome = await waitForZombieExit({ ...args, timeoutMs: ZOMBIE_KILL_WAIT_MS });
	return outcome === "alive" ? "failed" : outcome;
}

async function completeZombieReap(args: {
	pid: number;
	cwd: string;
	expectedIdentity: string;
	identify: ProcessIdentityReader;
	logAlways: (msg: string) => void;
	deps: ZombieReapDeps & { isAlive: (pid: number) => boolean };
}): Promise<ZombieReapResult> {
	const { pid, cwd, expectedIdentity, identify, logAlways, deps } = args;
	const kill = deps.kill ?? ((target, signal) => process.kill(target, signal));
	const signalResult = signalZombie(pid, "SIGTERM", logAlways, kill);
	if (signalResult !== "signaled") return signalResult;
	const waitArgs = {
		pid,
		cwd,
		expectedIdentity,
		identify,
		isAlive: deps.isAlive,
		sleep: deps.sleep ?? sleepBriefly,
	};
	const outcome = await waitForZombieExit({ ...waitArgs, timeoutMs: ZOMBIE_TERM_WAIT_MS });
	if (outcome !== "alive") return outcome;
	return forceZombieExit({ ...waitArgs, logAlways, kill });
}

export async function reapZombieIncumbent(args: {
	pid: number;
	cwd: string;
	logAlways: (msg: string) => void;
	deps?: ZombieReapDeps;
}): Promise<ZombieReapResult> {
	const { pid, cwd, logAlways, deps = {} } = args;
	const isAlive = deps.isAlive ?? processIsAlive;
	if (!isAlive(pid)) return "gone";
	const identify = deps.identify ?? readHarnessProcessIdentity;
	const expectedIdentity = matchingZombieIdentity(cwd, pid, identify);
	if (expectedIdentity === null) {
		logAlways(
			`[interlinked] Stale daemon pid metadata names unverified PID ${pid}; refusing to signal it.`,
		);
		return "unverified";
	}
	return completeZombieReap({
		pid,
		cwd,
		expectedIdentity,
		identify,
		logAlways,
		deps: { ...deps, isAlive },
	});
}
