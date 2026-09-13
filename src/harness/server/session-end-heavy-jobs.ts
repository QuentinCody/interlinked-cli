// ===========================================
// SessionEnd heavy jobs — fuzz-smoke + bench (DW P4 §4 jobs 2/3)
// ===========================================
// Governed, detached, run-if-exists background jobs that write their OWN vitest
// json report (no daemon-held capture); SessionStart reads a completed report
// and surfaces failures/regressions next session (session-start-heavy-reports.ts).
//   - fuzz-smoke: runs the repo's fast-check targets HARD (numRuns 500) to
//     recover the search depth the per-edit cap (P0.1) trades away.
//   - bench: `vitest bench` snapshot; the variance-aware comparison (e-process)
//     happens at read time.
// Kept separate from session-end-batch.ts's interlinked-CLI jobs because these
// spawn `npx vitest …`. Never-throw; `INTERLINKED_DISABLE_SESSION_END_JOBS=1`
// opts out; skipped when the governor defers.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResourcePlan } from "../resource-governor.js";
import type { HarnessEvent } from "../types.js";
import { detectFuzzTargets } from "./fuzz-targets.js";
import type { ServerRuntime } from "./runtime-context.js";
import { governedSpawn, supervisedCommand, type SessionEndJobDeps, type SessionEndSpawn } from "./session-end-batch.js";

/** Elevated fast-check case count for the SessionEnd fuzz-smoke (per-edit cap is 25). */
const FUZZ_SMOKE_NUMRUNS = "500";
const ACTIVE_HEAVY_JOBS = new Set<string>();

function safeId(sessionId: string): string {
	return sessionId.replace(/[^\w.-]/g, "_") || "unknown";
}

/** `<cwd>/.interlinked/<kind>-reports/<session>.json` — vitest writes here; SessionStart reads. */
export function heavyJobReportPath(cwd: string, kind: "fuzz" | "bench", sessionId: string): string {
	return join(cwd, ".interlinked", `${kind}-reports`, `${safeId(sessionId)}.json`);
}

interface HeavyJobCommand {
	file: string;
	args: string[];
	env?: Record<string, string>;
}

interface HeavyJob {
	name: string;
	kind: "fuzz" | "bench";
	/** The vitest command to spawn, or null to skip (run-if-exists). */
	build: (cwd: string, reportPath: string) => HeavyJobCommand | null;
}

const HEAVY_JOBS: HeavyJob[] = [
	{
		name: "fuzz-smoke",
		kind: "fuzz",
		build: (cwd, reportPath) => {
			const targets = detectFuzzTargets(cwd);
			if (targets.length === 0) return null;
			return {
				file: "npx",
				args: ["vitest", "run", ...targets, "--reporter=json", `--outputFile=${reportPath}`],
				env: { INTERLINKED_PROPERTY_NUMRUNS: FUZZ_SMOKE_NUMRUNS },
			};
		},
	},
	{
		name: "bench-snapshot",
		kind: "bench",
		build: (cwd, reportPath) => {
			if (!existsSync(join(cwd, "bench"))) return null;
			return {
				file: "npx",
				args: ["vitest", "bench", "--run", "bench/", "--reporter=json", `--outputFile=${reportPath}`],
			};
		},
	},
];

function spawnHeavyJob(
	ctx: ServerRuntime,
	plan: ResourcePlan,
	spawn: SessionEndSpawn,
	name: string,
	reportPath: string,
	cmd: HeavyJobCommand,
	deps: SessionEndJobDeps,
): void {
	const activeJobs = deps.activeJobs ?? ACTIVE_HEAVY_JOBS;
	const key = `${ctx.cwd}\0${name}`;
	if (activeJobs.has(key)) return;
	try {
		mkdirSync(dirname(reportPath), { recursive: true });
	} catch (err) {
		void err; // vitest may still create it; best-effort
	}
	const command = supervisedCommand(name, cmd.file, [...cmd.args, `--maxWorkers=${plan.maxJobs}`], deps);
	const { file, args } = governedSpawn(plan.commandPrefix, command.file, command.args);
	try {
		activeJobs.add(key);
		const child = spawn(file, args, {
			cwd: ctx.cwd,
			detached: true,
			stdio: "ignore",
			...(cmd.env ? { env: { ...process.env, ...cmd.env } } : {}),
		});
		child.on("error", (e: Error) => {
			activeJobs.delete(key);
			ctx.log(`[session-end:heavy] ${name} spawn failed (skipped): ${e.message}`);
		});
		child.on("exit", () => { activeJobs.delete(key); });
		child.unref();
		ctx.log(`[session-end:heavy] ${name} spawned (bg=${plan.background})`);
	} catch (err) {
		activeJobs.delete(key);
		void err; // never-throw: a spawn failure must not break SessionEnd cleanup
	}
}

/** Spawn the run-if-exists heavy jobs (fuzz-smoke, bench). Never throws. */
export function runSessionEndHeavyJobs(
	ctx: ServerRuntime,
	event: HarnessEvent,
	plan: ResourcePlan,
	deps: SessionEndJobDeps = {},
): void {
	if (plan.defer) return; // machine busy — the governor said no heavy lane
	if (process.env.INTERLINKED_DISABLE_SESSION_END_JOBS === "1") return;
	const spawn = deps.spawn ?? nodeSpawn;
	for (const job of HEAVY_JOBS) {
		const reportPath = heavyJobReportPath(ctx.cwd, job.kind, event.session_id);
		const cmd = job.build(ctx.cwd, reportPath);
		if (cmd) spawnHeavyJob(ctx, plan, spawn, job.name, reportPath, cmd, deps);
	}
}
