// ===========================================
// Harness server socket + process lifecycle
// ===========================================
// Extracted from server.ts. Owns the daemon's Unix-socket binding, legacy pid
// file, the raw-socket connection server, and the graceful/forced shutdown
// path. These functions close over a cluster of daemon-scoped mutable state —
// the live socket server, the framed-daemon handle, the open-client set, the
// shutting-down flag, the connection counter — which is why the cluster lives
// behind one `createSocketLifecycle` factory rather than as loose module
// `let`s. server.ts keeps the top-level startup statements (same order, same
// side effects) and calls into this factory.
//
// Two pieces of state are bound AFTER the factory is built, so they arrive via
// setters: the framed-daemon handle (created by `startSessionDaemon`) and the
// rules/settings file-watcher disposers (created mid-startup). The real
// `shutdown()` is only wired to process signals after those setters have run,
// so the disposers are always present by the time `shutdownAsync` calls them.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import type { AsyncAnalysisManager } from "./async-analysis.js";
import type { ContentScanner } from "./content-scanner/types.js";
import { pidFileNames, removePidFileIfOwned } from "./daemon-pid-ownership.js";
import type { ReservationManager } from "./reservations.js";
import { LineFramer } from "./server/socket-framing.js";
import {
	cleanupSocket as cleanupSocketAt,
	ensureDirectory,
} from "./server/socket-lifecycle.js";
import type { ServerBridge } from "./server-bridge.js";
import type { SessionDaemonHandle } from "./session-daemon.js";
import type { HarnessDecision } from "./types.js";

/** Dependencies the socket/lifecycle cluster closes over. Everything here is
 *  available at factory-construction time in server.ts; the late-bound
 *  framed-daemon handle and watcher disposers arrive through setters. */
export interface SocketLifecycleDeps {
	readonly socketPath: string;
	readonly pidPath: string;
	readonly runRawSocket: boolean;
	readonly asyncAnalysisDrainTimeoutMs: number;
	readonly serverBridge: ServerBridge | null;
	readonly reservations: ReservationManager;
	readonly contentScanner: ContentScanner | undefined;
	readonly asyncAnalysis: AsyncAnalysisManager;
	readonly evaluateEventLine: (
		line: string,
		protocol: "raw" | "framed",
	) => Promise<HarnessDecision>;
	readonly log: (msg: string) => void;
	readonly logAlways: (msg: string) => void;
}

/** How the raw listener reports its BIND OUTCOME — bound, or failed to bind.
 *  Kept structural (rather than importing `StartupGuard` from
 *  ./server/startup-guard.js) so this module stays decoupled from the startup
 *  policy that consumes it; the guard satisfies this shape as-is.
 *
 *  `note` fires on Node's 'listening' event, NOT when `listen()` returns —
 *  `listen()` resolves before the bind does, so "startup ran to the end" is
 *  not evidence that anything is answering. That distinction is the whole
 *  point: it is what lets the daemon tell a pre-listen failure (fatal) from a
 *  post-listen one (survivable). */
interface RawListenReporter {
	note: (which: "raw" | "framed") => void;
	fail: (what: string, err: unknown) => void;
}

/** Public surface server.ts drives. `shutdown` is bound to process signals and
 *  called from the idle timer; `cleanupSocket` / `writePidFile` run during
 *  startup; `startRawServer` binds the raw listener; the two setters supply the
 *  state that is created after the factory. */
export interface SocketLifecycle {
	cleanupSocket: (path?: string) => void;
	writePidFile: () => void;
	shutdown: () => void;
	startRawServer: (reporter?: RawListenReporter) => void;
	setFramedDaemon: (handle: SessionDaemonHandle | null) => void;
	setUnwatchers: (unwatchRules: () => void, unwatchSettings: () => void) => void;
}

function removeOwnedRawArtifacts(args: {
	pidPath: string;
	socketPath: string;
	removeSocket: boolean;
}): void {
	if (!pidFileNames(args.pidPath, process.pid)) return;
	if (args.removeSocket) cleanupSocketAt(args.socketPath);
	removePidFileIfOwned(args.pidPath, process.pid);
}

/** Build the socket + process-lifecycle cluster. The function bodies are moved
 *  verbatim from the monolithic server.ts; only the previously-module-level
 *  `let`s become closure state and the late-bound pieces become setters. */
