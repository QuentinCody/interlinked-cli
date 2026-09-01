// ===========================================
// Sidecar Manager — Long-running Python subprocess
// ===========================================
//
// Spawns a Python process running the OPF sidecar script, keeps stdin/stdout
// open across many scan requests, and correlates responses by a numeric `id`
// field. Designed to survive idle periods (auto-shutdown, re-spawn on next
// call), crashes (bounded auto-restart), and clean shutdown via SIGTERM.
//
// Protocol (one JSON object per line, both directions):
//   request:  {"id": "<id>", "op": "ping" | "scan" | "shutdown", "text"?: string}
//   response: {"id": "<id>", "ok": boolean, "spans"?: [...], "redacted_text"?: string, "error"?: string}
//
// Fail-open posture: every error path returns `{ok: false, error}` instead of
// throwing. The content-scanner translates that into allow + a warning.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import type { JsonObject } from "../../lib/json-types.js";

// ===========================================
// Types
// ===========================================

interface SidecarSpan {
	label: string;
start: number;
	end: number;
	text: string;
	score?: number;
}

export interface SidecarResponse {
	ok: boolean;
	error?: string | undefined;
	spans?: SidecarSpan[] | undefined;
	redacted_text?: string | undefined;
}

export interface SidecarRequest {
	op: "ping" | "scan" | "shutdown";
	text?: string | undefined;
	/** Optional per-call AbortSignal — resolves with error on abort. */
	signal?: AbortSignal | undefined;
	/** Override the default timeout. When unset, uses scan_timeout_ms (or startup_timeout_ms on the first call). */
	timeout_ms?: number | undefined;
}

/** Subset of `child_process.spawn` shape needed by the manager — supports DI for tests. */
export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

/**
 * Lifecycle state surfaced for external observability (statusline, harness status).
 *   - idle      never spawned yet this session
 *   - spawning  child forked, awaiting first successful response
 *   - ready     child has served at least one response; restart budget reset
 *   - dormant   child was closed (idle timer OR transient crash) — will re-spawn on next send
 *   - disabled  permanent: explicit shutdown() OR spawn budget exhausted
 */
export type SidecarLifecycleState = "idle" | "spawning" | "ready" | "dormant" | "disabled";

export interface SidecarStatus {
	state: SidecarLifecycleState;
	pid?: number | undefined;
	/** Number of spawn attempts during the current crash/error sequence. Resets to 0 on success. */
	restartCount: number;
	/** One-line detail suitable for logs / statusline (never contains scanned text). */
	detail?: string | undefined;
	/** ISO timestamp of the last transition into `state`. */
	sinceIso: string;
}

export interface SidecarManagerOptions {
	python_bin: string;
	script_path: string;
	/** Extra CLI args appended to `[script_path]` when spawning. Used to pass
	 *  configuration that the sidecar needs at startup (e.g.,
	 *  `--viterbi-calibration-path /path/to/calibration.json`) without changing
	 *  the JSONL request protocol. Empty / omitted = no extra args. */
	script_args?: readonly string[] | undefined;
	startup_timeout_ms: number;
	scan_timeout_ms: number;
	idle_shutdown_ms: number;
	max_restarts: number;
	/** Test hook — defaults to `node:child_process.spawn`. */
	spawn?: SpawnFn | undefined;
	/** Test hook — defaults to writing to `process.stderr`. */
	stderrSink?: ((chunk: string) => void) | undefined;
	/** Fired on every status transition. Best-effort; callback errors are swallowed. */
	onStatusChange?: ((status: SidecarStatus) => void) | undefined;
}

type PendingEntry = {
	resolve: (r: SidecarResponse) => void;
	timer: ReturnType<typeof setTimeout>;
	detach: () => void;
};

/** Build a fail-open response envelope. All error paths in this module route
 *  through here so the "failed" shape lives in one place. */
function failResponse(error: string): SidecarResponse {
	return { ok: false, error };
}

/** Type predicate that narrows `unknown` to a plain object (but not `null`). */
function isRecord(x: unknown): x is JsonObject {
	return x !== null && typeof x === "object";
}

/** Type predicate for a non-empty string — used to extract the `id` field from parsed responses. */
function isStringId(x: unknown): x is string {
	return typeof x === "string" && x.length > 0;
}

// ===========================================
// Manager
// ===========================================

/**
 * Minimal long-running subprocess wrapper. Public API is `send()`,
 * `shutdown()`, `getStatus()`; everything else is lifecycle plumbing.
 * Spawns lazily on the first `send()` so the feature imposes zero cost
 * when disabled.
 *
 * Lifecycle: explicit `shutdown()` marks the manager `disposed` (permanent,
 * no re-spawn). Idle-timer close marks it `dormant` (transient — the next
 * `send()` re-spawns). This split is load-bearing: conflating them caused
 * a regression where the scanner died silently after 30 min idle and stayed
 * dead for the rest of the session.
 */
