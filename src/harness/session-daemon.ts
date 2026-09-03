// ===========================================
// Session daemon — Unix-socket wrapper around the dispatcher
// ===========================================
// Binds a per-session Unix socket, accepts newline-delimited JSON frames,
// routes them through the dispatcher, streams responses back. Idle-shutdown
// after `idle_shutdown_ms` of no activity. Registers its PID on start and
// clears it on stop.
//
// The legacy `server.ts` daemon (one socket per repo) keeps working; this
// module is the shape Phase E calls for. It may run side-by-side with the
// legacy daemon on a different socket path.

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";
import { readHarnessProcessIdentity } from "./daemon-process-identity.js";
import { type DispatcherState, dispatchRpc } from "./daemon-dispatcher.js";
import { pidFileNames, removePidFileIfOwned } from "./daemon-pid-ownership.js";
import {
	decodeFrame,
	encodeFrame,
	isRequest,
	makeError,
	type RpcMessage,
	splitFrames,
} from "./daemon-protocol.js";
import { reapZombieIncumbent } from "./server/anti-stomp.js";
import { bindSessionSocket, sessionSocketState } from "./session-daemon-bind.js";
import {
	type ClaimLockAttempt,
	claimLockIsCurrent,
	claimLockRecord,
	isProcessAlive,
	liveClaimLockIsCurrent,
	makeClaimLock,
	readFileText,
	recoverStaleClaimLock,
	removeCurrentClaimLock,
	type SessionClaimLock,
} from "./session-daemon-claim-lock.js";
import type { DaemonPaths } from "./session-paths.js";
import type { HarnessSocketState } from "./socket-readiness.js";

export interface SessionDaemonOptions {
	paths: DaemonPaths;
	session_id: string;
	/** Milliseconds with no activity before the daemon self-terminates. */
	idle_shutdown_ms?: number;
	/** Dispatcher state — tsgo runner + evaluator context factory. */
	state: Omit<DispatcherState, "shutdown" | "started_at" | "rpc_inflight">;
}

export interface SessionDaemonHandle {
	readonly paths: DaemonPaths;
	readonly session_id: string;
	readonly started_at: number;
	/** Gracefully shut down: unref socket, remove pid/sock files, close clients. */
	stop(reason?: string): Promise<void>;
	/** Number of in-flight RPCs. */
	rpcInflight(): number;
}

/** Thrown when another LIVE process already owns this session's pid file.
 *  Distinguishable from any other startup failure so the caller (server.ts)
 *  can route it through the anti-stomp loser contract (ledger row + exit)
 *  instead of `installCrashResilience()`'s survive-on-error path — right for
 *  a genuinely unexpected throw, wrong for an ALREADY-DECIDED ownership
 *  conflict: that process must actually terminate, not log and keep its
 *  already-registered timers running (the orphan-accumulation bug this
 *  type exists to close). */
export class DaemonOwnershipConflictError extends Error {
	constructor(
		public readonly sessionId: string,
		public readonly ownerPid: number,
	) {
		super(`session daemon already running for ${sessionId} (PID ${ownerPid})`);
		this.name = "DaemonOwnershipConflictError";
	}
}

export type SessionPidClaim = { claimed: true } | { claimed: false; ownerPid: number };

type LockedClaimAttempt = SessionPidClaim | { retry: true };

interface SessionPidClaimOptions {
	ownerIsValid?: (pid: number) => boolean;
}

