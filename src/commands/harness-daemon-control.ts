// ===========================================
// Daemon control — liveness-verified reaping, complete stop
// ===========================================
// Two rules the 2026-08-15 restart storm taught, both about trusting PIDs:
//
//  1. NEVER SIGTERM a daemon that is answering. Every reaper here (the orphan
//     sweep on `harness start`, the pre-restart sweep) selected victims from
//     `ps` output and pid files, so a healthy daemon whose pid file had been
//     cleaned — or whose pid the active-pid check did not cover — was killed by
//     the next `start`. That kill opened the gap that made the NEXT caller run
//     `harness start`. Only an explicit `harness stop`/`restart` may stop a
//     serving daemon; a REAPER must verify over the socket first.
//  2. A stop must stop EVERYTHING. `interlinked disable` stopped the pid-file
//     daemon and left two orphans running, still holding memory and still
//     answering — a stood-down repo with live guards is the worst of both.
//
// Every dependency is injectable so both rules are unit-testable without real
// processes.

import { isProcessAlive } from "../harness/daemon-pid-ownership.js";
import { recordDaemonEvent } from "../harness/daemon-ledger.js";
import type { DaemonLedgerEvent } from "../harness/daemon-ledger.js";
import {
	type ProcessIdentityReader,
	readHarnessProcessIdentity,
	sameProcessIdentity,
	stillMatchingIdentities,
	verifiedProcessIdentities,
} from "../harness/daemon-process-identity.js";
import {
	daemonSocketPaths,
	type DiscoveredDaemon,
	discoverDaemons,
	isDaemonSocketServing,
} from "../harness/session-paths.js";
import {
	collectAncestorPids,
	type ReapOptions,
	type ReapResult,
	reapOrphanHarnesses,
} from "./harness-process.js";

const STOP_GRACE_MS = 3_000;
const STOP_KILL_WAIT_MS = 1_000;
const STOP_POLL_MS = 200;

export interface DaemonControlDeps {
	discover?: (cwd: string) => DiscoveredDaemon[];
	/** Enumerated separately from pid files so missing metadata cannot hide a
	 * serving socket from the reaper's protected set. */
	socketPaths?: (cwd: string) => string[];
	/** PIDs of daemons for this repo that no pid file names — the `ps`-derived
	 *  orphan set. These are exactly the processes `disable` used to miss. */
	extraPids?: (cwd: string) => number[];
	probe?: (socketPath: string) => Promise<boolean>;
	kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	isAlive?: (pid: number) => boolean;
	/** Stable start-time + argv identity. Null means the PID is not a verified
	 * Interlinked daemon for this cwd and must never be signaled. */
	identify?: ProcessIdentityReader;
	/** Pids that must never be signalled (this process + its ancestor chain). */
	protectedPids?: () => Set<number>;
	/** Default true: subtract this process's ancestors from the stop targets.
	 *  The RESTART path passes false (review 2026-08-29, live-reproduced): an
	 *  automatic handover spawns `harness restart` FROM the daemon it must
	 *  replace, so the daemon is the CLI's ancestor — sparing it made every
	 *  automatic handover a silent no-op ("already running") that the watcher
	 *  retried forever. Safe to disable here because `targets` only ever holds
	 *  pid-file/ps-verified harness daemons, never the invoking shell; the CLI
	 *  process itself stays protected unconditionally. */
	spareAncestralDaemons?: boolean;
	recordEvent?: (evt: DaemonLedgerEvent) => void;
	wait?: (ms: number) => Promise<void>;
	/** Test seam — the underlying `ps`-driven sweep. Injecting it is what lets a
	 *  unit test assert that the protected set actually REACHED the sweep, which
	 *  is the whole invariant `reapOrphanHarnessesVerified` exists to hold. */
	reap?: (cwd: string, opts: ReapOptions) => ReapResult;
}

function realKill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try {
		process.kill(pid, signal);
	} catch {
		/* intentional: ESRCH (already gone) is the expected happy path */
	}
}

interface StopSignalDeps {
	identify: ProcessIdentityReader;
	isAlive: (pid: number) => boolean;
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	wait: (ms: number) => Promise<void>;
}

async function waitForExit(args: {
	cwd: string;
	targets: ReadonlyMap<number, string>;
	deps: StopSignalDeps;
	maxMs: number;
}): Promise<Map<number, string>> {
	const { cwd, targets, deps, maxMs } = args;
	const { isAlive, identify, wait } = deps;
	let remaining = stillMatchingIdentities(cwd, targets, isAlive, identify);
	let elapsed = 0;
	while (remaining.size > 0 && elapsed < maxMs) {
		const delay = Math.min(STOP_POLL_MS, maxMs - elapsed);
		await wait(delay);
		elapsed += delay;
		remaining = stillMatchingIdentities(cwd, remaining, isAlive, identify);
	}
	return remaining;
}

function collectStopCandidates(cwd: string, deps: DaemonControlDeps): Set<number> {
	const discover = deps.discover ?? discoverDaemons;
	const extras = deps.extraPids ?? orphanPids;
	const protectedPids = (deps.protectedPids ?? collectAncestorPids)();
	const targets = new Set<number>();
	for (const entry of discover(cwd)) {
		if (entry.pid !== null && entry.alive) targets.add(entry.pid);
	}
	for (const pid of extras(cwd)) targets.add(pid);
	if (deps.spareAncestralDaemons ?? true) {
		for (const pid of protectedPids) targets.delete(pid);
	}
	targets.delete(process.pid);
	return targets;
}

function collectStopTargets(cwd: string, deps: DaemonControlDeps): Map<number, string> {
	return verifiedProcessIdentities(
		cwd,
		collectStopCandidates(cwd, deps),
		deps.identify ?? readHarnessProcessIdentity,
	);
}

