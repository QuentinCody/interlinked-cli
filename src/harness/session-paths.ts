// ===========================================
// Per-session daemon path derivation
// ===========================================
// The legacy design keyed the daemon off a single `.interlinked/harness.sock`
// per repo. The Phase-E design allows multiple concurrent sessions — each
// CLI session gets its own socket and PID file keyed by session id.
//
// Fallback behavior for backward compatibility: when no session id is
// provided we return the legacy paths so existing deployments keep working.
// An explicit "default" session id is different: it names the framed default
// front door (`harness-default.sock`) used when no runner-specific session id
// is available.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { nonNull } from "../lib/non-null.js";
import {
	classifyHarnessSocket,
	type HarnessSocketState,
	isHarnessSocketReady,
} from "./socket-readiness.js";

export interface DaemonPaths {
	socket: string;
	pid: string;
	log: string;
}

/** Compute the socket/PID/log paths for a given repo root + optional session id. */
export function daemonPathsFor(repoRoot: string, sessionId?: string): DaemonPaths {
	const base = join(repoRoot, ".interlinked");
	if (!sessionId) {
		return {
			socket: join(base, "harness.sock"),
			pid: join(base, "harness.pid"),
			log: join(base, "logs", "daemon.log"),
		};
	}
	const safe = sanitizeSessionId(sessionId);
	return {
		socket: join(base, `harness-${safe}.sock`),
		pid: join(base, `harness-${safe}.pid`),
		log: join(base, "logs", `daemon-${safe}.log`),
	};
}

/** Sanitize a session id for safe use in filenames. Keeps alphanumerics,
 *  underscores, hyphens; replaces everything else with underscore; caps the
 *  length at 64 characters. */
export function sanitizeSessionId(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned.slice(0, 64);
}

/** Every daemon socket file present under `.interlinked/` — the legacy raw
 *  `harness.sock` plus any framed `harness-<id>.sock`. Callers that need to ask
 *  "is ANY daemon serving this repo?" (the startup-lock waiter, the hook's
 *  cold-fallback freshness probe) enumerate here rather than guessing one path:
 *  a framed-only deployment has no raw socket, and probing only the raw path
 *  reported a healthy daemon as unreachable. Never throws. */
export function daemonSocketPaths(repoRoot: string): string[] {
	const base = join(repoRoot, ".interlinked");
	try {
		return readdirSync(base)
			.filter((name) => /^harness(-.+)?\.sock$/.test(name))
			.sort()
			.map((name) => join(base, name));
	} catch {
		return [];
	}
}

export interface DiscoveredDaemon {
	session_id: string;
	paths: DaemonPaths;
	pid: number | null;
	alive: boolean;
}

/** Walk .interlinked/ looking for all daemon PID/socket pairs. Used by
 *  `interlinked status` and `interlinked doctor`. */
export function discoverDaemons(repoRoot: string): DiscoveredDaemon[] {
	const base = join(repoRoot, ".interlinked");
	if (!existsSync(base)) return [];

	const out: DiscoveredDaemon[] = [];
	let entries: string[];
	try {
		entries = readdirSync(base);
	} catch {
		return [];
	}

	for (const name of entries) {
		if (!name.endsWith(".pid")) continue;
		const pidPath = join(base, name);
		const sessionId = parseSessionIdFromFilename(name);
		const paths = name === "harness.pid" ? daemonPathsFor(repoRoot) : daemonPathsFor(repoRoot, sessionId);
		const pid = readPidFile(pidPath);
		out.push({
			session_id: sessionId,
			paths,
			pid,
			alive: pid != null && isProcessAlive(pid),
		});
	}
	return out;
}

/** Remove stale PID + socket files for sessions whose process is gone. */
export function cleanupOrphans(repoRoot: string): DiscoveredDaemon[] {
	const found = discoverDaemons(repoRoot);
	const cleaned: DiscoveredDaemon[] = [];
	for (const entry of found) {
		if (entry.alive) continue;
		removeIfExists(entry.paths.pid);
		removeIfExists(entry.paths.socket);
		cleaned.push(entry);
	}
	return cleaned;
}

/**
 * Return the PID owning `pidPath` when a LIVE, foreign process holds it,
 * else null. "Foreign" = not this process. Used as a pre-bind guard so a
 * second daemon start (or a stray `import('server.js')`, which runs the
 * startup as a side effect) refuses to unlink + rebind a socket a live
 * daemon already owns — the raw-socket analogue of the framed daemon's
 * PID-aware check in `session-daemon.ts`. A stale pid file (dead process)
 * returns null, so normal restarts after a crash proceed.
 */
export function liveForeignDaemonPid(pidPath: string): number | null {
	const pid = readPidFile(pidPath);
	if (pid === null || pid === process.pid) return null;
	return isProcessAlive(pid) ? pid : null;
}

export interface SocketProbeOptions {
	/** Hard deadline in milliseconds for the connect attempt. */
	timeout_ms?: number;
}