export class SidecarManager {
	private child: ChildProcess | null = null;
	private pending = new Map<string, PendingEntry>();
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private restartCount = 0;
	private nextId = 1;
	private lineBuffer = "";
	/** Flips true once the child has emitted its first response. Gates per-call timeouts. */
	private booted = false;
	/** Set by the public `shutdown()` only. Once true, this instance is permanently dead. */
	private disposed = false;
	/** Transient — set by idle-close or unexpected exit. Next `send()` will re-spawn. */
	private dormant = false;
	private status: SidecarStatus = {
		state: "idle",
		restartCount: 0,
		sinceIso: new Date().toISOString(),
	};

	constructor(private readonly opts: SidecarManagerOptions) {
		// Fire the initial state so callers (e.g., statusline writer) see "idle"
		// before the first scan request lands. Safe in the ctor — we own the field.
		this.fireStatus();
	}

	/** Read the current lifecycle status (for statusline / harness status command). */
	getStatus(): SidecarStatus {
		return this.status;
	}

	/**
	 * Send a request to the sidecar, returning the response or a fail-open
	 * `{ok:false, error}`. Never throws.
	 */
	async send(req: SidecarRequest): Promise<SidecarResponse> {
		if (this.disposed) {
			return failResponse("sidecar is shutting down");
		}

		try {
			this.ensureSpawned();
		} catch (e) {
			return failResponse(`sidecar spawn failed: ${formatErr(e)}`);
		}

		const id = String(this.nextId++);
		const timeoutMs =
			req.timeout_ms ?? (this.booted ? this.opts.scan_timeout_ms : this.opts.startup_timeout_ms);

		const payload: JsonObject = { id, op: req.op };
		if (req.text !== undefined) payload.text = req.text;

		return new Promise<SidecarResponse>((resolve) => {
			const timer = setTimeout(() => {
				const entry = this.pending.get(id);
				if (!entry) return;
				this.pending.delete(id);
				entry.detach();
				resolve(failResponse(`timeout after ${timeoutMs}ms`));
			}, timeoutMs);

			let onAbort: (() => void) | undefined;
			if (req.signal) {
				onAbort = () => {
					const entry = this.pending.get(id);
					if (!entry) return;
					this.pending.delete(id);
					entry.detach();
					resolve(failResponse("aborted"));
				};
				req.signal.addEventListener("abort", onAbort, { once: true });
			}

			const detach = () => {
				clearTimeout(timer);
				if (onAbort && req.signal) req.signal.removeEventListener("abort", onAbort);
			};

			this.pending.set(id, { resolve, timer, detach });

			try {
				this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
			} catch (e) {
				this.pending.delete(id);
				detach();
				resolve(failResponse(`write failed: ${formatErr(e)}`));
				return;
			}

			this.resetIdleTimer();
		});
	}

