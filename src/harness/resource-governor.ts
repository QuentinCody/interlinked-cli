// ===========================================
// Good-citizen resource governor (DW test-adoption P2 §7)
// ===========================================
// The harness must be a bounded, well-behaved tenant on the developer's machine
// — the box is never idle (IDE, browser, watch-builds, Docker), so a heavy lane
// that burns every core makes the laptop janky, fights the very watch-builds the
// work depends on, and thermal-throttles (silently shrinking the budget). This
// self-governor caps the harness well below the machine's ceiling BEFORE any
// heavy lane (SessionEnd batch, full-suite refresh) runs.
//
// PURE: cores, load, agent count, and platform are INPUTS — no os.* reads, no
// clock — so every decision is a total function testable without a real machine.
// The caller (server-side) supplies live readings from os.availableParallelism()
// / os.loadavg() / cohort.ts.
//
// Three levers from the spec: (1) cap jobs below core count (~half, reserve
// headroom); (2) run at background priority (macOS `taskpolicy -b` → E-cores on
// Apple Silicon; Linux `nice`); (3) sense load and shrink/defer the heavy lane
// when the machine is already busy. Fail-open bias: when load is UNKNOWN (0 /
// Windows), behave as a quiet machine — never block work on a missing reading.

/** Tunables — all optional; defaults encode the spec's "~half the cores,
 *  reserve headroom, defer when busy" policy. Sourced from guard-rules config. */
interface ResourceGovernorConfig {
	/** Hard job cap. Default `ceil(cores / 2)` — never `nproc`. */
	max_jobs?: number;
	/** Per-core 1-min load at/above which the heavy lane HALVES its jobs. */
	load_threshold?: number;
	/** Per-core 1-min load at/above which the heavy lane is DEFERRED entirely. */
	defer_threshold?: number;
	/** Optional CPU-second ceiling for one heavy run (jobs × est. wall). */
	cpu_budget_sec?: number;
}

export interface GovernorInput {
	/** Logical cores (os.availableParallelism()). */
	cores: number;
	/** 1-min load average (os.loadavg()[0]); 0 when unknown (e.g. Windows). */
	load1: number;
	/** Concurrent agents sharing the machine (cohort.ts), clamped to ≥1. */
	agentCount: number;
	/** process.platform — selects the background-priority wrapper. */
	platform: NodeJS.Platform;
	/** Estimated wall-seconds of one job, for the CPU-second budget (optional). */
	estJobWallSec?: number;
	config?: ResourceGovernorConfig | undefined;
}

export interface ResourcePlan {
	/** Jobs to hand the runner (vitest maxThreads / pytest -n / cargo --jobs). */
	maxJobs: number;
	/** True → wrap the runner in a background-priority prefix. */
	background: boolean;
	/** Shell prefix that lowers scheduling priority, or "" when unavailable. */
	commandPrefix: string;
	/** True → the machine is too busy; skip the heavy lane this time (fail-open,
	 *  never a false-block — the caller degrades to cheap-signal / offload). */
	defer: boolean;
	/** Human-readable one-liner for logs / the SessionEnd evidence bundle. */
	reason: string;
}

const DEFAULT_LOAD_THRESHOLD = 0.7;
const DEFAULT_DEFER_THRESHOLD = 1.5;

/** Background-priority command prefix for the platform ("" when none applies —
 *  Windows has no portable equivalent, so the heavy lane just runs un-niced). */
export function backgroundPrefix(platform: NodeJS.Platform): string {
	if (platform === "darwin") return "taskpolicy -b ";
	if (platform === "linux") return "nice -n 19 ";
	return "";
}

/** Base job cap: explicit config, else half the cores (min 1). */
function baseJobCap(cores: number, config?: ResourceGovernorConfig): number {
	if (config?.max_jobs && config.max_jobs > 0) return config.max_jobs;
	return Math.max(1, Math.ceil(Math.max(1, cores) / 2));
}

/** Apply the CPU-second budget: jobs × est-wall must fit the ceiling. */
function capByCpuBudget(jobs: number, input: GovernorInput): number {
	const budget = input.config?.cpu_budget_sec;
	const est = input.estJobWallSec;
	if (!budget || !est || est <= 0) return jobs;
	return Math.max(1, Math.min(jobs, Math.floor(budget / est)));
}

/**
 * Decide how (and whether) to run the heavy lane right now. Load-sensing +
 * job-cap + agent-sharing + CPU-second budget, with a background-priority
 * prefix. UNKNOWN load (0) is treated as a quiet machine (fail-open).
 */
export function planResources(input: GovernorInput): ResourcePlan {
	const cores = Math.max(1, input.cores);
	const agents = Math.max(1, input.agentCount);
	const cfg = input.config;
	const loadThreshold = cfg?.load_threshold ?? DEFAULT_LOAD_THRESHOLD;
	const deferThreshold = cfg?.defer_threshold ?? DEFAULT_DEFER_THRESHOLD;
	const perCore = input.load1 > 0 ? input.load1 / cores : 0;
	const prefix = backgroundPrefix(input.platform);

	if (perCore >= deferThreshold) {
		return {
			maxJobs: 0,
			background: true,
			commandPrefix: prefix,
			defer: true,
			reason: `machine busy (load/core ${perCore.toFixed(2)} ≥ ${deferThreshold}) — deferring heavy lane`,
		};
	}

	let jobs = baseJobCap(cores, cfg);
	const notes: string[] = [`base ${jobs} of ${cores} cores`];
	if (perCore >= loadThreshold) {
		jobs = Math.max(1, Math.floor(jobs / 2));
		notes.push(`halved (load/core ${perCore.toFixed(2)} ≥ ${loadThreshold})`);
	}
	if (agents > 1) {
		jobs = Math.max(1, Math.floor(jobs / agents));
		notes.push(`shared across ${agents} agents`);
	}
	const budgeted = capByCpuBudget(jobs, input);
	if (budgeted !== jobs) notes.push(`CPU-budget capped to ${budgeted}`);
	jobs = budgeted;

	return {
		maxJobs: jobs,
		background: prefix !== "",
		commandPrefix: prefix,
		defer: false,
		reason: notes.join("; "),
	};
}
