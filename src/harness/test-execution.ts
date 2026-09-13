import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, release } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hashBytes } from "../lib/metrics/inventory.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { captureTestRuntime } from "./test-runtime.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { planResources } from "./resource-governor.js";
import { readResourceMemory } from "./resource-memory.js";
import { readTestReceipt, writeTestReceipt, type TestExecution } from "./test-run-receipt.js";
import type { TestPlan } from "./test-plan.js";
import { testReportIssue } from "./test-run-report.js";
import { observeTestRun } from "./test-run-observation.js";

export interface TestRunOptions { root: string; deadline: number; maxWorkers?: number; signal?: AbortSignal; }

export function testWorkerBudget(requested?: number): number {
    const plan = planResources({ cores: availableParallelism(), memory: readResourceMemory(), load1: 0, agentCount: 1, platform: process.platform });
    return plan.defer ? 0 : Math.min(plan.maxJobs, requested ?? 2);
}

function testCommand(root: string, directory: string, plan: TestPlan, workers: number): string[] {
    const module = pathToFileURL(createRequire(join(root, "package.json")).resolve("vitest/node")).href;
    const selected = plan.mode === "full" ? [] : plan.tests.map(test => join(root, test.path));
    const options = { root, watch: false, run: true, cache: false, maxWorkers: workers, retry: 0, coverage: { enabled: false },
        reporters: ["json"], outputFile: join(directory, "report.json") };
    const source = `import { startVitest } from ${JSON.stringify(module)};
const ctx = await startVitest("test", ${JSON.stringify(selected)}, ${JSON.stringify(options)}, { cacheDir: ${JSON.stringify(join(directory, "vite"))} });
if (ctx) await ctx.close(); else process.exitCode = 1;`;
    return ["--input-type=module", "--eval", source];
}

async function launchTestPlan(base: TestExecution, options: TestRunOptions, environment: NodeJS.ProcessEnv, workers: number): Promise<TestExecution> {
    const directory = join(options.root, ".interlinked/test-runs", base.runId);
    mkdirSync(directory, { recursive: true });
    observeTestRun(options.root, base, "running");
    const started = Date.now();
    const result = await runProcessAsync(process.execPath, testCommand(options.root, directory, base.plan, workers), {
        cwd: options.root, timeout: Math.max(1, options.deadline - started), exactEnv: environment,
        ...(options.signal ? { signal: options.signal } : {}),
    });
    const execution: TestExecution = { ...base, durationMs: Date.now() - started, output: `${result.stdout}\n${result.stderr}`.slice(-8000),
        status: result.code === 0 ? "passed" : "failed" };
    if (interrupted(result)) return { ...execution, status: "deferred", reason: "Runner interrupted or unavailable" };
    const issue = result.code === 0 ? testReportIssue(options.root, join(directory, "report.json"), base.plan) : null;
    if (issue) return { ...execution, status: "deferred", reason: issue };
    return execution;
}

function interrupted(result: { timedOut?: boolean; killed?: boolean; code: number | null }): boolean {
    return !!result.timedOut || !!result.killed || result.code === null || result.code >= 128;
}

/** Evidence is reusable only for identical runtime bytes and controlled test dependencies. */
async function executePlan(plan: TestPlan, options: TestRunOptions): Promise<TestExecution> {
    const base: TestExecution = { plan, runId: randomUUID(), reused: false, durationMs: 0, reason: "", output: "", status: "deferred" };
    if (plan.mode === "selected" && !plan.tests.length) return { ...base, status: "empty", reason: "No tests selected; no test pass certified" };
    const workers = testWorkerBudget(options.maxWorkers);
    if (!workers) return { ...base, reason: "Insufficient memory for a test worker" };
    const environment = captureVitestEnvironment();
    if (plan.runtimeIssue) return runWithoutReusableEvidence(base, options, environment.environment, workers, plan.runtimeIssue);
    const runtime = await captureTestRuntime(options.root, options.deadline);
    if (runtime.issue) return { ...base, status: "stale", reason: `Runtime validation became unavailable: ${runtime.issue}` };
    if (plan.runtimeHash && plan.runtimeHash !== runtime.hash) return { ...base, status: "stale", reason: "Runtime changed since planning" };
    const key = hashBytes(JSON.stringify(["test-execution-v2", process.versions, process.platform, process.arch, release(),
        runtime.hash, environment.environmentHash, plan.snapshot, plan.mode, plan.tests.map(test => test.path), workers]));
    const receipt = plan.reusable ? readTestReceipt(options.root, key) : null;
    if (receipt) return { ...base, status: "passed", reused: true, runtimeVerified: true, runId: receipt.runId, reason: "Identical validated runtime and test scope" };
    const execution = await launchTestPlan(base, options, environment.environment, workers);
    if (execution.status === "deferred") return execution;
    const after = await captureTestRuntime(options.root, options.deadline);
    if (after.hash !== runtime.hash || captureVitestEnvironment().environmentHash !== environment.environmentHash) return { ...execution, status: "stale", reason: "Inputs changed during execution; a new plan is required" };
    if (plan.reusable && execution.status === "passed") writeTestReceipt(options.root, key, execution);
    return { ...execution, runtimeVerified: true };
}

async function runWithoutReusableEvidence(base: TestExecution, options: TestRunOptions, environment: NodeJS.ProcessEnv, workers: number, issue: string): Promise<TestExecution> {
    const result = await launchTestPlan(base, options, environment, workers);
    return { ...result, runtimeVerified: false, reason: [result.reason, `Fresh execution only; runtime validation unavailable (${issue}). No reusable or coverage verdict.`].filter(Boolean).join("; ") };
}

export async function executeTestPlan(plan: TestPlan, options: TestRunOptions): Promise<TestExecution> {
    const result = await executePlan(plan, options);
    if (result.status !== "empty") observeTestRun(options.root, result);
    return result;
}
