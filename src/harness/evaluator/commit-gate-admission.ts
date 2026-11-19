import { combinedProcessSignal } from "../check-engine/process-cancellation.js";
import { runProcessAsync } from "../check-engine/spawn-async.js";
import { coverageRunnerFor, type CoverageLanguage, type CoverageRunOpts, type CoverageRunResult, type SpawnFn } from "../coverage-runner.js";
import { LEASE_ANCESTORS_ENV, leaseAncestorsForChildren } from "../project-compiler-lock.js";
import { tryAcquireProjectHeavyProcessLease } from "../project-heavy-process-lock.js";
import { readResourceBudget, type ResourceBudget } from "../resource-budget.js";
import { currentRequestSignal } from "../server/request-cancellation.js";
import { tryAcquireForegroundCapacity } from "../test-capacity.js";
import { testWorkerBudget } from "../test-execution.js";

export type CommitSuiteMeasurement = CoverageRunResult | { deferred: string };

async function measureCommitSuite(language: CoverageLanguage, options: CoverageRunOpts, budget: ResourceBudget, signal: AbortSignal | undefined): Promise<CommitSuiteMeasurement> {
	// Instrumented captures use the same single-worker request as indexed coverage.
	const workers = testWorkerBudget(1);
	if (workers < 1) return { deferred: "No host capacity for a coverage worker" };
	let interrupted: string | undefined;
	const spawn: SpawnFn = async (command, args, run) => {
		const result = await runProcessAsync(command, language === "python" ? args : [...args, "--maxWorkers=" + workers], {
			cwd: run.cwd, timeout: run.timeout, resourceBudget: budget, ...(signal ? { signal } : {}), reapDescendantGroups: true,
			env: { ...run.env, [LEASE_ANCESTORS_ENV]: leaseAncestorsForChildren() },
		});
		if (result.timedOut) interrupted = "Commit coverage timed out";
		else if (result.resourceReason || result.killed || result.code === null) interrupted = result.resourceReason ?? "Commit coverage interrupted";
		else if (result.code !== 0 && (result.stdoutTruncated || result.stderrTruncated)) interrupted = "Commit coverage failure diagnostics were truncated";
		return { stdout: result.stdout, stderr: result.stderr, status: result.code, ...(interrupted ? { error: new Error(interrupted) } : {}) };
	};
	const runner = coverageRunnerFor(language, spawn);
	if (!runner) return { deferred: "No coverage runner for " + language };
	const result = await runner.run(options);
	if (signal?.aborted) return { deferred: "Commit coverage interrupted" };
	return interrupted ? { deferred: interrupted } : result;
}

/** A snapshot is a work directory. Its real checkout owns the project lease, and all checkouts share the host slot. */
export async function runAdmittedCommitSuite(language: CoverageLanguage, options: CoverageRunOpts): Promise<CommitSuiteMeasurement> {
	const signal = combinedProcessSignal(currentRequestSignal());
	if (signal?.aborted) return { deferred: "Commit coverage interrupted" };
	const releaseProject = tryAcquireProjectHeavyProcessLease(options.runtimeRoot ?? options.projectRoot);
	if (!releaseProject) return { deferred: "The project is busy" };
	try {
		const host = tryAcquireForegroundCapacity({ allowAncestor: false });
		if (!host) return { deferred: "The host test slot is busy" };
		try {
			const budget = readResourceBudget();
			if (!budget) return { deferred: "Host memory reserve unavailable" };
			return await measureCommitSuite(language, options, budget, signal);
		} finally {
			host.release();
		}
	} finally {
		releaseProject();
	}
}
