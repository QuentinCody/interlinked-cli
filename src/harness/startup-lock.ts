// ===========================================
// Daemon startup mutex — N concurrent starts collapse to ONE binder
// ===========================================
// Measured 2026-08-15: bursts of 2–3 daemon starts inside the same second, the
// losers exiting `startup-failed` ("raw socket bind: EADDRINUSE") or
// `anti-stomp`, the winner SIGTERM'd 10s later by the next burst's reaper.
// Every blocked tool call printed "run `interlinked harness start`", so every
// blocked caller ran it — a thundering herd that sustained itself for hours.
//
// The fix is a mutex, not a longer retry. One process wins an O_EXCL lock file
// and binds; everyone else WAITS on the socket and reports what the winner is
// doing. Nobody else reaps, binds, or writes a `startup-failed` row.
//
// Design constraints:
//  - O_EXCL create is the only atomic primitive available across every fs the
//    repo may live on; mtime comparison (the previous self-heal throttle) is
//    check-then-act and races exactly when it matters.
//  - A stale lock MUST self-clear: a daemon killed between acquire and release
//    would otherwise wedge every future start. Two independent staleness
//    signals — the recorded age (TTL) and the holder pid's liveness.
//  - Never throw. A start path that dies of its lock is worse than a herd.

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { daemonSocketPaths, isDaemonSocketReady } from "./session-paths.js";

/** Lock file name, under `.interlinked/`. Hidden so it never shows up in the
 *  data-directory INDEX as a durable artifact — it is transient by design. */
const STARTUP_LOCK_FILE = ".harness-start.lock";

/** A lock older than this is presumed abandoned. Canonical startup can wait up
 * to 60s for a cold compiler- and memory-pressure-bound daemon. Keep a margin
 * above that window so scheduler jitter cannot make a live child stealable at
 * the readiness deadline. Generated hooks cannot remain alive to heartbeat
 * the child-owned lease, so they share this same bound. */
export const STARTUP_LOCK_TTL_MS = 75_000;

/** How long a loser waits for the winner's socket before giving up and saying
 *  so. Deliberately longer than a normal boot and shorter than a hook's
 *  patience: the loser reports, it does not hang the CLI. */
const STARTUP_WAIT_MS = 8_000;

/** A newly O_EXCL-created lock exists briefly before its JSON holder bytes are
 * visible. An unreadable file inside this grace is an initializing mutex, not
 * stale metadata that a contender may unlink. */
export const STARTUP_LOCK_INITIALIZATION_GRACE_MS = 2_000;

/** Socket poll interval while waiting for the winner. */
const STARTUP_POLL_MS = 250;

export interface StartupLockHolder {
	pid: number;
	at: number;
}

export type StartupLockResult =
	| { acquired: true; path: string; release: () => void }
	| { acquired: false; holder: StartupLockHolder | null };

export function startupLockPath(repoRoot: string): string {
	return join(repoRoot, ".interlinked", STARTUP_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The current holder, or null when the file is absent/garbage. Never throws. */
export function readStartupLockHolder(repoRoot: string): StartupLockHolder | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(startupLockPath(repoRoot), "utf-8"));
		if (typeof raw !== "object" || raw === null) return null;
		// SAFETY: object-ness checked above; both fields are type-tested below
		// before the holder is trusted by any caller.
		const holder = raw as Partial<StartupLockHolder>;
		if (typeof holder.pid !== "number" || typeof holder.at !== "number") return null;
		return { pid: holder.pid, at: holder.at };
	} catch {
		return null;
	}
}

/** True when a lock may be broken: no readable holder, an expired timestamp, or
 *  a holder process that no longer exists. */
export function isStartupLockStale(holder: StartupLockHolder | null, nowMs: number): boolean {
	if (holder === null) return true;
	if (nowMs - holder.at > STARTUP_LOCK_TTL_MS) return true;
	return !isProcessAlive(holder.pid);
}