const CLAIM_LOCK_ATTEMPTS = 40;
const CLAIM_LOCK_WAIT_MS = 2;
const claimWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function attemptClaimLock(lock: SessionClaimLock): ClaimLockAttempt {
	try {
		writeFileSync(lock.path, lock.raw, { flag: "wx" });
		return { lock };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	const observedRaw = readFileText(lock.path);
	if (liveClaimLockIsCurrent(claimLockRecord(observedRaw))) return { retry: true };
	return recoverStaleClaimLock(lock, observedRaw);
}

function waitForClaimTurn(): void {
	Atomics.wait(claimWaitBuffer, 0, 0, CLAIM_LOCK_WAIT_MS);
}

function acquireClaimLock(pidPath: string): SessionClaimLock {
	for (let attempt = 0; attempt < CLAIM_LOCK_ATTEMPTS; attempt++) {
		const result = attemptClaimLock(makeClaimLock(pidPath));
		if ("lock" in result) return result.lock;
		waitForClaimTurn();
	}
	throw new Error(`Could not acquire session pid claim lock: ${pidPath}.claim`);
}

function replacePidClaim(lock: SessionClaimLock, pidPath: string, pid: number): boolean {
	const nextPath = `${pidPath}.${lock.token}.next`;
	try {
		writeFileSync(nextPath, String(pid), { flag: "wx" });
		if (!claimLockIsCurrent(lock)) return false;
		renameSync(nextPath, pidPath);
		return claimLockIsCurrent(lock);
	} finally {
		rmSync(nextPath, { force: true });
	}
}

function claimPidWhileLocked(
	args: {
		lock: SessionClaimLock;
		pidPath: string;
		pid: number;
		opts: SessionPidClaimOptions;
	},
): LockedClaimAttempt {
	const { lock, pidPath, pid, opts } = args;
	const ownerPid = readPidFile(pidPath);
	if (ownerPid === pid) return { claimed: true };
	if (
		ownerPid !== null &&
		isProcessAlive(ownerPid) &&
		(opts.ownerIsValid === undefined || opts.ownerIsValid(ownerPid))
	) {
		return { claimed: false, ownerPid };
	}
	return replacePidClaim(lock, pidPath, pid) ? { claimed: true } : { retry: true };
}

/**
 * Atomically claim `pidPath` for `pid` under a fenced companion lock.
 *
 * Every contender first obtains `<pidPath>.claim` with an exclusive create.
 * Stale lock recovery installs a unique recovery marker before touching the
 * PID record, and a claimant verifies its marker before and after the atomic
 * temp-file rename. That fencing makes a contender whose lock was displaced
 * retry instead of reporting a second win. A process-start mismatch recovers
 * a reused PID; the short age bound applies only when the platform cannot
 * observe process-start identity. A crash can leave stale lock/temp artifacts,
 * but the next claimant recovers the dead/expired lock and ignores the
 * uniquely named temp file; no direct non-exclusive PID overwrite exists.
 */
export function claimSessionPid(
	pidPath: string,
	pid: number,
	opts: SessionPidClaimOptions = {},
): SessionPidClaim {
	for (let attempt = 0; attempt < CLAIM_LOCK_ATTEMPTS; attempt++) {
		const lock = acquireClaimLock(pidPath);
		let result: LockedClaimAttempt;
		try {
			result = claimPidWhileLocked({ lock, pidPath, pid, opts });
		} finally {
			removeCurrentClaimLock(lock);
		}
		if (!("retry" in result)) return result;
		waitForClaimTurn();
	}
	throw new Error(`Could not claim session pid file with a stable lock: ${pidPath}`);
}

type ObservedSessionSocketState = HarnessSocketState | "probe_failed";

async function observedSessionSocketState(socketPath: string): Promise<ObservedSessionSocketState> {
	if (!existsSync(socketPath)) return "absent";
	try {
		return await sessionSocketState(socketPath);
	} catch {
		return "probe_failed";
	}
}

export function removeOwnedSessionArtifacts(paths: DaemonPaths, pid: number): void {
	if (!pidFileNames(paths.pid, pid)) return;
	if (existsSync(paths.socket)) rmSync(paths.socket, { force: true });
	removePidFileIfOwned(paths.pid, pid);
}

interface SessionOwnershipArgs {
	paths: DaemonPaths;
	sessionId: string;
	cwd: string;
}

function claimOptionsForCwd(cwd: string): SessionPidClaimOptions {
	return {
		ownerIsValid: (pid) => readHarnessProcessIdentity(cwd, pid) !== null,
	};
}

function acceptFreshSessionClaim(args: SessionOwnershipArgs, state: ObservedSessionSocketState): void {
	if (state === "absent") return;
	removePidFileIfOwned(args.paths.pid, process.pid);
	if (state === "ready") throw new DaemonOwnershipConflictError(args.sessionId, 0);
	throw new Error(`A listener occupies ${args.paths.socket} but did not prove the Interlinked protocol.`);
}

async function replaceSessionOwner(args: SessionOwnershipArgs, ownerPid: number): Promise<void> {
	const reap = await reapZombieIncumbent({
		pid: ownerPid,
		cwd: args.cwd,
		logAlways: (msg: string) => console.error(msg),
	});
	if (reap !== "gone") {
		throw new Error(`Daemon PID ${ownerPid} could not be stopped with verified identity.`);
	}
	removePidFileIfOwned(args.paths.pid, ownerPid);
	const replacementClaim = claimSessionPid(
		args.paths.pid,
		process.pid,
		claimOptionsForCwd(args.cwd),
	);
	if (!replacementClaim.claimed) {
		throw new DaemonOwnershipConflictError(args.sessionId, replacementClaim.ownerPid);
	}
	if (existsSync(args.paths.socket)) rmSync(args.paths.socket, { force: true });
}

async function claimSessionOwnership(args: SessionOwnershipArgs): Promise<void> {
	const claim = claimSessionPid(args.paths.pid, process.pid, claimOptionsForCwd(args.cwd));
	const socketState = await observedSessionSocketState(args.paths.socket);
	if (claim.claimed) return acceptFreshSessionClaim(args, socketState);
	if (socketState === "probe_failed") {
		throw new Error(`Could not determine whether ${args.paths.socket} is safe to replace.`);
	}
	if (socketState === "ready") {
		throw new DaemonOwnershipConflictError(args.sessionId, claim.ownerPid);
	}
	await replaceSessionOwner(args, claim.ownerPid);
}

interface SessionRpcRuntime {
	onConnection(socket: Socket): void;
	destroyClients(): void;
	rpcInflight(): number;
	lastActivityAt(): number;
}

function createSessionRpcRuntime(args: {
	startedAt: number;
	state: SessionDaemonOptions["state"];
	shutdown: () => void;
}): SessionRpcRuntime {
	const clients = new Set<Socket>();
	let inflight = 0;
	let lastActivity = Date.now();
	const state: DispatcherState = {
		started_at: args.startedAt,
		rpc_inflight: 0,
		...args.state,
		shutdown: args.shutdown,
	};
	const handleFrame = async (frame: string, socket: Socket): Promise<void> => {
		let message: RpcMessage;
		try {
			message = decodeFrame(frame);
		} catch (err) {
			socket.write(encodeFrame(makeError("unknown", "bad_request", (err as Error).message)));
			return;
		}
		if (!isRequest(message)) return;
		inflight++;
		state.rpc_inflight = inflight;
		let response: RpcMessage;
		try {
			response = await dispatchRpc(message, state);
		} catch (err) {
			response = makeError(message.id, "internal", (err as Error).message);
		}
		inflight--;
		state.rpc_inflight = inflight;
		socket.write(encodeFrame(response));
	};
	return {
		onConnection(socket) {
			clients.add(socket);
			lastActivity = Date.now();
			let pending = "";
			socket.on("data", async (chunk: Buffer) => {
				const split = splitFrames(chunk.toString("utf-8"), pending);
				pending = split.remainder;
				for (const frame of split.frames) {
					lastActivity = Date.now();
					await handleFrame(frame, socket);
				}
			});
			socket.on("error", () => socket.destroy());
			socket.on("close", () => clients.delete(socket));
		},
		destroyClients() {
			for (const client of clients) client.destroy();
			clients.clear();
		},
		rpcInflight: () => inflight,
		lastActivityAt: () => lastActivity,
	};
}

export async function startSessionDaemon(opts: SessionDaemonOptions): Promise<SessionDaemonHandle> {
	const { paths, session_id } = opts;
	const idleMs = opts.idle_shutdown_ms ?? 15 * 60 * 1000;
	const started_at = Date.now();
	let stopped = false;

	// Ensure the .interlinked/ directory and logs/ directory exist.
	const interlinkedDir = dirname(paths.socket);
	if (!existsSync(interlinkedDir)) mkdirSync(interlinkedDir, { recursive: true });
	const logsDir = dirname(paths.log);
	if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

	await claimSessionOwnership({ paths, sessionId: session_id, cwd: dirname(interlinkedDir) });

	let server: Server | null = null;
	const runtime = createSessionRpcRuntime({
		startedAt: started_at,
		state: opts.state,
		shutdown: () => void handle.stop(),
	});

	try {
		server = await bindSessionSocket({ socketPath: paths.socket, onConnection: runtime.onConnection });
	} catch (err) {
		// The pid claim succeeded but the bind didn't — release it so a retry
		// (or a genuinely concurrent starter) isn't blocked by a ghost claim.
		removePidFileIfOwned(paths.pid, process.pid);
		throw err;
	}

	// Idle-shutdown poller — lightweight; fires only after true inactivity.
	const idleTimer =
		idleMs > 0
			? setInterval(
					() => {
						if (runtime.rpcInflight() > 0) return;
						if (Date.now() - runtime.lastActivityAt() < idleMs) return;
						void handle.stop("idle_shutdown");
					},
					Math.min(idleMs, 60_000),
				)
			: null;
	idleTimer?.unref();

	const handle: SessionDaemonHandle = {
		paths,
		session_id,
		started_at,
		rpcInflight: runtime.rpcInflight,
		async stop(_reason?: string) {
			if (stopped) return;
			stopped = true;
			if (idleTimer) clearInterval(idleTimer);
			runtime.destroyClients();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			removeOwnedSessionArtifacts(paths, process.pid);
		},
	};

	return handle;
}

function readPidFile(path: string): number | null {
	if (!existsSync(path)) return null;
	try {
		const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}
