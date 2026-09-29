import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hashBytes } from "../lib/metrics/inventory.js";
import { createRequire } from "node:module";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkIdentity, identityEnvironmentHash, policyDigest, reporterBinding, reporterBindingChanged, toolchainIdentity, type ReporterBinding } from "./check-identity.js";
import { LEASE_ANCESTORS_ENV, leaseAncestorsForChildren } from "./project-compiler-lock.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { captureTestRuntime, type TestRuntime } from "./test-runtime.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";
import { planResources } from "./resource-governor.js";
import { readResourceMemory } from "./resource-memory.js";
import { readResourceBudget } from "./resource-budget.js";
import { readTestReceipt, receiptStorePath, writeTestReceipt, type PassedReceipt, type RunArtifacts, type TestExecution } from "./test-run-receipt.js";
import type { TestPlan } from "./test-plan.js";
import { testReportIssue } from "./test-run-report.js";
import { observeTestRun } from "./test-run-observation.js";
import { elapsedMs, platformIdentity, recordVerificationStage, type ReuseDeniedReason, type VerificationStage, type VerificationStageInput } from "./verification-stages.js";

export interface TestRunOptions {
    root: string;
    deadline: number;
    maxWorkers?: number;
    signal?: AbortSignal;
    /** Which pipeline stage asked (ledger row); defaults to `cli`. */
    stage?: VerificationStage;
    /** A dry run never writes the stage ledger. */
    dryRun?: boolean;
    session?: string;
    /** `Date.now()` when the request was queued, for the row's `queue_ms`. */
    queuedAt?: number;
    /** Milliseconds the scheduler waited for its leases before this execution. */
    waitCapacityMs?: number;
    /** Collect coverage (json-summary) into the run directory; `reporters` are extra vitest reporter module paths (a scope recorder). */
    coverage?: { reporters?: string[] };
    /** Receipt + run-artifact store; defaults to `<root>/.interlinked/test-runs`. */
    receiptStore?: string;
}

/** Artifact names a coverage run leaves in `<runDir>/coverage`, relative to the run directory. */
const COVERAGE_ARTIFACTS: Record<string, string> = { coverage_summary: "coverage/coverage-summary.json", coverage_scope: "coverage/scope.json" };

/** The run's artifacts that exist on disk, hashed, with paths relative to the receipt store. */
function collectArtifacts(store: string, runId: string): RunArtifacts {
    const artifacts: RunArtifacts = {};
    for (const [name, relativePath] of Object.entries(COVERAGE_ARTIFACTS)) {
        const path = join(store, runId, relativePath);
        if (existsSync(path)) artifacts[name] = { path: join(runId, relativePath), sha256: hashBytes(readFileSync(path)) };
    }
    return artifacts;
}

/** A passed run carries whatever artifacts it left, whether or not its evidence is reusable (coverage is produced either way). */
function withArtifacts(options: TestRunOptions, execution: TestExecution): TestExecution {
    if (execution.status !== "passed") return execution;
    const artifactStore = receiptStorePath(options.root, options.receiptStore);
    const artifacts = collectArtifacts(artifactStore, execution.runId);
    return Object.keys(artifacts).length ? { ...execution, artifacts, artifactStore, artifactRoot: options.root } : execution;
}

/** Per-attempt ledger facts: the receipt identity (when computed), when the attempt started, phase timings and why reuse was denied. */
interface StageOutcome { identity: string | null; started: number; validate_ms?: number; lookup_ms?: number; exec_ms?: number; post_ms?: number; denied?: ReuseDeniedReason; }

/** One ledger row per execution attempt: what happened, how long each phase took, and why nothing could be reused. */
function recordExecution(options: TestRunOptions, execution: TestExecution, outcome: StageOutcome): TestExecution {
    const input: VerificationStageInput = { stage: options.stage ?? "cli", check: `vitest:${execution.plan.mode}`, identity: outcome.identity, status: execution.status, reused: execution.reused };
    if (execution.runId) input.run_id = execution.runId;
    if (outcome.denied) input.reuse_denied_reason = outcome.denied;
    if (options.session) input.session = options.session;
    if (options.waitCapacityMs !== undefined) input.wait_capacity_ms = options.waitCapacityMs;
    if (options.queuedAt !== undefined) input.queue_ms = elapsedMs(options.queuedAt, () => outcome.started);
    if (outcome.validate_ms !== undefined) input.validate_ms = outcome.validate_ms;
    if (outcome.lookup_ms !== undefined) input.lookup_ms = outcome.lookup_ms;
    if (outcome.exec_ms !== undefined) input.exec_ms = outcome.exec_ms;
    if (outcome.post_ms !== undefined) input.post_ms = outcome.post_ms;
    recordVerificationStage(options.root, input, { dryRun: options.dryRun === true });
    return execution;
}

