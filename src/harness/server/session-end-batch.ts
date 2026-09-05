// ===========================================
// SessionEnd idle-compute batch — the good-citizen seam (DW P2 §4/§7)
// ===========================================
// At SessionEnd the daemon may run heavy, unbounded work (full-suite + coverage
// refresh, whole-repo recurrence scan) while the human is between turns. Every
// such job MUST pass the resource governor first so it never fights the next
// session or the developer's machine. This module computes that plan once per
// SessionEnd and logs it — the single seam the background jobs attach to.
//
// Never-throw contract (mirrors runSessionEndScratchpadArchive): a governor or
// os read that fails must not break SessionEnd cleanup. Returns the plan for the
// jobs (and tests) to consume, or null on an unexpected error.

import { spawn as nodeSpawn } from "node:child_process";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { dataMaintenanceJobs } from "../../lib/data/maintenance.js";
import { planResources, type ResourcePlan } from "../resource-governor.js";
import type { HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/** Logical-core count, tolerant of older runtimes without availableParallelism. */
function coreCount(): number {
	return typeof os.availableParallelism === "function"
		? os.availableParallelism()
		: os.cpus().length;
}

/**
 * Decide (and log) how the heavy lane should run right now: job cap, background
 * priority, or defer-when-busy. Jobs 1 (full-suite + coverage refresh) and 4
 * (whole-repo recurrence scan) gate on `!plan.defer` and inherit `plan.maxJobs`
 * + `plan.commandPrefix`. Job 6 (fingerprint archive) already ships via
 * `fingerprint-archive.ts` on the block path.
 */
export function runSessionEndResourcePlan(
	ctx: ServerRuntime,
	event: HarnessEvent,
): ResourcePlan | null {
	try {
		// Spec-default policy (half cores, defer when busy). Per-repo tuning
		// (`resource_governor` config) lands with jobs 1/4 that need to override
		// it — the defaults are correct for the single-agent-local common case.
		const plan = planResources({
			cores: coreCount(),
			load1: os.loadavg()[0] ?? 0,
			agentCount: ctx.cohort.getActiveAgents().length,
			platform: process.platform,
		});
		const lane = plan.defer ? "DEFER heavy lane" : `${plan.maxJobs} job(s)`;
		ctx.log(`[session-end:${event.session_id}] resource plan: ${lane} — ${plan.reason}`);
		return plan;
	} catch (err) {
		void err; // never-throw: SessionEnd cleanup must complete regardless
		return null;
	}
}

/** Resolve the interlinked CLI entry (dist/index.js) from the running daemon —
 *  argv[1] is `<repo>/dist/harness/server.js`, so the CLI sits one dir up. */
function resolveCliEntry(): string {
	return resolve(dirname(process.argv[1] ?? ""), "..", "index.js");
}

/**
 * Wrap a command in the governor's background-priority prefix. `""` → run
 * directly; `"taskpolicy -b "` / `"nice -n 19 "` → the prefix binary becomes the
 * spawned file and the real command its trailing args. Pure (testable).
 */
export function governedSpawn(
	commandPrefix: string,
	file: string,
	args: string[],
): { file: string; args: string[] } {
	const prefix = commandPrefix.trim().split(/\s+/).filter(Boolean);
	if (prefix.length === 0) return { file, args };
	return { file: prefix[0] ?? file, args: [...prefix.slice(1), file, ...args] };
}

/** Injectable seams for testing the spawn without launching a real process. */
export interface SessionEndJobDeps {
	spawn?: typeof nodeSpawn;
	cliEntry?: string;
	execPath?: string;
	/** Test seam. Production uses the daemon-process singleton below. */
	activeJobs?: Set<string>;
}

/** Detached does not mean unobservable: ChildProcess still emits exit/error in
 * the daemon. Keep one active process per heavy job so a burst of SessionEnd
 * events cannot multiply whole-repo scans and exhaust external-tool capacity. */
const ACTIVE_SESSION_END_JOBS = new Set<string>();

/**
 * Fire-and-forget governed background jobs at SessionEnd. Ships job 4 — the
 * governor defers (busy machine); never-throw; `INTERLINKED_DISABLE_SESSION_END_JOBS=1`
 * opts out.
 *
 * The jobs, each a governed `interlinked <argv>` background spawn:
 *   - **Job 4** — `recurrence scan --record` (append-only recurrence records).
 *   - **Job 1** — `coverage check --update-baseline` (ratchet coverage from the
 *     session's latest summary). SAFE to automate: `compareCoverage` advances a
 *     baseline metric ONLY when it is flat-or-rising and holds it at the
 *     high-water mark otherwise, so this can never LOWER the ratchet — it is
 *     raise-only by construction. A no-op when no fresh summary exists.
 *
 * Jobs 2/3 (fuzz-smoke, bench) stay out: they need a repo-specific fuzz/bench
 * command to invoke (there is no generic one), so a runner here would spawn a
 * command that doesn't exist. They belong with a repo that has those harnesses.
 */
interface SessionEndJob {
	name: string;
	argv: string[];
}

const SESSION_END_JOBS: SessionEndJob[] = [
	{ name: "recurrence-scan", argv: ["recurrence", "scan", "--record"] },
	{ name: "coverage-ratchet", argv: ["coverage", "check", "--update-baseline"] },
];

interface SpawnGovernedJobInput {
	ctx: ServerRuntime;
	plan: ResourcePlan;
	spawn: typeof nodeSpawn;
	execPath: string;
	cliEntry: string;
	job: SessionEndJob;
	activeJobs: Set<string>;
}

function spawnGovernedJob(input: SpawnGovernedJobInput): void {
	const { ctx, plan, spawn, execPath, cliEntry, job, activeJobs } = input;
	if (activeJobs.has(job.name)) {
		ctx.log(`[session-end:job] ${job.name} already running (skipped)`);
		return;
	}
	const { file, args } = governedSpawn(plan.commandPrefix, execPath, [cliEntry, ...job.argv]);
	try {
		const child = spawn(file, args, { cwd: ctx.cwd, detached: true, stdio: "ignore" });
		activeJobs.add(job.name);
		child.on("error", (e: Error) => {
			activeJobs.delete(job.name);
			ctx.log(`[session-end:job] ${job.name} spawn failed (skipped): ${e.message}`);
		});
		child.on("exit", () => {
			activeJobs.delete(job.name);
		});
		child.unref();
		ctx.log(`[session-end:job] ${job.name} spawned (bg=${plan.background})`);
	} catch (err) {
		activeJobs.delete(job.name);
		void err; // never-throw: a spawn failure must not break SessionEnd cleanup
	}
}

export function runSessionEndJobs(
	ctx: ServerRuntime,
	plan: ResourcePlan,
	deps: SessionEndJobDeps = {},
): void {
	if (plan.defer) return; // machine busy — the governor said no heavy lane
	if (process.env.INTERLINKED_DISABLE_SESSION_END_JOBS === "1") return;
	const spawn = deps.spawn ?? nodeSpawn;
	const execPath = deps.execPath ?? process.execPath;
	const cliEntry = deps.cliEntry ?? resolveCliEntry();
	// An injected spawn is normally a one-call test double, so it gets an
	// isolated set unless the test explicitly asks to exercise single-flight.
	const activeJobs = deps.activeJobs ?? (deps.spawn === undefined
		? ACTIVE_SESSION_END_JOBS
		: new Set<string>());
	for (const job of [...SESSION_END_JOBS, ...dataMaintenanceJobs(ctx.cwd)]) {
		spawnGovernedJob({ ctx, plan, spawn, execPath, cliEntry, job, activeJobs });
	}
}
