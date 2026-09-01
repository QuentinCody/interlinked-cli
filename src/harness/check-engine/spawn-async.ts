// ===========================================
// runProcessAsync — non-blocking subprocess spawn
// ===========================================
// Phase A.1 of the Free CLI Phase-2 roadmap. Lets the check engine spawn
// 6+ language runners truly concurrently. Replaces the synchronous
// `child_process.spawnSync` calls in tool-runners that block the event
// loop and force the existing `runChecksAsync` to be sequential despite
// its `Promise.all` orchestration.
//
// Returns a Promise resolving once the subprocess exits, or once a killed
// subprocess and every descendant in its detached process group are gone.
// Honors:
//   • timeout — SIGTERM after `timeout` ms; SIGKILL after a 1 s grace period
//     if any member of the detached process group is still alive. Settlement
//     waits for the wrapper and descendants to disappear before a caller can
//     release its admission lease. Sets `timedOut: true` in the result.
//   • signal — external AbortSignal; same SIGTERM-then-SIGKILL pattern.
//   • spawn errors — ENOENT / EACCES / etc. surface as `code: null` rather
//     than throwing, so runners can decide whether the missing tool is fatal.
//
// stdout and stderr are captured independently into UTF-8 strings, capped
// at MAX_BUFFER_BYTES to defend against runaway output. Capping silently
// truncates rather than rejecting — large output is usually a noisy linter,
// not a security issue.

import { type ChildProcess, spawn } from "node:child_process";

/** Hard cap on per-stream capture. 10 MB is enough for any real linter
 *  output; runners that legitimately produce more should stream-process
 *  rather than buffer. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 1000;
/** Poll interval while a timed-out/aborted process group is being reaped. */
const PROCESS_GROUP_REAP_POLL_MS = 10;
/** Delay before closing inherited pipes after the child itself exits. */
const PIPE_CLOSE_GUARD_MS = 250;

export interface RunProcessOptions {
	/** Timeout in ms; the process is SIGTERM'd at this deadline. Default 30 s. */
	timeout?: number;
	/** Optional AbortController signal; the process is killed when it fires. */
	signal?: AbortSignal;
	/** Working directory for the spawned process. */
	cwd?: string;
	/** Additional environment variables (merged on top of `process.env`). */
	env?: NodeJS.ProcessEnv;
}

export interface RunProcessResult {
	stdout: string;
	stderr: string;
	/** Process exit code. `null` when the process never started (ENOENT etc.)
	 *  or was killed before it could exit. */
	code: number | null;
	/** True iff the process exceeded its `timeout`. */
	timedOut: boolean;
	/** True iff we sent SIGTERM/SIGKILL ourselves. */
	killed: boolean;
}

type RunProcessResolver = (result: RunProcessResult) => void;

interface SpawnedProcessRunInput {
	child: ChildProcess;
	opts: RunProcessOptions;
	timeoutMs: number;
	resolve: RunProcessResolver;
}

/** Owns one spawned process from listener registration through final
 * settlement. Keeping the mutable lifecycle in one object makes each timer
 * and event transition independently reviewable without changing their order. */
class SpawnedProcessRun {
	private readonly child: ChildProcess;
	private readonly opts: RunProcessOptions;
	private readonly timeoutMs: number;
	private readonly resolve: RunProcessResolver;
	private stdout = "";
	private stderr = "";
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private timedOut = false;
	private killed = false;
	private settled = false;
	private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
	private killGraceTimer: ReturnType<typeof setTimeout> | null = null;
	private reapPollTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingExitCode: number | null = null;
	private readonly processGroupId: number | undefined;
	private readonly onAbort = (): void => this.killTree();

	constructor(input: SpawnedProcessRunInput) {
		this.child = input.child;
		this.opts = input.opts;
		this.timeoutMs = input.timeoutMs;
		this.resolve = input.resolve;
		this.processGroupId = process.platform === "win32" ? undefined : input.child.pid;
	}

	start(): void {
		this.timeoutTimer = setTimeout(() => {
			this.timedOut = true;
			this.killTree();
		}, this.timeoutMs);
		this.registerAbort();
		this.child.stdout?.on("data", (chunk: Buffer) => this.captureStdout(chunk));
		this.child.stderr?.on("data", (chunk: Buffer) => this.captureStderr(chunk));
		this.child.on("exit", (code) => this.handleExit(code));
		this.child.on("error", () => this.handleError());
		this.child.on("close", (code) => this.handleClose(code));
	}

	private registerAbort(): void {
		const signal = this.opts.signal;
		if (!signal) return;
		if (signal.aborted) this.killTree();
		else signal.addEventListener("abort", this.onAbort, { once: true });
	}

	private captureStdout(chunk: Buffer): void {
		if (this.stdoutBytes >= MAX_BUFFER_BYTES) return;
		this.stdoutBytes += chunk.length;
		this.stdout += chunk.toString("utf-8");
	}

	private captureStderr(chunk: Buffer): void {
		if (this.stderrBytes >= MAX_BUFFER_BYTES) return;
		this.stderrBytes += chunk.length;
		this.stderr += chunk.toString("utf-8");
	}