export function testWorkerBudget(requested?: number): number {
    const budget = readResourceBudget();
    if (!budget) return 0;
    const plan = planResources({ cores: availableParallelism(), memory: readResourceMemory(), load1: loadavg()[0] ?? 0, agentCount: 1, platform: process.platform });
    return plan.defer ? 0 : Math.min(plan.maxJobs, requested ?? 2, Math.floor(budget.maxRssBytes / 1024 ** 3) - 1);
}

function testCommand(root: string, directory: string, plan: TestPlan, workers: number, coverage?: TestRunOptions["coverage"]): string[] {
    const module = pathToFileURL(createRequire(join(root, "package.json")).resolve("vitest/node")).href;
    const selected = plan.mode === "full" ? [] : plan.tests.map(test => join(root, test.path));
    // Coverage lands inside the run directory so it travels with the receipt; the repository's vitest config supplies provider and include globs.
    const coverageOptions = coverage ? { enabled: true, reporter: ["json-summary"], reportsDirectory: join(directory, "coverage") } : { enabled: false };
    const options = { root, watch: false, run: true, cache: false, maxWorkers: workers, retry: 0, coverage: coverageOptions,
        reporters: ["json", ...(coverage?.reporters ?? [])], outputFile: join(directory, "report.json") };
    const source = `import { startVitest } from ${JSON.stringify(module)};
const ctx = await startVitest("test", ${JSON.stringify(selected)}, ${JSON.stringify(options)}, { cacheDir: ${JSON.stringify(join(directory, "vite"))} });
if (ctx) await ctx.close(); else process.exitCode = 1;`;
    return ["--max-old-space-size=1536", "--input-type=module", "--eval", source];
}

async function launchTestPlan(base: TestExecution, options: TestRunOptions, environment: NodeJS.ProcessEnv, workers: number): Promise<TestExecution> {
    const resourceBudget = readResourceBudget();
    if (!resourceBudget) return { ...base, status: "deferred", reason: "Host memory reserve unavailable; test request retained" };
    const directory = join(receiptStorePath(options.root, options.receiptStore), base.runId);
    mkdirSync(directory, { recursive: true });
    observeTestRun(options.root, base, "running");
    const started = Date.now();
    // The child runs UNDER this process's leases (a test that takes the host lease itself must not deadlock on the run
    // hosting it); a scope reporter (scripts/pre-push-coverage.mjs) writes the coverage-inclusion scope beside the summary.
    const childEnvironment: NodeJS.ProcessEnv = { ...environment, [LEASE_ANCESTORS_ENV]: leaseAncestorsForChildren() };
    if (options.coverage) childEnvironment.INTERLINKED_COVERAGE_SCOPE_FILE = join(directory, COVERAGE_ARTIFACTS.coverage_scope ?? "coverage/scope.json");
    const result = await runProcessAsync(process.execPath, testCommand(options.root, directory, base.plan, workers, options.coverage), {
        cwd: options.root, timeout: Math.max(1, options.deadline - started), exactEnv: childEnvironment, resourceBudget,
        ...(options.signal ? { signal: options.signal } : {}),
    });
    const execution: TestExecution = { ...base, durationMs: Date.now() - started, output: `${result.stdout}\n${result.stderr}`.slice(-8000),
        status: result.code === 0 ? "passed" : "failed" };
    if (interrupted(result)) return { ...execution, status: "deferred", reason: result.resourceReason ?? "Runner interrupted or unavailable" };
    const issue = result.code === 0 ? testReportIssue(options.root, join(directory, "report.json"), base.plan) : null;
    if (issue) return { ...execution, status: "deferred", reason: issue };
    return execution;
}