	/** Graceful shutdown — sends `{op:"shutdown"}`, then SIGKILL if the child doesn't exit. */
	async shutdown(): Promise<void> {
		this.disposed = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.setStatus({ state: "disabled", detail: "explicit shutdown", pid: undefined });
		if (!this.child) return;

		const child = this.child;
		try {
			child.stdin?.write(`${JSON.stringify({ id: "shutdown", op: "shutdown" })}\n`);
			child.stdin?.end();
		} catch {
			// best-effort — the child may already have exited
		}

		await new Promise<void>((resolve) => {
			const forceKillAfterMs = 1000;
			const killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// best-effort
				}
				resolve();
			}, forceKillAfterMs);
			child.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
		});

		this.rejectAllPending("sidecar shut down");
		this.child = null;
	}

	// ---- lifecycle internals -------------------------------------------------

	private ensureSpawned(): void {
		if (this.child && !this.child.killed) return;
		if (this.restartCount >= this.opts.max_restarts) {
			this.setStatus({
				state: "disabled",
				detail: `exceeded max_restarts (${this.opts.max_restarts})`,
				pid: undefined,
			});
			throw new Error(
				`sidecar exceeded max_restarts (${this.opts.max_restarts}); disabled for this session`,
			);
		}

		const wasDormant = this.dormant;
		this.dormant = false;

		const spawnFn: SpawnFn = this.opts.spawn ?? nodeSpawn;
		let child: ChildProcess;
		try {
			const args = [this.opts.script_path, ...(this.opts.script_args ?? [])];
			child = spawnFn(this.opts.python_bin, args, {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			this.restartCount++;
			this.setStatus({
				state: "disabled",
				detail: `spawn failed: ${formatErr(err)}`,
				pid: undefined,
				restartCount: this.restartCount,
			});
			throw err;
		}

		this.child = child;
		// Always charge the restart counter. The counter resets to 0 on the first
		// successful response (see deliverLine), so long-running sessions can
		// cycle idle→respawn→idle indefinitely: each healthy respawn clears the
		// budget. max_restarts only fires on N *consecutive* crashes with no
		// successful response in between.
		this.restartCount++;
		this.booted = false;
		this.lineBuffer = "";
		this.setStatus({
			state: "spawning",
			pid: child.pid,
			restartCount: this.restartCount,
			detail: wasDormant ? "re-spawning after dormant" : "starting",
		});

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));

		const stderrSink = this.opts.stderrSink ?? defaultStderrSink;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => stderrSink(chunk));

		child.on("error", (err: Error) => {
			this.rejectAllPending(`sidecar error: ${err.message}`);
			this.child = null;
			if (!this.disposed) {
				this.dormant = true;
				this.setStatus({
					state: "dormant",
					pid: undefined,
					detail: `child error: ${err.message}`,
				});
			}
		});
		child.on("exit", (code: number | null) => {
			this.rejectAllPending(`sidecar exited with code ${code ?? "null"}`);
			this.child = null;
			if (!this.disposed) {
				// Transient close (idle timer, crash, SIGTERM) — leave the instance
				// recoverable. Next send() will respawn unless restartCount is
				// exhausted, in which case ensureSpawned flips state to disabled.
				this.dormant = true;
				this.setStatus({
					state: "dormant",
					pid: undefined,
					detail: `child exited (code=${code ?? "null"})`,
				});
			}
		});

		this.resetIdleTimer();
	}

	private onStdout(chunk: string): void {
		this.lineBuffer += chunk;
		let newlineIdx = this.lineBuffer.indexOf("\n");
		while (newlineIdx !== -1) {
			const line = this.lineBuffer.slice(0, newlineIdx).trim();
			this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
			if (line) this.deliverLine(line);
			newlineIdx = this.lineBuffer.indexOf("\n");
		}
	}

	private deliverLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return; // malformed — drop silently, parallels fail-open posture
		}
		if (!isRecord(parsed)) return;
		const id = isStringId(parsed.id) ? parsed.id : undefined;
		if (!id) return; // startup noise with no id — drop
		const entry = this.pending.get(id);
		if (!entry) return;
		this.pending.delete(id);
		entry.detach();
		if (!this.booted) {
			this.booted = true;
			// First successful response = healthy — reset the crash counter so
			// later blips can still respawn. Bug: without this, a single cold-load
			// failure followed by 2 good restarts would leave the counter at 3
			// and permanently disable the next time anything hiccupped.
			this.restartCount = 0;
			this.setStatus({
				state: "ready",
				pid: this.child?.pid,
				restartCount: 0,
				detail: undefined,
			});
		}
		// Defensive projection — the sidecar is trusted but we validate shape
		// before exposing the response to callers.
		entry.resolve({
			ok: parsed.ok === true,
			error: typeof parsed.error === "string" ? parsed.error : undefined,
			spans: Array.isArray(parsed.spans) ? (parsed.spans as SidecarSpan[]) : undefined,
			redacted_text:
				typeof parsed.redacted_text === "string" ? parsed.redacted_text : undefined,
		});
	}

	private rejectAllPending(reason: string): void {
		if (this.pending.size === 0) return;
		for (const [, entry] of this.pending) {
			entry.detach();
			entry.resolve(failResponse(reason));
		}
		this.pending.clear();
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			// Idle close — NOT a full shutdown. Marks the instance dormant so the
			// next send() can respawn. Previously this called shutdown(), which
			// latched shuttingDown=true and silently bricked the scanner.
			this.closeChildForIdle().catch(() => {
				// best-effort
			});
		}, this.opts.idle_shutdown_ms);
		this.idleTimer.unref?.();
	}

	/**
	 * Close the running child to reclaim RAM (model takes ~800 MB), but leave
	 * the manager recoverable. The exit handler installed in `ensureSpawned`
	 * will flip state to "dormant"; next `send()` triggers a fresh spawn.
	 */
	private async closeChildForIdle(): Promise<void> {
		if (!this.child || this.disposed) return;
		const child = this.child;
		this.dormant = true;
		try {
			child.stdin?.write(`${JSON.stringify({ id: "idle-shutdown", op: "shutdown" })}\n`);
			child.stdin?.end();
		} catch {
			// best-effort — child may already be gone
		}
		// SIGKILL fallback so we don't leave orphaned processes. The exit
		// handler will emit the dormant status transition.
		const forceKillAfterMs = 1000;
		const killTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// best-effort
			}
		}, forceKillAfterMs);
		killTimer.unref?.();
	}

	// ---- status tracking ----------------------------------------------------

	private setStatus(patch: Partial<SidecarStatus>): void {
		const prevState = this.status.state;
		const nextState = patch.state ?? prevState;
		this.status = {
			...this.status,
			...patch,
			sinceIso: nextState !== prevState ? new Date().toISOString() : this.status.sinceIso,
		};
		this.fireStatus();
	}

	private fireStatus(): void {
		const cb = this.opts.onStatusChange;
		if (!cb) return;
		try {
			cb(this.status);
		} catch {
			// best-effort — never let a statusline error take down the sidecar
		}
	}
}

// ===========================================
// Helpers
// ===========================================

function formatErr(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

function defaultStderrSink(chunk: string): void {
	process.stderr.write(`[opf-sidecar] ${chunk}`);
}
