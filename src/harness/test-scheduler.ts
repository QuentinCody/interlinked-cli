import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hasErrorCode } from "./check-engine/tool-errors.js";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { collectRepositoryInventory, hashBytes } from "../lib/metrics/inventory.js";
import { receiptStorePath } from "./test-run-receipt.js";
import { acquireCrossProcessCompilerLease, tryAcquireCrossProcessCompilerLease, canonicalProjectRoot, type CrossProcessCompilerLease } from "./project-compiler-lock.js";
import { tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { acquireTestCapacity, tryAcquireForegroundCapacity } from "./test-capacity.js";
import { loadTestPlan, normalizeTestInput, readTestDependencies } from "./test-plan-inputs.js";
import { captureKnownTestInputs, changedKnownTestInputs } from "./test-runtime.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import { observeTestRun } from "./test-run-observation.js";
import { completedObligation, publishTestCompletion, readTestCompletion, retractTestCompletion } from "./test-request-completion.js";
import { executeTestPlan } from "./test-execution.js";
import { completeTestRequests, hasTestRequest, pendingRequestsMet, pendingTests, recordRequeue, requestTests, subscribeTestRequest, unsubscribeTestRequest, type PendingTests, type RunRequirements } from "./test-requests.js";
import { resolveRequest } from "./test-request-resolution.js";
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
    /** Opt into classifier-based omission and result reuse (off by default; see TestPlanInput.staticSelection). */
    staticSelection?: boolean;
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
    /** Collect coverage into the run directory (part of the check identity); `reporters` are extra vitest reporter module paths. */
    coverage?: { reporters?: string[] };
    /** Receipt + run-artifact store to read and write instead of `<root>/.interlinked/test-runs`. */
    receiptStore?: string;
}
interface ScheduledRequest extends ScheduleTestsOptions { requestId: string; }
/** Lease-wait facts a drain hands to each batch so the executor's row carries them. */
interface DrainTiming { queuedAt: number; waitCapacityMs: number; }
const active = new Map<string, Promise<TestExecution>>();

/** What this caller's request must PRODUCE (coverage) — recorded on the durable request so coalescing and completion honour it. */
function requirementsOf(options: ScheduleTestsOptions): RunRequirements {
    const selection: RunRequirements = options.staticSelection === true ? { staticSelection: true } : {};
    return options.coverage ? { ...selection, coverage: { reporters: [...(options.coverage.reporters ?? [])].sort() } } : selection;
}

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

/** The harness's own state and git's: the scheduler itself writes under `.interlinked/` while a run executes. */
const HARNESS_STATE = /^(?:\.interlinked|\.git)(?:\/|$)/;

/**
 * Non-input paths (excluded by role: `.claude/`, scratch, fixtures outside src) that appeared or vanished while the
 * run executed — a test wrote into the checkout. Inputs are `changedDuring`'s business; these never make a run
 * stale, but a learned `.claude/settings.json` or a fixture root left in the tree is pollution worth naming.
 */
function checkoutWritesDuring(before: CheckoutSnapshot, after: CheckoutSnapshot): string[] {
    const inputs = new Set([...before.files, ...after.files].map(file => file.path));
    const earlier = before.checkout, later = after.checkout;
    return [...new Set([...earlier, ...later])].filter(path => earlier.has(path) !== later.has(path) && !HARNESS_STATE.test(path) && !inputs.has(path)).sort();
}

/**
 * Untracked and IGNORED entries of the checkout. `--ignored=matching` lists an ignored file inside a non-ignored
 * directory by name (a learned `.claude/settings.json` under `.claude/*`) and collapses a wholly ignored directory
 * to one entry (`scratch/`), so the snapshot stays cheap on a large tree. Outside git, the inventory's role-excluded
 * paths stand in (the walk skips dot-directories, so it sees less).
 */
