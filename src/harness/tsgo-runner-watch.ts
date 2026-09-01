// interlinked-tdd: exempt
// -----------------------------------------------------------------------------
// WatchProcess — one persistent `tsgo --watch` child per project root
// -----------------------------------------------------------------------------
//
// Behavior-preserving split out of `tsgo-runner.ts`: the warm-process lifecycle
// state, the watch tunables, and the `WatchProcess` class moved here verbatim so
// the runner factory stays under the per-file line cap. This module depends only
// on `tsgo-diagnostics.js` (and node builtins) — it never imports back from
// `tsgo-runner.ts`, so there is no import cycle.

import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import type { TsgoDiagnostic } from "./daemon-protocol.js";
import { tryRegisterWarmProjectCompiler } from "./project-compiler-gate.js";
import {
	buildInfoPath,
	filterDiagnosticsForFile,
	nowMs,
	PASS_COMPLETE_RE,
	PASS_START_RE,
	parseDiagnosticLine,
	stripAnsi,
	stripWatchTimestamp,
} from "./tsgo-diagnostics.js";

/** Warm-process lifecycle state, surfaced via `stats()`. */
export type WatchProcessState =
	| "not-started" // lazy: no TS check has happened yet
	| "running" // a `tsgo --watch` child is alive
	| "idle-evicted" // killed after the idle window; respawns on next use
	| "crashed" // exited unexpectedly; respawns on next use
	| "disabled" // warm path turned off (option / tsgo unavailable)
	| "unavailable"; // tsgo binary not resolvable

/** WatchProcessState literals, named so conditionals read as intent. */
export const WATCH_RUNNING: WatchProcessState = "running";
export const WATCH_CRASHED: WatchProcessState = "crashed";
export const WATCH_IDLE_EVICTED: WatchProcessState = "idle-evicted";

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

/** Default idle window before the warm `tsgo --watch` child is evicted. */
export const DEFAULT_WATCH_IDLE_MS = 10 * 60 * 1000;
/**
 * Upper bound on how long checkFile() waits for the watch child to finish a
 * recompile of a file that is newer on disk than the last completed pass
 * (i.e. we beat tsgo's ~1s FS-watch debounce). On timeout we fall back to the
 * cold one-shot. 2s comfortably clears the observed ~1s debounce + compile.
 */
const WATCH_FRESH_WAIT_MS = 2000;
/** How often the fresh-wait loop re-checks for a completed pass. */
const WATCH_POLL_INTERVAL_MS = 15;
/** Time budget for the watch child's FIRST pass before we give up on it. */
const WATCH_INITIAL_PASS_MS = 8000;
/** Grace after SIGTERM before a stuck compiler process group is SIGKILLed. */
const WATCH_STOP_GRACE_MS = 500;
/** Poll interval while a terminated wrapper's process group is being reaped. */
const WATCH_GROUP_REAP_POLL_MS = 10;

function signalCompilerTree(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (child.pid !== undefined) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// The process was already reaped between the liveness check and signal.
			void 0;
		}
	}
}

function compilerGroupIsAlive(processGroupId: number | undefined): boolean {
	if (processGroupId === undefined) return false;
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		// SAFETY: Node reports signal failures as ErrnoException; EPERM proves
		// the group still exists even though this process cannot inspect it.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Resolve only when the child and its detached process group have exited. */
function terminateCompilerProcess(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolveExit) => {
		let settled = false;
		let childExited = child.exitCode !== null || child.signalCode !== null;
		let killTimer: ReturnType<typeof setTimeout> | null = null;
		let reapTimer: ReturnType<typeof setTimeout> | null = null;
		const processGroupId = process.platform === "win32" ? undefined : child.pid;
		const finishAfterGroupExit = (): void => {
			if (settled) return;
			if (!childExited) return;
			if (compilerGroupIsAlive(processGroupId)) {
				if (reapTimer === null) {
					reapTimer = setTimeout(() => {
						reapTimer = null;
						finishAfterGroupExit();
					}, WATCH_GROUP_REAP_POLL_MS);
				}
				return;
			}
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			if (reapTimer) clearTimeout(reapTimer);
			resolveExit();
		};
		const noteChildExit = (): void => {
			childExited = true;
			finishAfterGroupExit();
		};
		if (!childExited) {
			child.once("exit", noteChildExit);
			child.once("close", noteChildExit);
		}
		// An error is not proof the OS process exited (a failed signal can emit
		// one while the child is still alive). Escalate, but keep the compiler
		// lease until `exit`/`close` provides the actual reap acknowledgement.
		child.once("error", () => signalCompilerTree(child, "SIGKILL"));
		signalCompilerTree(child, "SIGTERM");
		killTimer = setTimeout(() => {
			if (!settled) signalCompilerTree(child, "SIGKILL");
		}, WATCH_STOP_GRACE_MS);
		killTimer.unref();
		if (childExited) finishAfterGroupExit();
	});
}