function signalMatchingTargets(args: {
	cwd: string;
	targets: ReadonlyMap<number, string>;
	signal: "SIGTERM" | "SIGKILL";
	deps: StopSignalDeps;
}): void {
	const { cwd, targets, signal, deps } = args;
	for (const [pid, expectedIdentity] of targets) {
		if (
			sameProcessIdentity({
				cwd,
				pid,
				expectedIdentity,
				isAlive: deps.isAlive,
				identify: deps.identify,
			})
		) {
			deps.kill(pid, signal);
		}
	}
}

async function terminateTargets(
	cwd: string,
	targets: Map<number, string>,
	deps: DaemonControlDeps,
): Promise<StopAllResult> {
	const kill = deps.kill ?? realKill;
	const isAlive = deps.isAlive ?? isProcessAlive;
	const identify = deps.identify ?? readHarnessProcessIdentity;
	const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const signalDeps = { identify, isAlive, kill, wait };
	signalMatchingTargets({ cwd, targets, signal: "SIGTERM", deps: signalDeps });
	const afterTerm = await waitForExit({
		cwd,
		targets,
		deps: signalDeps,
		maxMs: STOP_GRACE_MS,
	});
	signalMatchingTargets({ cwd, targets: afterTerm, signal: "SIGKILL", deps: signalDeps });
	const afterKill = await waitForExit({
		cwd,
		targets: afterTerm,
		deps: signalDeps,
		maxMs: STOP_KILL_WAIT_MS,
	});
	const survived = [...afterKill.keys()];
	const survivedSet = new Set(survived);
	return { stopped: [...targets.keys()].filter((pid) => !survivedSet.has(pid)), survived };
}

function orphanPids(cwd: string): number[] {
	return reapOrphanHarnesses(cwd, { dryRun: true }).candidates.map((c) => c.pid);
}

async function mappedServingPids(
	entries: readonly DiscoveredDaemon[],
	probe: (socketPath: string) => Promise<boolean>,
): Promise<{ serving: Set<number>; mappedSockets: Set<string> }> {
	const serving = new Set<number>();
	const mappedSockets = new Set<string>();
	for (const entry of entries) {
		if (entry.pid === null || !entry.alive) continue;
		mappedSockets.add(entry.paths.socket);
		if (await probe(entry.paths.socket)) serving.add(entry.pid);
	}
	return { serving, mappedSockets };
}

async function hasUnmappedServingSocket(args: {
	socketPaths: readonly string[];
	mappedSockets: ReadonlySet<string>;
	probe: (socketPath: string) => Promise<boolean>;
}): Promise<boolean> {
	const { socketPaths, mappedSockets, probe } = args;
	for (const socketPath of socketPaths) {
		if (!mappedSockets.has(socketPath) && (await probe(socketPath))) return true;
	}
	return false;
}

/**
 * The PIDs of daemons that are actually ANSWERING for this repo.
 *
 * This is the reaper's protected set: a process in here is doing the job the
 * reaper exists to protect, so it is never a victim, whatever the pid files
 * say. A dead process is never probed (its socket may be a corpse another
 * daemon has since replaced).
 */
export async function collectServingDaemonPids(
	cwd: string,
	deps: DaemonControlDeps = {},
): Promise<Set<number>> {
	const discover = deps.discover ?? discoverDaemons;
	const listSockets = deps.socketPaths ?? daemonSocketPaths;
	const candidates = deps.extraPids ?? orphanPids;
	const probe = deps.probe ?? ((p: string) => isDaemonSocketServing(p));
	const { serving, mappedSockets } = await mappedServingPids(discover(cwd), probe);
	if (
		await hasUnmappedServingSocket({
			socketPaths: listSockets(cwd),
			mappedSockets,
			probe,
		})
	) {
		// No pid-to-socket mapping means the exact owner is unknowable. Protect
		// every ps-verified daemon for this cwd: leaving an orphan alive is safer
		// than killing the process currently serving the guard.
		for (const pid of candidates(cwd)) serving.add(pid);
	}
	return serving;
}

/**
 * Orphan sweep that cannot kill a working daemon: the serving set is resolved
 * over the socket first and handed to the sweep as protected pids.
 *
 * Every reaper call site should use THIS, not `reapOrphanHarnesses` directly.
 */
export async function reapOrphanHarnessesVerified(
	cwd: string,
	opts: { dryRun?: boolean; killAll?: boolean } = {},
	deps: DaemonControlDeps = {},
): Promise<ReapResult> {
	const protectPids = await collectServingDaemonPids(cwd, deps);
	return (deps.reap ?? reapOrphanHarnesses)(cwd, { ...opts, protectPids });
}

export interface StopAllResult {
	stopped: number[];
	survived: number[];
}

/**
 * Stop EVERY daemon process serving this repo — the pid-file daemon, every
 * per-session daemon, and the `ps`-visible orphans no pid file names.
 *
 * Unlike a reaper this MAY stop a serving daemon: that is the point of an
 * explicit stop. One `explicit-stop` ledger row is written before the signals
 * so the resulting `signal` exits classify as planned instead of reading like
 * the storm's reaper kills.
 */
export async function stopAllDaemons(
	cwd: string,
	deps: DaemonControlDeps = {},
): Promise<StopAllResult> {
	const targets = collectStopTargets(cwd, deps);
	if (targets.size === 0) return { stopped: [], survived: [] };

	(deps.recordEvent ?? ((evt: DaemonLedgerEvent) => recordDaemonEvent(cwd, evt)))({
		at: Date.now(),
		pid: process.pid,
		event: "handover",
		reason: "explicit-stop",
		detail: `stopping ${targets.size} daemon(s): ${[...targets.keys()].join(", ")}`,
	});
	return terminateTargets(cwd, targets, deps);
}