export function createSocketLifecycle(deps: SocketLifecycleDeps): SocketLifecycle {
	const {
		socketPath: SOCKET_PATH,
		pidPath: PID_PATH,
		runRawSocket: RUN_RAW_SOCKET,
		asyncAnalysisDrainTimeoutMs: ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS,
		serverBridge,
		reservations,
		contentScanner,
		asyncAnalysis,
		evaluateEventLine,
		log,
		logAlways,
	} = deps;

	let socketServer: ReturnType<typeof createServer> | null = null;
	let framedDaemon: SessionDaemonHandle | null = null;
	let shuttingDown = false;
	let connectionCount = 0;
	let unwatchRules: () => void = () => {};
	let unwatchSettings: () => void = () => {};

	/** Tracks every open raw-socket client so shutdown can destroy them. Without
	 *  this, `socketServer.close(callback)` waits for clients to disconnect on
	 *  their own — which never happens for a hung .mjs hook — and SIGTERM appears
	 *  to be ignored. The set is mutated by createRawSocketServer's connect/close
	 *  handlers and emptied during shutdownAsync. */
	const openRawClients: Set<Socket> = new Set();

	/** Hard ceiling on graceful shutdown. If `shutdownAsync` doesn't reach
	 *  `process.exit(0)` within this window, force-exit so a stuck connection or
	 *  drain promise can't hold the daemon hostage and block restarts. */
	const SHUTDOWN_GRACE_MS = 3000;
	/** Per-step timeout for individual shutdown phases (framedDaemon.stop, etc.).
	 *  Each phase races against this window; the SHUTDOWN_GRACE_MS umbrella
	 *  catches anything that escapes both. */
	const SHUTDOWN_STEP_TIMEOUT_MS = 500;
	/** Cadence of the raw-pid-file ownership re-assert (writePidFile doc). */
	const PID_HEAL_INTERVAL_MS = 60_000;
	let pidHealTimer: NodeJS.Timeout | null = null;

	function cleanupSocket(path: string = SOCKET_PATH): void {
		cleanupSocketAt(path);
	}

	function writePidFile(): void {
		// Owns ONLY the legacy `harness.pid`. The framed `harness-<session>.pid`
		// is written exclusively by `startSessionDaemon()` (session-daemon.ts:136)
		// AFTER its ownership check — writing it here too clobbers a sibling
		// daemon's PID file before the session-daemon code can detect the
		// existing owner, causing it to remove the live socket and rebind.
		ensureDirectory(PID_PATH);
		writeFileSync(PID_PATH, String(process.pid));
		// Self-heal: a dual-protocol newcomer overwrites this file before losing
		// the framed anti-stomp race; its exit-path sweep (anti-stomp.ts
		// removeOwnPidLitter) normally cleans that litter, but a writer killed
		// mid-exit leaves a corpse pid behind and every reader (statusline
		// glyph, cold gate) then diagnoses a dead daemon next to a healthy one
		// (the perpetual-"restarting" of 2026-08-16). The serving daemon
		// re-asserts ownership each tick so the file converges within a minute.
		// unref() so the timer never holds the process open at shutdown.
		if (pidHealTimer === null) {
			pidHealTimer = setInterval(() => {
				try {
					const onDisk = readFileSync(PID_PATH, "utf-8").trim();
					if (Number.parseInt(onDisk, 10) === process.pid) return;
				} catch (err) {
					void err; // missing/unreadable — rewrite ours below
				}
				try {
					ensureDirectory(PID_PATH);
					writeFileSync(PID_PATH, String(process.pid));
				} catch (err) {
					void err; // read-only dir — nothing to heal with
				}
			}, PID_HEAL_INTERVAL_MS);
			pidHealTimer.unref();
		}
	}

	function shutdown(): void {
		if (shuttingDown) return;
		shuttingDown = true;
		if (pidHealTimer) {
			clearInterval(pidHealTimer);
			pidHealTimer = null;
		}
		// Always-armed force-exit. Any path that hangs for more than 3 s — a
		// pinned client connection, an async drain that never resolves, a third-
		// party shutdown handler that throws — will fall through to this rather
		// than leaving the daemon SIGTERM-deaf and forcing the user to SIGKILL.
		const forceExit = setTimeout(() => {
			try {
				logAlways(`Graceful shutdown stalled after ${SHUTDOWN_GRACE_MS}ms — forcing exit`);
			} catch (logErr) {
				void logErr; /* intentional: logger may already be torn down */
			}
			try {
				removeOwnedRawArtifacts({
					pidPath: PID_PATH,
					socketPath: SOCKET_PATH,
					removeSocket: RUN_RAW_SOCKET,
				});
			} catch (cleanupErr) {
				void cleanupErr; /* intentional: best-effort cleanup during forced exit */
			}
			process.exit(1);
		}, SHUTDOWN_GRACE_MS);
		forceExit.unref();
		void shutdownAsync().finally(() => clearTimeout(forceExit));
	}

	async function shutdownAsync(): Promise<void> {
		logAlways("Shutting down...");
		serverBridge?.shutdown();
		reservations.shutdown();
		// Fire-and-forget: the Python sidecar will be SIGKILLed by the SidecarManager
		// after its own 1 s grace window; we don't block the exit on it here.
		contentScanner?.shutdown().catch(() => {
			// best-effort
		});
		// Drain in-flight async analysis before exit (bounded by its own deadline).
		await asyncAnalysis.drain(ASYNC_ANALYSIS_DRAIN_TIMEOUT_MS);
		// Destroy open raw-socket clients BEFORE server.close(). Node's
		// `server.close()` only stops accepting new connections; it waits forever
		// for active ones to drain on their own. A hung .mjs hook (mid-RPC, parent
		// exited) will pin the close indefinitely without this loop.
		for (const sock of openRawClients) {
			try {
				sock.destroy();
			} catch (destroyErr) {
				void destroyErr; /* intentional: socket already torn down */
			}
		}
		openRawClients.clear();
		// Stop the framed daemon, but bound it: an in-flight RPC on a stuck
		// client would otherwise hang stop() forever. 500 ms is generous —
		// stop() destroys its own clients first, so close() should resolve
		// in microseconds. The race + timeout is insurance, not the path.
		if (framedDaemon) {
			await Promise.race([
				framedDaemon.stop("server_shutdown"),
				new Promise<void>((resolve) => {
					const t = setTimeout(resolve, SHUTDOWN_STEP_TIMEOUT_MS);
					t.unref();
				}),
			]);
		}
		// Tell the raw server to stop accepting new connections, but DO NOT
		// await server.close(callback). The callback only fires after every
		// active connection drains on its own — and a malformed client (rare
		// but real, observed in the wild) can keep that pending forever. We
		// already destroyed openRawClients above; the OS will reclaim the
		// listening socket on process exit regardless.
		try {
			socketServer?.close();
		} catch (closeErr) {
			void closeErr; /* intentional: close() can throw if the server is already closed */
		}
		removeOwnedRawArtifacts({
			pidPath: PID_PATH,
			socketPath: SOCKET_PATH,
			removeSocket: RUN_RAW_SOCKET,
		});
		unwatchRules();
		unwatchSettings();
		process.exit(0);
	}

	function createRawSocketServer(): ReturnType<typeof createServer> {
		return createServer((sock: Socket) => {
			connectionCount++;
			openRawClients.add(sock);
			log(`Connection opened (total: ${connectionCount})`);

			// Newline-delimited JSON framing (may receive multiple events in one
			// chunk, or an event split across chunks). The framer owns the
			// buffer; each complete line is evaluated sequentially in arrival
			// order and answered with its own write — same as the prior inline loop.
			const framer = new LineFramer();

			sock.on("data", async (data: Buffer) => {
				for (const line of framer.push(data.toString("utf-8"))) {
					const decision = await evaluateEventLine(line, "raw");
					try {
						sock.write(`${JSON.stringify(decision)}\n`);
					} catch (e) {
						void e;
					}
				}
			});

			sock.on("close", () => {
				connectionCount--;
				openRawClients.delete(sock);
				log(`Connection closed (remaining: ${connectionCount})`);
			});

			sock.on("error", (err: Error) => {
				log(`Socket error: ${err.message}`);
			});
		});
	}

	/** Bind the raw listener and stash the server instance so shutdown can close
	 *  it. Mirrors the prior inline `const rawServer = createRawSocketServer();
	 *  socketServer = rawServer; rawServer.listen(SOCKET_PATH);` startup block. */
	function startRawServer(reporter?: RawListenReporter): void {
		const rawServer = createRawSocketServer();
		socketServer = rawServer;
		// A bind failure (EADDRINUSE against a still-live listener, a
		// permission error, ...) emits 'error' with zero listeners by
		// default, which Node re-throws as an uncaught exception — and
		// `installCrashResilience()` deliberately SURVIVES uncaught
		// exceptions for continuity (crash-resilience.ts). Combined, a raw
		// listen failure used to leave the process alive with NO raw
		// listener: `writePidFile()` already ran earlier in startup, so the
		// pid file names this PID as a healthy incumbent to every future
		// anti-stomp check, while the raw socket never answers — precisely
		// the zombie class `isDaemonSocketServing` (session-paths.ts) exists
		// to detect from the OUTSIDE. Handling `error` here closes the hole
		// at the SOURCE: a listen failure is fatal, not survivable. A daemon
		// with no listener has no reason to keep running; exiting lets the
		// normal auto-revive path spawn a real replacement instead of a
		// silent zombie.
		rawServer.on("error", (err: NodeJS.ErrnoException) => {
			// A reporter owns the whole terminal contract (loud log + the
			// `daemon-events.jsonl` row + a distinct exit code); the legacy
			// path below stays for any caller that passes none. Either way the
			// process leaves — a listen failure is never survivable.
			if (reporter) {
				reporter.fail("raw socket bind", err);
				return;
			}
			logAlways(
				`[interlinked] Raw socket listen failed (${err.code ?? err.message}) — exiting so auto-revive can spawn a working daemon.`,
			);
			process.exit(1);
		});
		if (reporter) rawServer.on("listening", () => reporter.note("raw"));
		rawServer.listen(SOCKET_PATH);
	}

	function setFramedDaemon(handle: SessionDaemonHandle | null): void {
		framedDaemon = handle;
	}

	function setUnwatchers(rules: () => void, settings: () => void): void {
		unwatchRules = rules;
		unwatchSettings = settings;
	}

	return {
		cleanupSocket,
		writePidFile,
		shutdown,
		startRawServer,
		setFramedDaemon,
		setUnwatchers,
	};
}