/**
 * Wraps a single `tsgo --watch --noEmit` child. Parses its streamed pass
 * output into a "latest completed pass" diagnostics buffer. Tracks crash and
 * idle state. Every method is failure-tolerant: a dead/crashed child simply
 * makes `isUsable()` false so the caller falls back to the cold path.
 */
export class WatchProcess {
	private child: ChildProcess | null = null;
	private _state: WatchProcessState = "not-started";
	/** stdout bytes not yet split into a complete line. */
	private lineBuffer = "";
	/** Diagnostics accumulated during the pass currently in progress. */
	private inFlightDiagnostics: TsgoDiagnostic[] = [];
	/** true between a `build starting` line and its `build finished` line. */
	private passInProgress = false;
	/** Diagnostics from the most recently *completed* pass. */
	private lastPassDiagnostics: TsgoDiagnostic[] = [];
	/** nowMs() of the last completed pass; 0 until the first pass lands. */
	private lastPassCompletedAt = 0;
	/** Resolvers waiting for the next completed pass. */
	private passWaiters: Array<() => void> = [];
	private idleTimer: NodeJS.Timeout | null = null;
	private unregisterCompiler: (() => void) | null = null;
	private stopPromise: Promise<void> | null = null;

	constructor(
		private readonly executable: string,
		private readonly projectRoot: string,
		private readonly idleMs: number,
	) {}

	/** Spawn the `tsgo --watch` child. Idempotent-safe; never throws. */
	start(): void {
		if (this.child) return;
		const unregister = tryRegisterWarmProjectCompiler(this.projectRoot, () => this.kill());
		if (!unregister) return;
		this.unregisterCompiler = unregister;
		try {
			// --pretty false → stable plain-text Form-1 diagnostics, no ANSI.
			// --incremental + --tsBuildInfoFile → the watch child persists its
			//   build graph so a respawn after idle-eviction warms faster.
			const args = [
				"--watch",
				"--noEmit",
				"--pretty",
				"false",
				"--incremental",
				"--tsBuildInfoFile",
				buildInfoPath(this.projectRoot, "watch"),
			];
			const child = spawn(this.executable, args, {
				cwd: this.projectRoot,
				stdio: ["ignore", "pipe", "pipe"],
				// Give the watcher its own process group. Eviction must terminate
				// wrapper-spawned descendants too, not merely the shell/launcher.
				detached: true,
			});
			this.child = child;
			this._state = WATCH_RUNNING;
			// Don't let the watch child keep the daemon's event loop alive.
			child.unref();
			child.stdout.on("data", (b: Buffer) => this.ingest(b.toString("utf-8")));
			// Parse stderr too: tsgo --watch keeps stderr empty today, but a
			// future tsgo that splits streams still gets its diagnostics read.
			child.stderr.on("data", (b: Buffer) => this.ingest(b.toString("utf-8")));
			child.on("error", () => {
				if (this.child === child) this.markCrashed();
			});
			child.on("exit", () => {
				// An exit while we still hold the child reference is unexpected
				// (we null `child` ourselves on a deliberate kill).
				if (this.child === child) this.markCrashed();
			});
			this.resetIdleTimer();
		} catch (_err) {
			// Spawn failed outright — behave as crashed so callers cold-fall-back.
			this.markCrashed();
		}
	}

