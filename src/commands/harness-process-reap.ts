// interlinked-tdd: exempt
// ===========================================
// interlinked harness — orphan-reap selection + termination helpers
// ===========================================
// Pure private helpers split out of `harness-process.ts`: ps-row parsing,
// orphan candidate selection, SIGTERM/SIGKILL escalation, process-liveness
// polling, and stale pid/sock-file cleanup. `reapOrphanHarnesses` (in
// harness-process.ts) is the only consumer; these have no module-private state
// and form a leaf cluster, so the split introduces no circular import. The
// `OrphanCandidate` type lives here (the cluster's natural owner) and is
// re-exported from harness-process.ts so existing importers stay unchanged.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type ProcessIdentityReader,
	isHarnessDaemonCommandForCwd,
	readHarnessProcessIdentity,
	sameProcessIdentity,
	stillMatchingIdentities,
	verifiedProcessIdentities,
} from "../harness/daemon-process-identity.js";

/**
 * Candidate harness daemon row pulled from `ps` and filtered by the
 * orphan-selection rules. Returned by `reapOrphanHarnesses` so the operational
 * `harness reap` command can format and report on them — and so tests can
 * assert which PIDs would have been touched without actually signalling them.
 */
export interface OrphanCandidate {
	pid: number;
	ppid: number;
	command: string;
}

/** Parse one `ps` row of the form `<pid> <ppid> <command>`. Returns null when
 *  the line doesn't match (blank lines, header residue) or the pid is NaN. */
function parsePsRow(line: string): OrphanCandidate | null {
	const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
	if (!m) return null;
	const pid = Number.parseInt(m[1] as string, 10);
	const ppid = Number.parseInt(m[2] as string, 10);
	const command = m[3] as string;
	if (Number.isNaN(pid)) return null;
	return { pid, ppid, command };
}

/**
 * True when a parsed `ps` row is a reapable orphan harness for THIS workspace,
 * after applying the self / non-harness / cross-cwd / ancestor / active-pid
 * protections. The `killAll` flag drops the active-pid protection (but never the
 * ancestor protection — that would kill the shell that invoked us).
 */
function isReapCandidate(
	row: OrphanCandidate,
	cwd: string,
	ancestorPids: Set<number>,
	activePid: number | null,
	killAll: boolean,
): boolean {
	const { pid, command: cmd } = row;
	if (pid === process.pid) return false;
	if (!isHarnessDaemonCommandForCwd({ command: cmd, cwd })) return false;
	// Never SIGTERM our own ancestor chain — true in both default and killAll
	// mode. killAll additionally treats the active daemon as fair game.
	if (ancestorPids.has(pid)) return false;
	if (!killAll && activePid !== null && pid === activePid) return false;
	return true;
}

/**
 * Walk the `ps` table and return the orphan harness daemons eligible for
 * reaping in `cwd`. Pure filtering — no signalling, no fs writes — so the dry-run
 * surface and the live reap share one selection rule.
 */
export function collectReapCandidates(
	ps: string,
	cwd: string,
	ancestorPids: Set<number>,
	activePid: number | null,
	killAll: boolean,
): OrphanCandidate[] {
	const candidates: OrphanCandidate[] = [];
	for (const line of ps.split("\n")) {
		const row = parsePsRow(line);
		if (!row) continue;
		if (isReapCandidate(row, cwd, ancestorPids, activePid, killAll)) {
			candidates.push(row);
		}
	}
	return candidates;
}

function authenticatedCandidateStillOwnsPid(args: {
	cwd: string;
	pid: number;
	expectedIdentity: string;
	identify: ProcessIdentityReader;
	onExited: (pid: number) => void;
}): boolean {
	const { cwd, pid, expectedIdentity, identify, onExited } = args;
	if (sameProcessIdentity({ cwd, pid, expectedIdentity, isAlive: hasProcess, identify })) {
		return true;
	}
	if (!hasProcess(pid)) onExited(pid);
	return false;
}

/**
 * Send one signal to one daemon PID. Returns true when the signal was delivered,
 * so the caller can record the PID as awaiting exit. An ESRCH means the process
 * is already gone, which counts as reaped and is reported through `markKilled`;
 * a permission error is neither delivered nor reaped.
 */
function signalDaemon(
	pid: number,
	signal: "SIGTERM" | "SIGKILL",
	markKilled: (pid: number) => void,
): boolean {
	try {
		process.kill(pid, signal);
		return true;
	} catch (err) {
		if (isNoSuchProcessError(err)) markKilled(pid);
		return false;
	}
}

/**
 * SIGTERM every candidate, wait under one shared deadline, then SIGKILL only the
 * survivors and wait again. Returns the PIDs confirmed gone (an ESRCH at any
 * signalling step counts as reaped; a permission error does not). Batching all
 * signals before the first wait keeps N SIGTERM-deaf orphans from costing
 * N × (TERM grace + KILL grace).
 */