function writeLockFile(path: string, pid: number, nowMs: number): boolean {
	let fd: number | null = null;
	try {
		fd = openSync(path, "wx");
		writeSync(fd, JSON.stringify({ pid, at: nowMs }));
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		// Any OTHER fs failure (read-only mount, permissions) must not stop the
		// daemon from starting: an un-mutexed start is degraded, a start that
		// never happens is an outage. Report success with a no-op release.
		return true;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* intentional: fd close is best-effort */
			}
		}
	}
}

function startupLockIsInitializing(path: string, nowMs: number): boolean {
	try {
		return nowMs - statSync(path).mtimeMs <= STARTUP_LOCK_INITIALIZATION_GRACE_MS;
	} catch {
		return false;
	}
}

let lockTempSequence = 0;

/** Atomically replace a holder only while the exact owner snapshot still
 * matches. Readers therefore observe the old or new valid JSON, never the
 * truncate-before-write interval that used to look like a stale lock. */
function replaceStartupLockHolder(
	repoRoot: string,
	expected: StartupLockHolder,
	next: StartupLockHolder,
): boolean {
	const path = startupLockPath(repoRoot);
	const tempPath = `${path}.${process.pid}.${++lockTempSequence}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(next), { flag: "wx" });
		const current = readStartupLockHolder(repoRoot);
		if (current === null || current.pid !== expected.pid || current.at !== expected.at) return false;
		renameSync(tempPath, path);
		return true;
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			/* intentional: rename consumed it, or creation failed */
		}
	}
}

/**
 * Try to become THE process that starts the daemon for `repoRoot`.
 *
 * Returns `{acquired: true, release}` for the single winner. Every other
 * concurrent caller gets `{acquired: false, holder}` and must NOT bind, reap,
 * or record a startup failure — it waits (see {@link waitForDaemonSocket}).
 *
 * One steal attempt is made when the existing lock is stale (expired TTL or a
 * dead holder). Exactly one retry, never a loop: if a second process steals in
 * the same instant, THIS one loses and waits, which is the correct outcome.
 */
export function acquireStartupLock(repoRoot: string, nowMs: number = Date.now()): StartupLockResult {
	const path = startupLockPath(repoRoot);
	try {
		mkdirSync(join(repoRoot, ".interlinked"), { recursive: true });
	} catch {
		/* intentional: dir may already exist, or be unwritable — writeLockFile decides */
	}
	const release = (): void => releaseStartupLock(repoRoot);
	if (writeLockFile(path, process.pid, nowMs)) return { acquired: true, path, release };

	const holder = readStartupLockHolder(repoRoot);
	if (holder === null && startupLockIsInitializing(path, nowMs)) {
		return { acquired: false, holder: null };
	}
	if (!isStartupLockStale(holder, nowMs)) return { acquired: false, holder };
	try {
		unlinkSync(path);
	} catch {
		/* intentional: another process may have cleared it first */
	}
	if (writeLockFile(path, process.pid, nowMs)) return { acquired: true, path, release };
	return { acquired: false, holder: readStartupLockHolder(repoRoot) };
}

/** Release a lock THIS process holds. A lock owned by someone else is left
 *  alone — releasing another process's mutex is how a herd restarts. */
export function releaseStartupLock(repoRoot: string): void {
	const holder = readStartupLockHolder(repoRoot);
	// Null can mean another O_EXCL winner has created the inode but has not yet
	// finished writing its holder JSON. Never unlink ambiguous metadata: the
	// initialization grace protects acquisition, and release must honor the same
	// window or it can erase the new winner's pathname out from under its fd.
	if (holder === null || holder.pid !== process.pid) return;
	try {
		unlinkSync(startupLockPath(repoRoot));
	} catch {
		/* intentional: already gone */
	}
}

/**
 * Transfer a startup lease owned by THIS process to the daemon it spawned.
 *
 * Hook entry points are intentionally short-lived. Leaving the lease under the
 * hook PID makes it stale the instant that hook exits, so the next concurrent
 * hook steals it and spawns another daemon. The child PID keeps the lease live
 * across processes until the daemon either starts serving or dies. Ownership
 * is checked before the rewrite; another process's lease is never adopted.
 */
export function transferStartupLock(
	repoRoot: string,
	input: { childPid: number; nowMs?: number },
): boolean {
	const { childPid, nowMs = Date.now() } = input;
	if (!Number.isSafeInteger(childPid) || childPid <= 0) return false;
	const holder = readStartupLockHolder(repoRoot);
	if (holder === null || holder.pid !== process.pid) return false;
	return replaceStartupLockHolder(repoRoot, holder, { pid: childPid, at: nowMs });
}

/**
 * Refresh a lock THIS process holds so a legitimately slow start does not go
 * stale under a concurrent caller mid-poll.
 *
 * Root cause this closes (2026-08-22 postmortem): `isStartupLockStale`
 * declares a lock stale once its `at` timestamp is older than
 * `STARTUP_LOCK_TTL_MS` — REGARDLESS of whether the holder is still
 * alive. `daemonizeHarness` can legitimately poll for up to 60s (a cold
 * TypeScript compile, or a swap-bound machine under load), so the lock's
 * fixed acquisition timestamp goes stale from every OTHER caller's point of
 * view long before the holder is actually done. The next `harness start` /
 * self-heal then steals the lock and starts a competing daemon spawn while
 * the first one is still legitimately in flight — the second contributor to
 * the churn (the first is the unconditional kill in `stopRunningHarnessForRestart`,
 * fixed via `resolveRestartAction` in harness-lifecycle-helpers.ts).
 *
 * The caller (`daemonizeHarness`'s poll loop) calls this once per tick. A
 * lock owned by someone else is left untouched — same ownership rule as
 * `releaseStartupLock`; never throws.
 */
export function touchStartupLock(repoRoot: string, nowMs: number = Date.now()): void {
	touchStartupLockHolder(repoRoot, { holderPid: process.pid, nowMs });
}

/** Heartbeat a lease already transferred to a known child while the parent
 * CLI polls that child's socket. The expected PID is explicit and must match
 * the file, so this cannot refresh an unrelated process's lease. */
export function touchStartupLockHolder(
	repoRoot: string,
	input: { holderPid: number; nowMs?: number },
): void {
	const { holderPid, nowMs = Date.now() } = input;
	const holder = readStartupLockHolder(repoRoot);
	if (holder === null || holder.pid !== holderPid) return;
	replaceStartupLockHolder(repoRoot, holder, { pid: holderPid, at: nowMs });
}

export interface WaitOptions {
	timeout_ms?: number;
	poll_ms?: number;
	/** Test seam — defaults to a real Unix-socket connect probe. */
	probe?: (socketPath: string) => Promise<boolean>;
	/** Test seam — defaults to listing `.interlinked/harness*.sock`. */
	listSockets?: (repoRoot: string) => string[];
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll until SOME daemon socket for `repoRoot` answers, or the deadline passes.
 *
 * This is what a startup-lock loser does instead of binding: the winner is
 * already booting, so the only useful question is "is it up yet?". Resolves
 * true when a socket accepted a connection.
 */
export async function waitForDaemonSocket(repoRoot: string, opts: WaitOptions = {}): Promise<boolean> {
	const deadline = Date.now() + (opts.timeout_ms ?? STARTUP_WAIT_MS);
	const pollMs = opts.poll_ms ?? STARTUP_POLL_MS;
	const probe = opts.probe ?? ((p: string) => isDaemonSocketReady(p, { timeout_ms: pollMs }));
	const list = opts.listSockets ?? daemonSocketPaths;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	for (;;) {
		for (const socketPath of list(repoRoot)) {
			if (await probe(socketPath)) return true;
		}
		if (Date.now() >= deadline) return false;
		await sleep(pollMs);
	}
}

/** True when the lock file exists and is not stale — i.e. a start is genuinely
 *  in flight right now. Used for the "start pending" report. */
export function startupInFlight(repoRoot: string, nowMs: number = Date.now()): boolean {
	if (!existsSync(startupLockPath(repoRoot))) return false;
	return !isStartupLockStale(readStartupLockHolder(repoRoot), nowMs);
}