function checkoutEntries(root: string, inventory: ReturnType<typeof collectRepositoryInventory>): Set<string> {
    try {
        const status = execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"],
            { cwd: root, encoding: "utf8", timeout: CHECKOUT_STATUS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        return new Set(status.split("\0").filter(entry => entry.startsWith("?? ") || entry.startsWith("!! ")).map(entry => entry.slice(3).replace(/\/$/, "")));
    } catch (error) {
        // Not a repository (git exits non-zero) or no git binary: fall back; anything else is a real failure.
        const exited = typeof error === "object" && error !== null && typeof Reflect.get(error, "status") === "number";
        if (!exited && !hasErrorCode(error, "ENOENT")) throw error;
        return new Set(inventory.excluded.map(entry => entry.path));
    }
}

const CHECKOUT_STATUS_TIMEOUT_MS = 15_000;
type CheckoutSnapshot = ReturnType<typeof collectRepositoryInventory> & { checkout: Set<string> };

/** The inventory plus the checkout's non-input entries, taken together before and after a batch. */
function snapshotCheckout(root: string): CheckoutSnapshot {
    const inventory = collectRepositoryInventory(root);
    return Object.assign(inventory, { checkout: checkoutEntries(root, inventory) });
}

/**
 * What changed while a batch executed: the INPUTS that changed (the batch is stale and re-runs) are returned; the
 * non-input checkout writes are recorded on the result itself (`checkoutWrites`), never as staleness.
 */
function observeRunChanges(root: string, before: CheckoutSnapshot, known: ReturnType<typeof captureKnownTestInputs>, result: TestExecution): string[] {
    const after = snapshotCheckout(root);
    const writes = checkoutWritesDuring(before, after);
    if (writes.length) result.checkoutWrites = writes;
    return [...changedDuring(before, after), ...changedKnownTestInputs(root, known)];
}

const NAMED_PATHS = 10;

/**
 * The stale reason, naming what changed ("a, b (+3 more)"): a test that rewrites an input on every run otherwise
 * reads as an endless, anonymous stale loop. Enough paths to find the writer without flooding a hook line.
 */
export function staleInputsReason(changed: readonly string[]): string {
    const paths = [...new Set(changed)].sort();
    const shown = paths.slice(0, NAMED_PATHS).join(", ");
    return `Inputs changed during execution: ${paths.length > NAMED_PATHS ? `${shown} (+${paths.length - NAMED_PATHS} more)` : shown}`;
}

function overBudget(plan: TestPlan, options: ScheduleTestsOptions): TestExecution | null {
    if (options.maxTests === undefined || (plan.mode !== "full" && plan.tests.length <= options.maxTests)) return null;
    const scope = plan.mode === "full" ? "the full suite" : `${plan.tests.length} tests`;
    return { plan, status: "deferred", runId: "", reused: false, durationMs: 0, output: "", reason: `Plan needs ${scope}; hook budget is ${options.maxTests}. Request retained for interlinked tests run.` };
}

/** The requests one passing batch discharges: its own, plus later ones its scope covers — but never one that required more than the batch PRODUCED (coverage). */
function satisfiedRequests(root: string, batch: PendingTests): string[] {
    const current = pendingTests(root), paths = new Set(batch.paths);
    const met = new Set(pendingRequestsMet(root, batch.requirements));
    const scopeCovered = (current.full && !batch.full) ? batch.ids : current.paths.every(path => paths.has(path)) ? current.ids : batch.ids;
    return scopeCovered.filter(id => met.has(id));
}

/** Input drift cannot turn a failed/deferred execution into an automatic retry. */
function withInputChange(result: TestExecution, reason: string): TestExecution {
    const status = result.status === "failed" || result.status === "deferred" ? result.status : "stale";
    return { ...result, status, reason: [result.reason, reason].filter(Boolean).join("; ") };
}

async function runOneBatch(options: ScheduleTestsOptions, deadline: number, timing: DrainTiming): Promise<TestExecution> {
    const pending = pendingTests(options.root), before = snapshotCheckout(options.root);
    const environmentHash = captureVitestEnvironment().environmentHash;
    const known = captureKnownTestInputs(options.root, [...pending.paths, ...Object.values(readTestDependencies(options.root)).flat(), ".interlinked/test-dependencies.json"]);
    // The batch selects only when EVERY pending request permitted it (durable requirement), never by this drainer's own flag.
    const plan = await loadTestPlan(options.root, pending.paths, Math.max(1, deadline - Date.now()), pending.full,
        { staticSelection: pending.requirements.staticSelection === true });
    const deferred = overBudget(plan, options);
    if (deferred) {
        recordSchedulerDeferral(options, "budget-exceeded", timing, plan.mode);
        return deferred;
    }
    // The batch PRODUCES what every pending request requires (coverage with the union of their reporters), not only what this drain's caller asked for.
    const produced = pending.requirements;
    const result = await executeTestPlan(plan, {
        root: options.root, deadline, stage: options.stage ?? "cli", dryRun: options.dryRun === true, queuedAt: timing.queuedAt, waitCapacityMs: timing.waitCapacityMs,
        ...(options.maxWorkers === undefined ? {} : { maxWorkers: options.maxWorkers }), ...(options.session ? { session: options.session } : {}),
        ...(produced.coverage ? { coverage: produced.coverage } : {}), ...(options.receiptStore ? { receiptStore: options.receiptStore } : {}),
    });
    const changed = observeRunChanges(options.root, before, known, result);
    if (captureVitestEnvironment().environmentHash !== environmentHash) {
        requestTests(options.root, [], true, produced);
        return withInputChange(result, "Environment changed during execution; current inputs remain unverified");
    }
    if (changed.length) requestTests(options.root, changed, false, produced);
    if (result.status === "stale") requestTests(options.root, [], true, produced);
    if ((result.status === "passed" || result.status === "empty") && changed.length === 0) {
        const ids = satisfiedRequests(options.root, pending);
        publishTestCompletion(options.root, ids, result, { inputHash: before.inputHash, environmentHash, known });
        completeTestRequests(options.root, ids);
    }
    // Name what changed: a test that rewrites an input on every run otherwise reads as an endless, anonymous stale loop.
    return changed.length ? withInputChange(result, `${staleInputsReason(changed)}; current inputs remain unverified`) : result;
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
    const completed = await readTestCompletion(options.root, resolveRequest(options.root, options.requestId).id, deadline);
    if (completed || pendingTests(options.root).ids.length === 0) {
        next.release();
        return { done: completed ?? previous };
    }
    return { leases: next, timing: { queuedAt: boundary, waitCapacityMs: next.waitedMs } };
}

async function settledBatch(result: TestExecution, options: ScheduledRequest, deadline: number): Promise<TestExecution | null> {
    if (result.status === "deferred" || result.status === "failed" || pendingTests(options.root).ids.length === 0) return result;
    if (result.status !== "passed" && result.status !== "empty") return null;
    // A retired request is answered by its REPLACEMENT's completion, not by whatever later batch the drain runs next.
    return readTestCompletion(options.root, resolveRequest(options.root, options.requestId).id, deadline);
}

/** Runs until this caller completes, yielding every lease between necessary retries. Later requests keep their own queue entries and deadlines. */
async function runPending(options: ScheduledRequest, deadline: number, signal: AbortSignal, first: BatchLeases, queuedAt: number): Promise<TestExecution> {
    let leases: BatchLeases | null = first;
    let timing: DrainTiming = { queuedAt, waitCapacityMs: first.waitedMs };
    try {
        for (;;) {
            const result = await runOneBatch(options, deadline, timing);
            if (result.runId) observeTestRun(options.root, result);
            const completed = await settledBatch(result, options, deadline);
            if (completed) return completed;
            // Keep the last batch's own reason: it names WHAT changed, which is how a self-rewriting test is found.
            if (Date.now() >= deadline) return { ...result, status: "stale", reason: `Newer inputs remain queued; previous result does not certify them${result.reason ? ` (${result.reason})` : ""}` };
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
        const completed = await readTestCompletion(options.root, resolveRequest(options.root, options.requestId).id, deadline);
        if (completed) {
            owner.release();
            return completed;
        }
        if (!hasTestRequest(options.root, options.requestId)) requeueRejectedCompletion(options);
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

/**
 * The caller's request is gone and its completion no longer matches the inputs: queue the obligation again and hand it
 * on WITH EVIDENCE, so every waiter on the old id resolves to the new one (review 2026-10-06: the requeued id was
 * discarded, the waiter kept checking the stale completion and returned `deferred` after a passing run). The audit
 * row is written first; only then is the stale completion pointer retracted, so a failed audit write leaves the old
 * evidence and the waiter fails closed.
 */
function requeueRejectedCompletion(options: ScheduledRequest): void {
    // Work on the RESOLVED id: when another process retired this caller's request A into B and B's completion went
    // stale, the evidence (obligation, pointer) is B's, and B is what every waiter follows (review 2026-10-07).
    const resolution = resolveRequest(options.root, options.requestId);
    if (resolution.state === "pending") return;
    const staleId = resolution.id;
    // The SHARED request's obligation, kept by its completion pointer: a weaker caller coalesced onto it (a plain caller
    // onto a coverage request, an opt-in caller onto a default one) must not requeue only its own subset, because every
    // waiter on the old id will accept the replacement (review 2026-10-06).
    const original = resolution.state === "completed" ? completedObligation(options.root, staleId) : null;
    if (!original) {
        // No recorded obligation (an older pointer, or unreadable): queue this caller's own need but redirect nobody —
        // the old id stays unresolved for the others, so they fail closed rather than accept a weaker run.
        requestTests(options.root, options.paths, options.full === true, requirementsOf(options));
        return;
    }
    const paths = [...new Set([...original.paths, ...options.paths])], full = original.full || options.full === true;
    const replacement = requestTests(options.root, paths, full, original.requirements);
    if (replacement === staleId) return;
    if (recordRequeue(options.root, staleId, replacement, paths, full)) retractTestCompletion(options.root, staleId);
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
    const followed = new Set<string>();
    try {
        for (;;) {
            const result = await withinDeadline(startDrain(options), deadline);
            if (result.status !== "passed" && result.status !== "empty") return result;
            // Positive evidence only: this caller's obligation (possibly carried by a replacement) must be COMPLETED,
            // with a fresh completion record — a pass from some other batch never answers it.
            const resolution = resolveRequest(options.root, id);
            for (const hop of resolution.hops) if (!followed.has(hop)) { subscribeTestRequest(hop); followed.add(hop); }
            if (resolution.state === "unresolved") return { ...result, status: "deferred", reason: `Request state unresolved (${resolution.reason}); no pass is certified for it` };
            if (resolution.state === "completed") {
                const completion = await readTestCompletion(options.root, resolution.id, deadline);
                return completion ?? { ...result, status: "deferred", reason: "The completion record no longer matches the current inputs; the request is not certified" };
            }
            if (Date.now() >= deadline) return { ...result, status: "deferred", reason: "This request arrived after the run; it remains queued" };
            options.timeoutMs = Math.max(1, deadline - Date.now());
        }
    } finally {
        for (const followedId of followed) unsubscribeTestRequest(followedId);
    }
}

async function withinDeadline(run: Promise<TestExecution>, deadline: number): Promise<TestExecution> {
    const timer = new AbortController();
    try {
        return await Promise.race([run, setTimeout(Math.max(1, deadline - Date.now()), undefined, { signal: timer.signal })
            .then(() => { throw new Error("Test request deadline exhausted; work remains queued"); })]);
    } finally { timer.abort(); }
}

/**
 * A shared run's artifacts live in the PRODUCING drain's store. Each subscriber gets its own copy — same run-relative
 * paths, bytes verified against the receipt's sha256 — so its store is self-contained and its export never depends on
 * another caller's store surviving. A copy that cannot be verified leaves the result pointing at the producer's store.
 */
function materializeArtifacts(options: ScheduleTestsOptions, result: TestExecution): TestExecution {
    const own = receiptStorePath(options.root, options.receiptStore);
    if (!result.artifacts || !result.artifactStore || result.artifactStore === own) return result;
    for (const artifact of Object.values(result.artifacts)) {
        const source = join(result.artifactStore, artifact.path), target = join(own, artifact.path);
        try {
            const bytes = readFileSync(source);
            if (hashBytes(bytes) !== artifact.sha256) return result;
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, bytes);
        } catch {
            return result;
        }
    }
    return { ...result, artifactStore: own };
}

export function scheduleTests(options: ScheduleTestsOptions): Promise<TestExecution> {
    // Input validation and queueing stay synchronous: a bad input throws before any durable work exists.
    const root = canonicalProjectRoot(options.root);
    const paths = [...new Set(options.paths.map(path => normalizeTestInput(root, path)))];
    const id = requestTests(root, paths, options.full === true, requirementsOf(options));
    // While this caller awaits the request, a wider request may not retire it; the covering run still satisfies it.
    subscribeTestRequest(id);
    return awaitOwnRequest({ ...options, root, paths, requestId: id }, id).then(result => materializeArtifacts({ ...options, root }, result)).finally(() => unsubscribeTestRequest(id));
}