/** Default probe deadline: a live, healthy daemon accepts a Unix-domain
 *  connect essentially instantly, so a few hundred ms is generous headroom
 *  without meaningfully slowing down the (rare) anti-stomp check path. */
const DEFAULT_SOCKET_PROBE_TIMEOUT_MS = 300;

/**
 * Probe whether `socketPath` has a live listener actually ACCEPTING
 * connections — the complement to `liveForeignDaemonPid`'s "is the PID
 * alive" check. A daemon process can survive an unexpected error
 * (`installCrashResilience` deliberately keeps the process running for
 * continuity) while the thing that failed was its own socket listener: the
 * PID is alive, the pid file is intact, but nothing is bound to the socket
 * path anymore. `liveForeignDaemonPid` alone reads that as "a healthy
 * incumbent owns this" and defers forever — measured in production as a
 * daemon that stayed alive 9+ hours with `lsof` showing no listener, while
 * every new start lost the anti-stomp race and exited, over and over.
 *
 * Resolves:
 *   - `true`  — a listener accepted the connection: the incumbent is really
 *     serving, so the caller should defer to it (the safe, unchanged
 *     behavior for a genuinely healthy daemon).
 *   - `false` — the connection was refused, or the socket path doesn't
 *     exist / isn't a socket (`ECONNREFUSED` / `ENOENT` / `ENOTSOCK`): an
 *     unambiguous "nobody is listening here" signal. Safe to reap the
 *     zombie and take over.
 *   - `true`  — anything else (timeout, an unexpected error code): FAIL
 *     SAFE. We can't distinguish "healthy but momentarily slow" from
 *     "wedged", and stomping a possibly-healthy daemon's socket is the
 *     worse failure mode, so ambiguity defers exactly like the pre-fix
 *     behavior did.
 *
 * Never rejects for a normal connect-level failure — every branch above
 * resolves. A synchronous throw from `createConnection` itself (malformed
 * path, platform quirk) is NOT swallowed here; the caller decides how to
 * fail safe on that (see `server.ts`'s anti-stomp check).
 */
function probeDaemonSocket(
	socketPath: string,
	opts: SocketProbeOptions,
	ambiguousResult: boolean,
): Promise<boolean> {
	const timeoutMs = opts.timeout_ms ?? DEFAULT_SOCKET_PROBE_TIMEOUT_MS;
	return new Promise((resolve) => {
		let settled = false;
		const socket = createConnection(socketPath);
		const finish = (result: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.destroy();
			} catch {
				/* intentional: socket already destroyed or never connected */
			}
			resolve(result);
		};
		const timer = setTimeout(() => finish(ambiguousResult), timeoutMs);
		socket.on("connect", () => finish(true));
		socket.on("error", (err: NodeJS.ErrnoException) => {
			const code = err.code;
			if (code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK") {
				finish(false);
				return;
			}
			finish(ambiguousResult);
		});
	});
}

export function isDaemonSocketServing(
	socketPath: string,
	opts: SocketProbeOptions = {},
): Promise<boolean> {
	return probeDaemonSocket(socketPath, opts, true);
}

/** Strict startup-readiness probe. Unlike the anti-stomp probe above, an
 * ambiguous timeout or unexpected socket error is not readiness: callers may
 * report success only after a real connection was accepted. */
export function isDaemonSocketReady(
	socketPath: string,
	opts: SocketProbeOptions = {},
): Promise<boolean> {
	const protocol = basename(socketPath) === "harness.sock" ? "raw" : "framed";
	return isHarnessSocketReady({ socketPath, protocol, opts }).catch(() => false);
}

export function classifyDaemonSocket(
	socketPath: string,
	opts: SocketProbeOptions = {},
): Promise<HarnessSocketState> {
	const protocol = basename(socketPath) === "harness.sock" ? "raw" : "framed";
	return classifyHarnessSocket({ socketPath, protocol, opts });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function parseSessionIdFromFilename(name: string): string {
	// Either "harness.pid" → "default", or "harness-<id>.pid" → "<id>"
	if (name === "harness.pid") return "default";
	const m = /^harness-(.+)\.pid$/.exec(name);
	return m ? nonNull(m[1]) : "default";
}

function readPidFile(path: string): number | null {
	if (!existsSync(path)) return null;
	const raw = safeReadFile(path);
	const n = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function safeReadFile(path: string): string {
	let out = "";
	try {
		out = readFileSync(path, "utf-8");
	} catch {
		out = "";
	}
	return out;
}

function isProcessAlive(pid: number): boolean {
	let alive = false;
	try {
		// Signal 0 checks for existence without delivering a signal.
		process.kill(pid, 0);
		alive = true;
	} catch (err) {
		alive = (err as NodeJS.ErrnoException).code === "EPERM";
	}
	return alive;
}

function removeIfExists(path: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	try {
		// Socket files show up as special files; rm with force handles both.
		statSync(path);
		rmSync(path, { force: true });
		removed = true;
	} catch {
		removed = false;
	}
	return removed;
}