function interrupted(result: { timedOut?: boolean; killed?: boolean; code: number | null }): boolean {
    return !!result.timedOut || !!result.killed || result.code === null || result.code >= 128;
}

type Outcome = Omit<StageOutcome, "started">;
type Attempt = { execution: TestExecution; outcome: Outcome };
interface AdmittedContext { environment: ReturnType<typeof captureVitestEnvironment>; workers: number; }

/** Evidence is reusable only for identical runtime bytes and controlled test dependencies. */
async function executePlan(plan: TestPlan, options: TestRunOptions): Promise<TestExecution> {
    const started = Date.now();
    const base: TestExecution = { plan, runId: randomUUID(), reused: false, durationMs: 0, reason: "", output: "", status: "deferred" };
    const record = (attempt: Attempt) => recordExecution(options, attempt.execution, { started, ...attempt.outcome });
    if (plan.mode === "selected" && !plan.tests.length) return record({ execution: { ...base, status: "empty", reason: "No tests selected; no test pass certified" }, outcome: { identity: null, denied: "empty-selection" } });
    const workers = testWorkerBudget(options.maxWorkers);
    if (!workers) return record({ execution: { ...base, reason: "Host CPU or memory capacity unavailable for a test worker" }, outcome: { identity: null, denied: "worker-budget-unavailable" } });
    const environment = captureVitestEnvironment();
    if (plan.runtimeIssue) {
        const execStarted = Date.now();
        const execution = withArtifacts(options, await runWithoutReusableEvidence(base, options, environment.environment, workers, plan.runtimeIssue));
        return record({ execution, outcome: { identity: null, exec_ms: elapsedMs(execStarted), denied: `plan-not-reusable:${plan.runtimeIssue}` } });
    }
    return record(await executeValidated(base, options, { environment, workers }));
}

/**
 * The logical runner argv: what the child executes, minus paths that the snapshot already covers. Reporter modules
 * run from OUTSIDE the checkout (the runtime snapshot cannot see them), so each is named with the digest of its
 * bytes and relative-import closure — a changed reporter is a different check.
 */
function executionCommand(plan: TestPlan, workers: number, coverage: TestRunOptions["coverage"] | undefined, reporters: ReporterBinding): string[] {
    const scope = plan.mode === "full" ? [] : plan.tests.map(test => test.path);
    const reporterArgs = reporters.entries.map(([path, sha256]) => `--reporter=${path}#${sha256}`);
    return ["vitest", plan.mode, ...scope, `--workers=${workers}`, ...(coverage ? ["--coverage", ...reporterArgs] : [])];
}

/**
 * The receipt key is the check identity: inputs, command, toolchain, environment, platform and policy
 * (check-identity.ts). The environment component is the NORMALIZED hash so a local run and the pre-push
 * export can share a receipt; the child still runs under the exact captured environment.
 */
function executionKey(options: TestRunOptions, plan: TestPlan, context: AdmittedContext & { runtimeHash: string; reporters: ReporterBinding }): string {
    return checkIdentity({
        inputs: { snapshot: plan.snapshot, runtimeHash: context.runtimeHash }, command: executionCommand(plan, context.workers, options.coverage, context.reporters),
        toolchain: toolchainIdentity(options.root), environmentHash: identityEnvironmentHash(context.environment.environment), platform: platformIdentity(), policy: policyDigest(options.root),
    });
}

/** Restores the producer's checkout and store separately: only the store belongs to the current caller. */
function reusedArtifacts(receipt: PassedReceipt, options: TestRunOptions): Partial<TestExecution> {
    if (!receipt.artifacts || !receipt.artifactRoot) return {};
    return { artifacts: receipt.artifacts, artifactRoot: receipt.artifactRoot, artifactStore: receiptStorePath(options.root, options.receiptStore) };
}