	private finalize(code: number | null): void {
		if (this.settled) return;
		this.settled = true;
		this.clearLifecycleTimers();
		this.opts.signal?.removeEventListener("abort", this.onAbort);
		this.resolve({
			stdout: this.stdout,
			stderr: this.stderr,
			code,
			timedOut: this.timedOut,
			killed: this.killed,
		});
	}

	private clearLifecycleTimers(): void {
		if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
		if (this.killGraceTimer !== null) {
			clearTimeout(this.killGraceTimer);
			this.killGraceTimer = null;
		}
		if (this.reapPollTimer !== null) {
			clearTimeout(this.reapPollTimer);
			this.reapPollTimer = null;
		}
	}

	/** Signal the detached process group, falling back to its direct child when
	 * the group is absent or unsupported. */
	private signalTree(signal: NodeJS.Signals): void {
		try {
			if (this.processGroupId !== undefined) process.kill(-this.processGroupId, signal);
			else this.child.kill(signal);
		} catch {
			try {
				this.child.kill(signal);
			} catch {
				/* intentional: the process may already be reaped */
			}
		}
	}

	private processGroupIsAlive(): boolean {
		if (this.processGroupId === undefined) return false;
		try {
			process.kill(-this.processGroupId, 0);
			return true;
		} catch (error) {
			// SAFETY: Node reports process-signal failures as ErrnoException;
			// EPERM means the group exists but cannot be inspected by this user.
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	private settleAfterKilledTreeExits(): void {
		if (this.settled || !this.killed || this.processGroupId === undefined) return;
		if (!this.processGroupIsAlive()) {
			// A wrapper can exit while a TERM-resistant compiler grandchild still
			// owns the group. Group absence is what makes lease release safe.
			this.finalize(this.pendingExitCode);
			return;
		}
		if (this.reapPollTimer !== null) return;
		this.reapPollTimer = setTimeout(() => {
			this.reapPollTimer = null;
			this.settleAfterKilledTreeExits();
		}, PROCESS_GROUP_REAP_POLL_MS);
	}

	private killTree(): void {
		if (this.killed) return;
		this.killed = true;
		this.signalTree("SIGTERM");
		this.killGraceTimer = setTimeout(() => {
			if (!this.settled) this.signalTree("SIGKILL");
		}, SIGKILL_GRACE_MS);
		if (this.processGroupId !== undefined) this.settleAfterKilledTreeExits();
	}

	private handleExit(code: number | null): void {
		this.pendingExitCode = code;
		if (this.killed && this.processGroupId !== undefined) {
			this.settleAfterKilledTreeExits();
			return;
		}
		if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
		this.opts.signal?.removeEventListener("abort", this.onAbort);
		this.scheduleCloseGuard(code);
	}

	private scheduleCloseGuard(code: number | null): void {
		// A re-parented grandchild can retain stdout/stderr indefinitely after
		// child exit. Bound that wait (and provide the Windows fallback, where a
		// POSIX process group cannot be observed) without holding the event loop.
		// Declared as "unref is optional" (not the ambient NodeJS.Timeout type,
		// which always has it): a polyfilled/non-Node timer implementation may
		// hand back a handle without one, and this stays a no-op rather than a
		// throw in that case (mutation-kill-pinned in spawn-async test suite).
		const closeGuard: { unref?(): void } = setTimeout(() => {
			if (this.settled) return;
			this.child.stdout?.destroy();
			this.child.stderr?.destroy();
			this.finalize(code);
		}, PIPE_CLOSE_GUARD_MS);
		closeGuard.unref?.();
	}

	private handleError(): void {
		if (this.killed && this.processGroupId !== undefined) this.settleAfterKilledTreeExits();
		else this.finalize(null);
	}

	private handleClose(code: number | null): void {
		this.pendingExitCode = code;
		if (this.killed && this.processGroupId !== undefined) this.settleAfterKilledTreeExits();
		else this.finalize(code);
	}
}

interface ProcessStartInput {
	cmd: string;
	args: string[];
	opts: RunProcessOptions;
	timeoutMs: number;
}

function startProcessRun(resolve: RunProcessResolver, input: ProcessStartInput): void {
	const { cmd, args, opts, timeoutMs } = input;
	const env = opts.env ? { ...process.env, ...opts.env } : process.env;
	// Detached children lead their own process group so timeout/abort can stop
	// wrapper-spawned descendants without signalling the daemon's group.
	const child = spawn(cmd, args, { cwd: opts.cwd, env, detached: true });
	new SpawnedProcessRun({ child, opts, timeoutMs, resolve }).start();
}

/**
 * Spawn a process and return when it exits (or is killed). Never throws on
 * subprocess-level errors — failures surface in the returned `code`/`killed`
 * fields so the caller can compose error handling.
 */
export function runProcessAsync(
	cmd: string,
	args: string[],
	opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
	const timeoutMs = opts.timeout ?? 30_000;
	return new Promise((resolve) => startProcessRun(resolve, { cmd, args, opts, timeoutMs }));
}