	/** True when the child is alive and serving (running, not crashed/evicted). */
	isUsable(): boolean {
		return this._state === WATCH_RUNNING && this.child !== null;
	}

	state(): WatchProcessState {
		return this._state;
	}

	/** Reset the idle-eviction countdown — called on every use. */
	touchIdle(): void {
		if (this._state === WATCH_RUNNING) this.resetIdleTimer();
	}

	/**
	 * Return diagnostics for `path` from the warm graph. If the file on disk is
	 * newer than the last completed pass (we beat tsgo's ~1s FS-watch debounce)
	 * wait up to WATCH_FRESH_WAIT_MS for the next pass. Returns null on
	 * timeout / crash so the caller uses the cold one-shot.
	 */
	async diagnosticsForFile(path: string): Promise<TsgoDiagnostic[] | null> {
		if (!this.isUsable()) return null;
		this.touchIdle();

		// Wait for the first pass if the child just started.
		if (this.lastPassCompletedAt === 0) {
			const got = await this.waitForNextPass(WATCH_INITIAL_PASS_MS);
			if (!got) return null;
		}

		// If `path` changed on disk after our last pass, tsgo will recompile —
		// wait (bounded) for that pass so we don't return stale diagnostics.
		if (this.fileNewerThanLastPass(path)) {
			const got = await this.waitForNextPass(WATCH_FRESH_WAIT_MS);
			if (!got) return null; // tsgo's watcher hasn't caught up — cold fallback
			// One more recompile may still be pending if the file kept changing;
			// a single extra bounded wait covers the common double-edit case.
			if (this.fileNewerThanLastPass(path)) {
				await this.waitForNextPass(WATCH_FRESH_WAIT_MS);
			}
		}

		if (!this.isUsable()) return null;
		return filterDiagnosticsForFile(this.lastPassDiagnostics, path, this.projectRoot);
	}

	/**
	 * Stop and reap the child. The returned promise resolves only after the OS
	 * process exits; the compiler lease is deliberately held until then.
	 */
	kill(): Promise<void> {
		return this.stop(WATCH_IDLE_EVICTED);
	}

	private stop(nextState: WatchProcessState): Promise<void> {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (this.stopPromise) return this.stopPromise;
		const child = this.child;
		this.child = null;
		this._state = nextState;
		// Release any pending waiters so callers don't hang on a killed child.
		this.flushWaiters();
		if (!child) {
			this.releaseCompilerRegistration();
			return Promise.resolve();
		}
		this.stopPromise = terminateCompilerProcess(child).finally(() => {
			this.releaseCompilerRegistration();
			this.stopPromise = null;
		});
		return this.stopPromise;
	}

