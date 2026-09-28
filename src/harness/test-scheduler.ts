import { setTimeout } from "node:timers/promises";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { acquireCrossProcessCompilerLease, tryAcquireCrossProcessCompilerLease, canonicalProjectRoot, type CrossProcessCompilerLease } from "./project-compiler-lock.js";
import { tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { acquireTestCapacity, tryAcquireForegroundCapacity } from "./test-capacity.js";
import { loadTestPlan, normalizeTestInput, readTestDependencies } from "./test-plan-inputs.js";
import { captureKnownTestInputs, changedKnownTestInputs } from "./test-runtime.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { observeTestRun } from "./test-run-observation.js";
import { publishTestCompletion, readTestCompletion } from "./test-request-completion.js";
import { executeTestPlan } from "./test-execution.js";
import { completeTestRequests, hasTestRequest, pendingTests, requestTests, subscribeTestRequest, unsubscribeTestRequest, type PendingTests } from "./test-requests.js";
import type { TestExecution } from "./test-run-receipt.js";
import type { TestPlan } from "./test-plan.js";
import { currentProcessSignal } from "./check-engine/process-cancellation.js";
import { acquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { elapsedMs, recordVerificationStage, type ReuseDeniedReason, type VerificationStage } from "./verification-stages.js";

export interface ScheduleTestsOptions {
    root: string;
    paths: readonly string[];
    timeoutMs: number;
    full?: boolean;
    maxWorkers?: number;
    maxTests?: number;
    waitForCapacity?: boolean;
    /** Pipeline stage for the ledger rows; hook callers pass `edit`, defaults to `cli`. */
    stage?: VerificationStage;
    /** A dry run never writes the ledger. */
    dryRun?: boolean;
    session?: string;
    /**
     * Host-gate priority. `interactive` (CLI, pre-push) waits at the priority gate and closes admission to
     * background work; `background` (hook-originated, recovery) never blocks a waiting interactive caller.
     * Defaults to `background` for stage `edit`, else `interactive`.
     */
    priority?: "interactive" | "background";
}
interface ScheduledRequest extends ScheduleTestsOptions { requestId: string; }
/** Lease-wait facts a drain hands to each batch so the executor's row carries them. */
interface DrainTiming { queuedAt: number; waitCapacityMs: number; }
const active = new Map<string, Promise<TestExecution>>();

/** A row for work the scheduler refused before any executor ran (budget or capacity); the executor writes its own rows. */
function recordSchedulerDeferral(options: ScheduleTestsOptions, denied: ReuseDeniedReason, timing: DrainTiming, mode: string): void {
    recordVerificationStage(options.root, {
        stage: options.stage ?? "cli", check: `vitest:${mode}`, identity: null, status: "deferred", reused: false, reuse_denied_reason: denied,
        queue_ms: elapsedMs(timing.queuedAt), wait_capacity_ms: timing.waitCapacityMs, ...(options.session ? { session: options.session } : {}),
    }, { dryRun: options.dryRun === true });
}

async function acquireProject(options: ScheduleTestsOptions, deadline: number): Promise<(() => void) | null> {
    const signal = currentProcessSignal();
    if (signal) return options.waitForCapacity === false ? tryAcquireProjectHeavyProcessLease(options.root) : acquireProjectHeavyProcessLease(options.root, deadline, signal);
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

async function runOneBatch(options: ScheduleTestsOptions, deadline: number, timing: DrainTiming): Promise<TestExecution> {
    const pending = pendingTests(options.root), before = collectRepositoryInventory(options.root);
    const environmentHash = captureVitestEnvironment().environmentHash;
    const known = captureKnownTestInputs(options.root, [...pending.paths, ...Object.values(readTestDependencies(options.root)).flat(), ".interlinked/test-dependencies.json"]);
    const plan = await loadTestPlan(options.root, pending.paths, Math.max(1, deadline - Date.now()), pending.full);
    const deferred = overBudget(plan, options);
    if (deferred) {
        recordSchedulerDeferral(options, "budget-exceeded", timing, plan.mode);
        return deferred;
    }
    const result = await executeTestPlan(plan, {
        root: options.root, deadline, stage: options.stage ?? "cli", dryRun: options.dryRun === true, queuedAt: timing.queuedAt, waitCapacityMs: timing.waitCapacityMs,
        ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }), ...(options.session ? { session: options.session } : {}),
    });
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

/** The three leases one batch runs under: this root's scheduler slot, the project's heavy-process slot and the host test slot. */
interface BatchLeases { waitedMs: number; release(): void; }
type Priority = NonNullable<ScheduleTestsOptions["priority"]>;

/** Hook-originated work (stage `edit`) is background by default; a CLI, pre-push or explicit caller is interactive. */
function priorityOf(options: ScheduleTestsOptions): Priority {
    return options.priority ?? (options.stage === "edit" ? "background" : "interactive");
}

function schedulerKey(root: string): string { return `interlinked-test-scheduler-v1\0${root}`; }

async function acquireOwner(options: ScheduleTestsOptions, deadline: number, signal: AbortSignal): Promise<CrossProcessCompilerLease | null> {
    const key = schedulerKey(options.root);
    return options.waitForCapacity === false ? tryAcquireCrossProcessCompilerLease(key) : acquireCrossProcessCompilerLease(key, deadline, signal);
}

/** Project + host slots on top of a held owner lease; a background caller never blocks a waiting interactive one at the host gate. */
async function acquireExecution(options: ScheduleTestsOptions, deadline: number, signal: AbortSignal, owner: CrossProcessCompilerLease): Promise<BatchLeases | string> {
    const started = Date.now();
    const project = await acquireProject(options, deadline);
    if (!project) return "Project check capacity busy; test request retained";
    const kind = priorityOf(options) === "interactive" ? "foreground" : "background";
    let capacity: CrossProcessCompilerLease | null = null;
    try {
        capacity = options.waitForCapacity === false ? tryAcquireForegroundCapacity() : await acquireTestCapacity(kind, deadline, signal);
    } finally {
        // A cancelled host wait (the blocking lease wait throws on abort) must not strand the project slot.
        if (!capacity) project();
    }
    if (!capacity) return "Host test capacity busy; request retained";
    const held = capacity;
    const release = (): void => {
        held.release();
        project();
        owner.release();
    };
    return { waitedMs: elapsedMs(started), release };
}

/** All three leases from nothing — what a drain re-acquires at a batch boundary after yielding. */
async function acquireBatchLeases(options: ScheduleTestsOptions, deadline: number, signal: AbortSignal): Promise<BatchLeases | string> {
    const started = Date.now();
    const owner = await acquireOwner(options, deadline, signal);
    if (!owner) return "Test scheduler busy; request retained";
    let leases: BatchLeases | string | null = null;
    try {
        leases = await acquireExecution(options, deadline, signal, owner);
    } finally {
        if (typeof leases !== "object" || leases === null) owner.release();
    }
    if (typeof leases === "string") return leases;
    return { ...leases, waitedMs: elapsedMs(started) };
}

type BatchTurn = { leases: BatchLeases; timing: DrainTiming } | { done: TestExecution };

/**
 * How long a drain stays out of every lease at a batch boundary. Waiters poll the on-disk leases
 * (25 ms for the scheduler/project leases, 50 ms for background host admission); a release followed
 * by an immediate re-acquire would win every race against them and yield nothing in practice.
 */
const BATCH_YIELD_MS = 60;

/** After yielding every lease: re-acquire for the next batch, or finish with the result another drain produced meanwhile. */
async function nextBatchTurn(options: ScheduledRequest, deadline: number, signal: AbortSignal, previous: TestExecution): Promise<BatchTurn> {
    const boundary = Date.now();
    await setTimeout(BATCH_YIELD_MS, undefined, { signal }).catch(() => undefined);
    const next = await acquireBatchLeases(options, deadline, signal);
    if (typeof next === "string") {
        recordSchedulerDeferral(options, "capacity-timeout", { queuedAt: boundary, waitCapacityMs: elapsedMs(boundary) }, options.full ? "full" : "selected");
        return { done: { ...previous, status: "deferred", reason: `${next}; newer inputs remain queued` } };
    }
    if (pendingTests(options.root).ids.length === 0) {
        next.release();
        return { done: (await readTestCompletion(options.root, options.requestId, deadline)) ?? previous };
    }
    return { leases: next, timing: { queuedAt: boundary, waitCapacityMs: next.waitedMs } };
}

function batchSettles(result: TestExecution, root: string): boolean {
    return result.status === "deferred" || result.status === "failed" || pendingTests(root).ids.length === 0;
}

/** Runs batches until the queue is empty, YIELDING every lease between batches so a same-root interactive caller or another root's push can take the next slot. */
async function runPending(options: ScheduledRequest, deadline: number, signal: AbortSignal, first: BatchLeases, queuedAt: number): Promise<TestExecution> {
    let leases: BatchLeases | null = first;
    let timing: DrainTiming = { queuedAt, waitCapacityMs: first.waitedMs };
    try {
        for (;;) {
            const result = await runOneBatch(options, deadline, timing);
            if (result.runId) observeTestRun(options.root, result);
            if (batchSettles(result, options.root)) return result;
            if (Date.now() >= deadline) return { ...result, status: "stale", reason: "Newer inputs remain queued; previous result does not certify them" };
            leases.release();
            leases = null;
            const turn = await nextBatchTurn(options, deadline, signal, result);
            if ("done" in turn) return turn.done;
            leases = turn.leases;
            timing = turn.timing;
        }
    } finally { leases?.release(); }
}

async function drain(options: ScheduledRequest): Promise<TestExecution> {
    const queuedAt = Date.now(), deadline = queuedAt + options.timeoutMs, signal = currentProcessSignal() ?? new AbortController().signal;
    const busy = (message: string): Error => {
        recordSchedulerDeferral(options, "capacity-timeout", { queuedAt, waitCapacityMs: elapsedMs(queuedAt) }, options.full ? "full" : "selected");
        return new Error(message);
    };
    const owner = await acquireOwner(options, deadline, signal);
    if (!owner) throw busy("Test scheduler busy; request retained");
    let leases: BatchLeases | string;
    try {
        const completed = await readTestCompletion(options.root, options.requestId, deadline);
        if (completed) {
            owner.release();
            return completed;
        }
        if (!hasTestRequest(options.root, options.requestId)) requestTests(options.root, options.paths, options.full === true);
        leases = await acquireExecution(options, deadline, signal, owner);
    } catch (error) {
        owner.release();
        throw error;
    }
    if (typeof leases === "string") {
        owner.release();
        throw busy(leases);
    }
    return runPending(options, deadline, signal, { ...leases, waitedMs: elapsedMs(queuedAt) }, queuedAt);
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
    // Input validation and queueing stay synchronous: a bad input throws before any durable work exists.
    const root = canonicalProjectRoot(options.root);
    const paths = [...new Set(options.paths.map(path => normalizeTestInput(root, path)))];
    const id = requestTests(root, paths, options.full === true);
    // While this caller awaits the request, a wider request may not retire it; the covering run still satisfies it.
    subscribeTestRequest(id);
    return awaitOwnRequest({ ...options, root, paths, requestId: id }, id).finally(() => unsubscribeTestRequest(id));
}