export function terminateCandidates(
	candidates: readonly OrphanCandidate[],
	cwd: string,
	identify: ProcessIdentityReader = readHarnessProcessIdentity,
): number[] {
	const killed: number[] = [];
	const killedSet = new Set<number>();
	const markKilled = (pid: number): void => {
		if (killedSet.has(pid)) return;
		killedSet.add(pid);
		killed.push(pid);
	};

	const verified = verifiedProcessIdentities(
		cwd,
		candidates.map((candidate) => candidate.pid),
		identify,
	);
	const termSent = new Map<number, string>();
	for (const candidate of candidates) {
		const expectedIdentity = verified.get(candidate.pid);
		if (expectedIdentity === undefined) continue;
		if (
			!authenticatedCandidateStillOwnsPid({
				cwd,
				pid: candidate.pid,
				expectedIdentity,
				identify,
				onExited: markKilled,
			})
		) {
			continue;
		}
		// Signal every candidate before waiting. With per-candidate waits, N
		// SIGTERM-deaf orphans cost N * (TERM grace + KILL grace) and later daemons
		// were not even signalled until earlier timeouts expired.
		if (signalDaemon(candidate.pid, "SIGTERM", markKilled)) {
			termSent.set(candidate.pid, expectedIdentity);
		}
	}

	// Verify all signalled processes under one shared deadline, then escalate only
	// survivors. This preserves the "don't clear pid files unless the process is
	// truly gone" contract without serial timeouts.
	const termSurvivors = waitForIdentityExit(cwd, termSent, REAP_GRACE_MS, markKilled, identify);
	const killSent = new Map<number, string>();
	for (const [pid, expectedIdentity] of termSurvivors) {
		if (identify(cwd, pid) !== expectedIdentity) {
			markKilled(pid);
			continue;
		}
		if (signalDaemon(pid, "SIGKILL", markKilled)) killSent.set(pid, expectedIdentity);
	}
	waitForIdentityExit(cwd, killSent, REAP_KILL_GRACE_MS, markKilled, identify);
	return killed;
}

/** Grace window for the daemon to exit on SIGTERM before we escalate to
 *  SIGKILL. Three seconds covers the longest normal shutdown path
 *  (async-analysis drain caps at 2s) without making restarts feel sluggish. */
const REAP_GRACE_MS = 3000;
/** After SIGKILL the kernel reaps within milliseconds; one second is overkill
 *  but cheap insurance against pathological scheduling. */
const REAP_KILL_GRACE_MS = 1000;

function waitForIdentityExit(
	cwd: string,
	targets: ReadonlyMap<number, string>,
	timeoutMs: number,
	onExited: (pid: number) => void,
	identify: ProcessIdentityReader,
): Map<number, string> {
	let alive = stillMatchingIdentities(cwd, targets, hasProcess, identify);
	for (const pid of targets.keys()) if (!alive.has(pid)) onExited(pid);
	const deadline = Date.now() + timeoutMs;
	while (alive.size > 0 && Date.now() < deadline) {
		const previous = alive;
		alive = stillMatchingIdentities(cwd, previous, hasProcess, identify);
		for (const pid of previous.keys()) if (!alive.has(pid)) onExited(pid);
		if (alive.size === 0) break;
		const buf = new SharedArrayBuffer(4);
		Atomics.wait(new Int32Array(buf), 0, 0, 50);
	}
	const previous = alive;
	alive = stillMatchingIdentities(cwd, previous, hasProcess, identify);
	for (const pid of previous.keys()) if (!alive.has(pid)) onExited(pid);
	return alive;
}

function hasProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return !isNoSuchProcessError(err);
	}
}

function isNoSuchProcessError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as NodeJS.ErrnoException).code === "ESRCH"
	);
}

/** After reaping, drop any pid/sock files whose contents reference the
 *  killed PIDs. Without this the next start sees `existingPid !== null` and
 *  refuses to bind even though no daemon is alive. Best-effort: missing or
 *  unreadable files are skipped silently. */
export function clearOrphanedPidFiles(cwd: string, killedPids: number[]): void {
	const killedSet = new Set(killedPids);
	for (const pidPath of harnessPidFilePaths(join(cwd, ".interlinked"))) {
		removeStalePidFile(pidPath, killedSet);
	}
}

/** Every `harness.pid` / `harness-<name>.pid` path in `dir`. An unreadable
 *  directory yields no paths, so cleanup becomes a no-op. */
function harnessPidFilePaths(dir: string): string[] {
	const paths: string[] = [];
	try {
		for (const name of readdirSync(dir)) {
			if (name === "harness.pid" || /^harness-.+\.pid$/.test(name)) {
				paths.push(join(dir, name));
			}
		}
	} catch {
		return [];
	}
	return paths;
}

/** Drop one pid file, and its paired socket, when it names a reaped PID that no
 *  process owns any more. Best-effort: unreadable or already-removed files are
 *  skipped silently. */
function removeStalePidFile(pidPath: string, killedSet: ReadonlySet<number>): void {
	let pidStr = "";
	try {
		pidStr = readFileSync(pidPath, "utf-8").trim();
	} catch {
		return;
	}
	const filePid = Number.parseInt(pidStr, 10);
	if (!Number.isFinite(filePid)) return;
	if (!killedSet.has(filePid)) return;
	// A numeric PID can be reused between termination and cleanup. Never
	// delete metadata (or its socket) while any process now owns that PID.
	if (hasProcess(filePid)) return;
	try {
		rmSync(pidPath, { force: true });
	} catch {
		/* intentional: best-effort cleanup — already-removed pid is fine */
	}
	// Pair with its socket file — same prefix, .sock suffix.
	const sockPath = pidPath.replace(/\.pid$/, ".sock");
	try {
		if (existsSync(sockPath)) rmSync(sockPath, { force: true });
	} catch {
		/* intentional: best-effort cleanup — already-removed socket is fine */
	}
}
