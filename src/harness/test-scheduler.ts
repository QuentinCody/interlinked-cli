import { setTimeout } from "node:timers/promises";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { acquireCrossProcessCompilerLease, tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./project-compiler-lock.js";
import { tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { acquireTestCapacity, tryAcquireForegroundCapacity } from "./test-capacity.js";
import { loadTestPlan, normalizeTestInput, readTestDependencies } from "./test-plan-inputs.js";
import { captureKnownTestInputs, changedKnownTestInputs } from "./test-runtime.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { observeTestRun } from "./test-run-observation.js";
import { publishTestCompletion, readTestCompletion } from "./test-request-completion.js";
import { executeTestPlan } from "./test-execution.js";
import { completeTestRequests, hasTestRequest, pendingTests, requestTests, type PendingTests } from "./test-requests.js";
import type { TestExecution } from "./test-run-receipt.js";
import type { TestPlan } from "./test-plan.js";

export interface ScheduleTestsOptions { root: string; paths: readonly string[]; timeoutMs: number; full?: boolean; maxWorkers?: number; maxTests?: number; waitForCapacity?: boolean; }
interface ScheduledRequest extends ScheduleTestsOptions { requestId: string; }
const active = new Map<string, Promise<TestExecution>>();

async function acquireProject(options: ScheduleTestsOptions, deadline: number): Promise<(() => void) | null> {
    while (Date.now() < deadline) {
        const release = tryAcquireProjectHeavyProcessLease(options.root);
        if (release) return release;
        if (options.waitForCapacity === false) return null;
        await setTimeout(50);
    }
    return null;
}

function changedDuring(before: ReturnType<typeof collectRepositoryInventory>, after: ReturnType<typeof collectRepositoryInventory>): string[] {
    const hashes = new Map(before.files.map(file => [file.path, file.sha256]));
    const current = new Map(after.files.map(file => [file.path, file.sha256]));
    return [...new Set([...hashes.keys(), ...current.keys()])].filter(path => hashes.get(path) !== current.get(path));
}

function overBudget(plan: TestPlan, options: ScheduleTestsOptions): TestExecution | null {
    if (options.maxTests === undefined || (plan.mode !== "full" && plan.tests.length <= options.maxTests)) return null;
    const scope = plan.mode === "full" ? "the full suite" : `${plan.tests.length} tests`;
    return { plan, status: "deferred", runId: "", reused: false, durationMs: 0, output: "", reason: `Plan needs ${scope}; hook budget is ${options.maxTests}. Request retained for interlinked tests run.` };
}

function satisfiedRequests(root: string, batch: PendingTests): string[] {
    const current = pendingTests(root), paths = new Set(batch.paths);
    if (current.full && !batch.full) return batch.ids;
    return current.paths.every(path => paths.has(path)) ? current.ids : batch.ids;
}

async function runOneBatch(options: ScheduleTestsOptions, deadline: number): Promise<TestExecution> {
    const pending = pendingTests(options.root), before = collectRepositoryInventory(options.root);
    const environmentHash = captureVitestEnvironment().environmentHash;
    const known = captureKnownTestInputs(options.root, [...pending.paths, ...Object.values(readTestDependencies(options.root)).flat(), ".interlinked/test-dependencies.json"]);
    const plan = await loadTestPlan(options.root, pending.paths, Math.max(1, deadline - Date.now()), pending.full);
    const deferred = overBudget(plan, options);
    if (deferred) return deferred;
    const result = await executeTestPlan(plan, { root: options.root, deadline, ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }) });
    const changed = [...changedDuring(before, collectRepositoryInventory(options.root)), ...changedKnownTestInputs(options.root, known)];
    if (captureVitestEnvironment().environmentHash !== environmentHash) {
        requestTests(options.root, [], true);
        return { ...result, status: "stale", reason: "Environment changed during execution" };
    }
    if (changed.length) requestTests(options.root, changed, false);
    if (result.status === "stale") requestTests(options.root, [], true);
    if ((result.status === "passed" || result.status === "empty") && changed.length === 0) {
        const ids = satisfiedRequests(options.root, pending);
        publishTestCompletion(options.root, ids, result, { inputHash: before.inputHash, environmentHash, known });
        completeTestRequests(options.root, ids);
    }
    return changed.length ? { ...result, status: "stale", reason: "Inputs changed during execution" } : result;
}

async function runPending(options: ScheduleTestsOptions, deadline: number): Promise<TestExecution> {
    for (;;) {
        const result = await runOneBatch(options, deadline);
        if (result.runId) observeTestRun(options.root, result);
        if (result.status === "deferred" || result.status === "failed" || pendingTests(options.root).ids.length === 0) return result;
        if (Date.now() >= deadline) return { ...result, status: "stale", reason: "Newer inputs remain queued; previous result does not certify them" };
    }
}

async function drain(options: ScheduledRequest): Promise<TestExecution> {
    const deadline = Date.now() + options.timeoutMs, signal = new AbortController().signal;
    const key = `interlinked-test-scheduler-v1\0${options.root}`, wait = options.waitForCapacity !== false;
    const owner = wait ? await acquireCrossProcessCompilerLease(key, deadline, signal) : tryAcquireCrossProcessCompilerLease(key);
    if (!owner) throw new Error("Test scheduler busy; request retained");
    try {
        const completed = await readTestCompletion(options.root, options.requestId, deadline);
        if (completed) return completed;
        if (!hasTestRequest(options.root, options.requestId)) requestTests(options.root, options.paths, options.full === true);
        const release = await acquireProject(options, deadline);
        if (!release) throw new Error("Project check capacity busy; test request retained");
        try {
            const capacity = wait ? await acquireTestCapacity("foreground", deadline, signal) : tryAcquireForegroundCapacity();
            if (!capacity) throw new Error("Host test capacity busy; request retained");
            try { return await runPending(options, deadline); }
            finally { capacity.release(); }
        } finally { release(); }
    } finally { owner.release(); }
}

/** Same-process callers subscribe to one drain; cross-process callers reconcile durable requests. */
function startDrain(options: ScheduledRequest): Promise<TestExecution> {
    const root = options.root;
    const current = active.get(root);
    if (current) return current;
    const promise = setTimeout(25).then(() => drain({ ...options, root })).finally(() => { active.delete(root); });
    active.set(root, promise);
    return promise;
}

async function awaitOwnRequest(options: ScheduledRequest, id: string): Promise<TestExecution> {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        const result = await withinDeadline(startDrain(options), deadline);
        if (result.status !== "passed" && result.status !== "empty") return result;
        if (!hasTestRequest(options.root, id)) return result;
        if (Date.now() >= deadline) return { ...result, status: "deferred", reason: "This request arrived after the run; it remains queued" };
        options.timeoutMs = Math.max(1, deadline - Date.now());
    }
}

async function withinDeadline(run: Promise<TestExecution>, deadline: number): Promise<TestExecution> {
    const timer = new AbortController();
    try {
        return await Promise.race([run, setTimeout(Math.max(1, deadline - Date.now()), undefined, { signal: timer.signal })
            .then(() => { throw new Error("Test request deadline exhausted; work remains queued"); })]);
    } finally { timer.abort(); }
}

export function scheduleTests(options: ScheduleTestsOptions): Promise<TestExecution> {
    const root = canonicalProjectRoot(options.root);
    const paths = [...new Set(options.paths.map(path => normalizeTestInput(root, path)))];
    const id = requestTests(root, paths, options.full === true);
    return awaitOwnRequest({ ...options, root, paths, requestId: id }, id);
}
