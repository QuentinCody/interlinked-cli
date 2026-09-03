// ===========================================
// Session daemon — socket bind + socket-state probing
// ===========================================
// Extracted from `session-daemon.ts` (per-file line cap). Pure relocation: the
// bounded bind-retry loop, its stale-socket ownership rule, and the two-probe
// socket-state read the daemon uses before it decides an incumbent is real.

import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { classifyDaemonSocket } from "./session-paths.js";
import type { HarnessSocketState } from "./socket-readiness.js";

/** Bind attempts before a listen failure is fatal. A cold start on a loaded
 *  machine races a still-exiting predecessor's socket teardown; retrying twice
 *  costs a couple of hundred milliseconds and converts the most common
 *  transient EADDRINUSE into a normal start instead of a dead daemon. */
export const BIND_ATTEMPTS = 3;
/** Backoff before attempt n+1, in ms. Indexed by the attempt that just failed;
 *  the last entry repeats if `attempts` is raised. */
export const BIND_BACKOFF_MS = [50, 150];

function closeQuietly(server: Server): void {
	try {
		server.close();
	} catch (err) {
		void err; /* intentional: a server that never listened throws here */
	}
}

function listenOnce(server: Server, socketPath: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

/** Decide whether another bind attempt can plausibly succeed, clearing a stale
 *  socket file when that is what stands in the way.
 *
 *  The ownership rule is the same one every anti-stomp check applies: a socket
 *  that ANSWERS belongs to a live incumbent and is never unlinked — that
 *  failure is terminal, and the caller must exit rather than stomp it. A
 *  socket file that answers nothing is a stale artifact from a dead
 *  predecessor: remove it and retry. A non-EADDRINUSE failure is some other
 *  transient (a directory being recreated, a slow unlink), so we simply retry
 *  it without touching anything. */
async function prepareBindRetry(
	err: unknown,
	socketPath: string,
	isServing: (socketPath: string) => Promise<boolean>,
): Promise<boolean> {
	if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") return true;
	if (await isServing(socketPath)) return false;
	rmSync(socketPath, { force: true });
	return true;
}

export async function sessionSocketState(socketPath: string): Promise<HarnessSocketState> {
	const first = await classifyDaemonSocket(socketPath);
	if (first !== "occupied_unready") return first;
	return classifyDaemonSocket(socketPath);
}

async function sessionSocketIsOccupied(socketPath: string): Promise<boolean> {
	return (await sessionSocketState(socketPath)) !== "absent";
}

export interface BindSessionSocketOptions {
	socketPath: string;
	onConnection: (socket: Socket) => void;
	/** Total attempts, including the first. Defaults to {@link BIND_ATTEMPTS}. */
	attempts?: number;
	/** Test seams. */
	sleep?: (ms: number) => Promise<void>;
	isServing?: (socketPath: string) => Promise<boolean>;
}

/**
 * Bind the session socket, retrying a bounded number of times.
 *
 * Every attempt uses a FRESH server object: a `net.Server` whose listen failed
 * carries the failure in its internal handle state, and reusing it makes the
 * retry's outcome depend on Node internals rather than on the socket path.
 *
 * Throws the LAST failure when every attempt is spent — the caller (and, above
 * it, the startup guard) turns that into a loud exit. It never returns a
 * server that is not listening.
 */
export async function bindSessionSocket(opts: BindSessionSocketOptions): Promise<Server> {
	const attempts = opts.attempts ?? BIND_ATTEMPTS;
	const isServing = opts.isServing ?? sessionSocketIsOccupied;
	const sleep =
		opts.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			}));
	let lastErr: unknown = new Error(`bind aborted before any attempt (${opts.socketPath})`);
	for (let attempt = 0; attempt < attempts; attempt++) {
		const server = createServer(opts.onConnection);
		try {
			await listenOnce(server, opts.socketPath);
			return server;
		} catch (err) {
			lastErr = err;
			closeQuietly(server);
			if (attempt === attempts - 1) break;
			if (!(await prepareBindRetry(err, opts.socketPath, isServing))) break;
			await sleep(BIND_BACKOFF_MS[attempt] ?? BIND_BACKOFF_MS[BIND_BACKOFF_MS.length - 1] ?? 150);
		}
	}
	throw lastErr;
}