	// --- internals ----------------------------------------------------------

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.idleMs <= 0) return;
		this.idleTimer = setTimeout(() => {
			// Idle window elapsed with no TS check — evict the child. The next
			// checkFile() will lazily respawn a fresh WatchProcess.
			void this.stop(WATCH_IDLE_EVICTED);
		}, this.idleMs);
		this.idleTimer.unref();
	}

	private markCrashed(): void {
		this.child = null;
		this.stopPromise = null;
		this.releaseCompilerRegistration();
		// An idle eviction also nulls `child`; don't let a late exit event
		// downgrade a clean idle-evict into a "crashed" report.
		if (this._state !== WATCH_IDLE_EVICTED) this._state = WATCH_CRASHED;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.flushWaiters();
	}

	private releaseCompilerRegistration(): void {
		const unregister = this.unregisterCompiler;
		this.unregisterCompiler = null;
		unregister?.();
	}

	/** Feed streamed bytes through line splitting + pass-marker parsing. */
	private ingest(chunk: string): void {
		// tsgo's classic watch mode prefixes passes with a clear-screen escape
		// (`[2J[3J[H`) that can be glued to the next text in the
		// same chunk — strip all ANSI so line matching is escape-free.
		this.lineBuffer += stripAnsi(chunk);
		let nl = this.lineBuffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.lineBuffer.slice(0, nl);
			this.lineBuffer = this.lineBuffer.slice(nl + 1);
			this.handleLine(line);
			nl = this.lineBuffer.indexOf("\n");
		}
	}

	/**
	 * Pass-marker state machine. tsgo --watch has TWO output formats — the one
	 * you get depends on the runtime environment (empirically verified May
	 * 2026; both observed against @typescript/native-preview 7.0.0-dev):
	 *
	 *   "build" format:    `build starting at <t>` … `build finished in <n>s`
	 *   "classic" format:  `<t> - Starting compilation in watch mode...`
	 *                      (or `<t> - File change detected. Starting
	 *                       incremental compilation...`) …
	 *                      `<t> - Found <n> error(s). Watching for file changes.`
	 *
	 * Diagnostics are identical in both (`file(l,c): error TS...`, Form 1). A
	 * leading `HH:MM:SS AM/PM - ` timestamp is stripped before marker matching.
	 */
	private handleLine(line: string): void {
		const trimmed = stripWatchTimestamp(line.trim());
		if (PASS_START_RE.test(trimmed)) {
			this.passInProgress = true;
			this.inFlightDiagnostics = [];
			return;
		}
		if (PASS_COMPLETE_RE.test(trimmed)) {
			// Publish whatever this pass accumulated (possibly zero diagnostics).
			this.lastPassDiagnostics = this.inFlightDiagnostics;
			this.lastPassCompletedAt = nowMs();
			this.passInProgress = false;
			this.inFlightDiagnostics = [];
			this.flushWaiters();
			return;
		}
		const diag = parseDiagnosticLine(line, "");
		if (diag) {
			if (this.passInProgress) {
				this.inFlightDiagnostics.push(diag);
			} else {
				// Defensive: a diagnostic outside a pass (unexpected tsgo output
				// ordering) still gets recorded against the latest pass.
				this.lastPassDiagnostics = [...this.lastPassDiagnostics, diag];
			}
		}
	}

	/** Resolve every pending pass-waiter (pass landed, or child died). */
	private flushWaiters(): void {
		const waiters = this.passWaiters;
		this.passWaiters = [];
		for (const w of waiters) w();
	}

	/**
	 * Wait until the next pass completes (or the child dies, or the budget
	 * elapses). Returns true iff a completed pass is available and the child
	 * is still usable.
	 */
	private waitForNextPass(budgetMs: number): Promise<boolean> {
		const startPassAt = this.lastPassCompletedAt;
		return new Promise<boolean>((resolveWait) => {
			let settled = false;
			const finish = (ok: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearInterval(poll);
				resolveWait(ok);
			};
			const timer = setTimeout(() => finish(false), budgetMs);
			// Poll in addition to the waiter callback: covers the (rare) race
			// where a pass completes between our read of lastPassCompletedAt
			// and registering the waiter. The poll also keeps the idle timer
			// fresh — a check that is awaiting a pass IS activity, so the child
			// must not be idle-evicted out from under an in-flight check (which
			// matters most when the idle window is short).
			const poll = setInterval(() => {
				this.touchIdle();
				if (!this.isUsable() && this.lastPassCompletedAt === startPassAt) {
					finish(false);
				} else if (this.lastPassCompletedAt > startPassAt) {
					finish(true);
				}
			}, WATCH_POLL_INTERVAL_MS);
			poll.unref();
			this.passWaiters.push(() => {
				if (this.lastPassCompletedAt > startPassAt && this.isUsable()) {
					finish(true);
				} else if (!this.isUsable()) {
					finish(false);
				}
				// else: a flush from an unrelated cause — keep waiting until the
				// timer or a real pass resolves us.
			});
		});
	}

	/** True when `path`'s on-disk mtime is newer than our last completed pass. */
	private fileNewerThanLastPass(path: string): boolean {
		if (this.lastPassCompletedAt === 0) return true;
		try {
			return statSync(path).mtimeMs > this.lastPassCompletedAt;
		} catch (_err) {
			return false;
		}
	}
}
