// ===========================================
// Sidecar Pool — N-instance wrapper for the OPF sidecar
// ===========================================
//
// The Python OPF sidecar is single-threaded: every `scan` op blocks the
// child's event loop until the HF pipeline returns. With one instance
// handling events from multiple concurrent Claude sessions, scans queue
// up, the 1.5 s AbortSignal timeout in server.ts fires, and the scanner
// silently fail-opens — exactly the "statusline says ✓ but nothing is
// actually being scanned" bug we hit in practice.
//
// SidecarPool wraps N `SidecarManager` children and round-robins requests
// across them. Children spawn lazily, so pool_size is a MAX not a MIN — an
// idle workstation pays zero RAM; a busy one scales up to N.
//
// Aggregate status is surfaced so the statusline writer and the harness-
// status command see the pool as a single logical scanner: "ready" if
// any child is ready, "disabled" only when every child is disabled,
// "dormant" when all are dormant, etc.

import { nonNull } from "../../lib/non-null.js";
import { type SidecarLifecycleState, SidecarManager, type SidecarRequest, type SidecarResponse, type SidecarStatus, type SpawnFn } from "./sidecar-manager.js";

export interface SidecarPoolOptions {
	python_bin: string;
	script_path: string;
	/** Extra CLI args appended to `[script_path]` for every child. Forwarded
	 *  unchanged to each SidecarManager — every pool child runs with identical
	 *  startup config. */
	script_args?: readonly string[] | undefined;
	startup_timeout_ms: number;
	scan_timeout_ms: number;
	idle_shutdown_ms: number;
	max_restarts: number;
	/** Number of sidecar children. 1 behaves identically to SidecarManager
	 *  (minimal overhead: one round-robin counter). Default in callers is 3. */
	pool_size: number;
	spawn?: SpawnFn | undefined;
	stderrSink?: ((chunk: string) => void) | undefined;
	/** Fired when the AGGREGATE pool status changes (not per-child). */
	onStatusChange?: ((status: SidecarStatus) => void) | undefined;
}

/** Priority order for aggregate state collapse: higher priority wins.
 *  If ANY child is ready, the pool is ready (we can serve requests);
 *  if none ready but some still booting, the pool is still coming up;
 *  if all dormant, the pool is dormant; etc. `disabled` is lowest so a
 *  partially-failed pool still presents as the best surviving state. */
const STATE_RANK: Record<SidecarLifecycleState, number> = {
	ready: 4,
	spawning: 3,
	dormant: 2,
	idle: 1,
	disabled: 0,
};

export class SidecarPool {
	private readonly children: SidecarManager[];
	private readonly childStatuses: SidecarStatus[];
	private aggregateStatus: SidecarStatus;
	private nextIdx = 0;

	constructor(private readonly opts: SidecarPoolOptions) {
		const n = Math.max(1, opts.pool_size);
		const nowIso = new Date().toISOString();
		this.childStatuses = Array.from(
			{ length: n },
			(): SidecarStatus => ({
				state: "idle",
				restartCount: 0,
				sinceIso: nowIso,
			}),
		);
		this.aggregateStatus = {
			state: "idle",
			restartCount: 0,
			sinceIso: nowIso,
		};
		this.children = Array.from({ length: n }, (_, idx) =>
			new SidecarManager({
				python_bin: opts.python_bin,
				script_path: opts.script_path,
				script_args: opts.script_args,
				startup_timeout_ms: opts.startup_timeout_ms,
				scan_timeout_ms: opts.scan_timeout_ms,
				idle_shutdown_ms: opts.idle_shutdown_ms,
				max_restarts: opts.max_restarts,
				spawn: opts.spawn,
				stderrSink: opts.stderrSink,
				onStatusChange: (s) => this.onChildStatus(idx, s),
			}),
		);
		// Fire the initial aggregate so subscribers see "idle" before the first scan.
		this.fireStatus();
	}

	/** Read the current aggregate lifecycle snapshot. */
	getStatus(): SidecarStatus {
		return this.aggregateStatus;
	}

	/**
	 * Dispatch to one child via round-robin. A child that's busy handling a
	 * prior request will still accept the next one — SidecarManager queues
	 * internally via correlation ids — but in practice spreading across N
	 * children gives us N× throughput for the typical case where each
	 * request maps 1:1 to a single Python model invocation.
	 */
	async send(req: SidecarRequest): Promise<SidecarResponse> {
		const child = this.children[this.nextIdx];
		this.nextIdx = (this.nextIdx + 1) % this.children.length;
		return nonNull(child).send(req);
	}

	/** Shut down every child in parallel. */
	async shutdown(): Promise<void> {
		await Promise.all(this.children.map((c) => c.shutdown()));
	}

	// ---- status aggregation --------------------------------------------------

	private onChildStatus(idx: number, s: SidecarStatus): void {
		this.childStatuses[idx] = s;
		const next = this.computeAggregate();
		const changed =
			next.state !== this.aggregateStatus.state ||
			next.pid !== this.aggregateStatus.pid ||
			next.detail !== this.aggregateStatus.detail ||
			next.restartCount !== this.aggregateStatus.restartCount;
		if (!changed) return;
		this.aggregateStatus = {
			...next,
			sinceIso:
				next.state !== this.aggregateStatus.state
					? new Date().toISOString()
					: this.aggregateStatus.sinceIso,
		};
		this.fireStatus();
	}

	private computeAggregate(): SidecarStatus {
		let best: SidecarLifecycleState = "disabled";
		let readyCount = 0;
		let totalRestarts = 0;
		let firstReadyPid: number | undefined;
		for (const s of this.childStatuses) {
			if (STATE_RANK[s.state] > STATE_RANK[best]) best = s.state;
			if (s.state === "ready") {
				readyCount++;
				if (firstReadyPid === undefined) firstReadyPid = s.pid;
			}
			totalRestarts += s.restartCount;
		}
		const detail = `${readyCount}/${this.children.length} ready`;
		return {
			state: best,
			pid: firstReadyPid,
			restartCount: totalRestarts,
			detail,
			sinceIso: this.aggregateStatus.sinceIso,
		};
	}

	private fireStatus(): void {
		const cb = this.opts.onStatusChange;
		if (!cb) return;
		try {
			cb(this.aggregateStatus);
		} catch {
			// best-effort — never let a listener take down the scanner
		}
	}
}