/** Binds the plan to the live runtime, consumes an identical receipt when one exists, else runs fresh. */
async function executeValidated(base: TestExecution, options: TestRunOptions, context: AdmittedContext): Promise<Attempt> {
    const plan = base.plan;
    // Runtime validation is paid on every path below (hit, miss, early stale return), so it is its own measured phase.
    const validateStarted = Date.now();
    const runtime = await captureTestRuntime(options.root, options.deadline);
    const reporters = reporterBinding(options.coverage?.reporters ?? []);
    const validate_ms = elapsedMs(validateStarted);
    const stale = (reason: string): Attempt => ({ execution: { ...base, status: "stale", reason }, outcome: { identity: null, validate_ms, denied: "stale-inputs" } });
    if (runtime.issue || runtime.hash === undefined) return stale(`Runtime validation became unavailable: ${runtime.issue ?? "no runtime hash"}`);
    if (plan.runtimeHash && plan.runtimeHash !== runtime.hash) return stale("Runtime changed since planning");
    if (reporters.unresolved.length || reporters.opaque.length) {
        // Reporter code with a load nothing can hash, or a runtime read the bytes cannot pin (the same rule tests
        // obey), is an untracked input: run, but certify nothing reusable.
        const issue = reporters.unresolved.length ? `Reporter imports unresolved: ${reporters.unresolved.join(", ")}` : `Reporter execution opaque: ${reporters.opaque.join(", ")}`;
        const execStarted = Date.now();
        const execution = await runWithoutReusableEvidence(base, options, context.environment.environment, context.workers, issue);
        return { execution: withArtifacts(options, execution), outcome: { identity: null, validate_ms, exec_ms: elapsedMs(execStarted), denied: `plan-not-reusable:${issue}` } };
    }
    const key = executionKey(options, plan, { ...context, runtimeHash: runtime.hash, reporters });
    const lookupStarted = Date.now();
    const receipt = plan.reusable ? readTestReceipt(options.root, key, options.receiptStore) : null;
    const lookup_ms = elapsedMs(lookupStarted);
    if (receipt) {
        const execution: TestExecution = { ...base, ...reusedArtifacts(receipt, options), status: "passed", reused: true, runtimeVerified: true, runId: receipt.runId, reason: "Identical validated runtime and test scope" };
        return { execution, outcome: { identity: key, validate_ms, lookup_ms } };
    }
    const fresh = await runFresh(base, options, { ...context, runtimeHash: runtime.hash, key, reporters });
    return { execution: fresh.execution, outcome: { identity: key, validate_ms, lookup_ms, ...fresh.outcome } };
}

/** Every input the identity was computed from, re-read after the run: repository runtime, environment and external reporter code. */
function inputsChangedDuringRun(options: TestRunOptions, context: AdmittedContext & { runtimeHash: string; reporters: ReporterBinding }, after: TestRuntime): boolean {
    return after.hash !== context.runtimeHash
        || captureVitestEnvironment().environmentHash !== context.environment.environmentHash
        || reporterBindingChanged(context.reporters, reporterBinding(options.coverage?.reporters ?? []));
}

/** Runs the plan, re-validates every identity input afterwards and writes the receipt a later identical plan can reuse. */
async function runFresh(base: TestExecution, options: TestRunOptions, context: AdmittedContext & { runtimeHash: string; key: string; reporters: ReporterBinding }): Promise<{ execution: TestExecution; outcome: Omit<Outcome, "identity"> }> {
    const execStarted = Date.now();
    const execution = await launchTestPlan(base, options, context.environment.environment, context.workers);
    const exec_ms = elapsedMs(execStarted);
    if (execution.status === "deferred") return { execution, outcome: { exec_ms, denied: "interrupted" } };
    const postStarted = Date.now();
    const after = await captureTestRuntime(options.root, options.deadline);
    const post_ms = elapsedMs(postStarted);
    if (inputsChangedDuringRun(options, context, after)) {
        return { execution: { ...execution, status: "stale", reason: "Inputs changed during execution; a new plan is required" }, outcome: { exec_ms, post_ms, denied: "stale-inputs" } };
    }
    const certified = withArtifacts(options, { ...execution, runtimeVerified: true });
    if (execution.status === "passed" && base.plan.reusable) {
        const details = { identity: context.key, platform: platformIdentity(), toolchain: toolchainIdentity(options.root), stages: { exec_ms, post_ms }, ...(certified.artifacts ? { artifacts: certified.artifacts, artifactRoot: options.root } : {}) };
        writeTestReceipt(options.root, context.key, execution, details, options.receiptStore);
    }
    return { execution: certified, outcome: { exec_ms, post_ms, denied: "no-receipt" } };
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
