import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduleTests } from "./test-scheduler.js";
import { pendingTests, completeTestRequests, requestTests } from "./test-requests.js";
import { currentProcessSignal } from "./check-engine/process-cancellation.js";
import { executeTestPlan } from "./test-execution.js";
import { loadTestPlan } from "./test-plan-inputs.js";
import { tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { acquireTestCapacity, tryAcquireForegroundCapacity } from "./test-capacity.js";
import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./project-compiler-lock.js";
import { publishTestCompletion } from "./test-request-completion.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { captureKnownTestInputs } from "./test-runtime.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";

vi.mock("./test-execution.js", () => ({ executeTestPlan: vi.fn() }));
// Unmocked by default (returns undefined, so the scheduler polls); the abort pin installs a real signal.
vi.mock("./check-engine/process-cancellation.js", () => ({ currentProcessSignal: vi.fn() }));
vi.mock("./test-plan-inputs.js", async importOriginal => ({ ...await importOriginal<typeof import("./test-plan-inputs.js")>(), loadTestPlan: vi.fn(), readTestDependencies: () => ({}) }));
const roots: string[] = [];
// The pre-push hook exports INTERLINKED_STAGES_LEDGER; an inherited override would redirect the fixture's rows, so pin the default path.
beforeEach(() => { vi.stubEnv("INTERLINKED_STAGES_LEDGER", ""); });
afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "test-scheduler-")); roots.push(root);
    writeFileSync(join(root, "a.ts"), "export const a = 1;");
    vi.mocked(loadTestPlan).mockImplementation(async (_root, paths) => ({ version: 1, snapshot: "snapshot", changedPaths: [...paths], mode: "selected", tests: [{ path: "a.test.ts", reasons: ["changed"], durationMs: null }], omitted: [], reasons: [], estimatedSerialMs: null, reusable: true }));
    vi.mocked(executeTestPlan).mockImplementation(async plan => ({ plan, status: "passed", runId: "run", reused: false, durationMs: 1, reason: "", output: "" }));
    return root;
}
it("combines nearby requests and shares one applicable execution", async () => {
    const root = fixture();
    const first = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    const second = scheduleTests({ root, paths: ["a.test.ts"], timeoutMs: 2000 });
    const result = await first;
    expect((await second).runId).toBe(result.runId);
    expect(result.plan.changedPaths).toEqual(["a.test.ts", "a.ts"]);
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).paths).toEqual([]);
});
it("reruns newer source bytes instead of returning the older passing result", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "a.ts"), "export const a = 2;");
        return { plan, status: "passed", runId: "old", reused: false, durationMs: 1, reason: "", output: "" };
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    expect(result.runId).toBe("run");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
});

it("shares an opaque run with an identical request arriving while it executes", async () => {
    const root = fixture();
    let subscriber: Promise<Awaited<ReturnType<typeof scheduleTests>>> | undefined;
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        subscriber = scheduleTests({ root, paths: [join(root, "a.ts")], timeoutMs: 2000 });
        return { plan, status: "passed", runId: "shared", reused: false, durationMs: 1, reason: "", output: "" };
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    expect((await subscriber)?.runId).toBe(result.runId);
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).ids).toEqual([]);
});

it("retains every request after a failed run", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => ({ plan, status: "failed", runId: "failed", reused: false, durationMs: 1, reason: "", output: "assertion failed" }));
    expect((await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 })).status).toBe("failed");
    expect(pendingTests(root).paths).toEqual(["a.ts"]);
});

it("rejects inputs outside the project before adding durable work", () => {
    const root = fixture();
    expect(() => scheduleTests({ root, paths: ["../outside.ts"], timeoutMs: 2000 })).toThrow("outside project");
    expect(pendingTests(root).ids).toEqual([]);
});

it("reruns an edited fixture excluded from the source-role inventory", async () => {
    const root = fixture();
    writeFileSync(join(root, "sample.txt"), "before");
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "sample.txt"), "after");
        return { plan, status: "passed", runId: "old-fixture", reused: false, durationMs: 1, reason: "", output: "" };
    });
    const result = await scheduleTests({ root, paths: ["sample.txt"], timeoutMs: 2000 });
    expect(result.runId).toBe("run");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
});

it("retains a hook request immediately when the project slot is occupied", async () => {
    const root = fixture(), release = tryAcquireProjectHeavyProcessLease(root);
    if (!release) throw new Error("Fixture lease unavailable");
    try {
        await expect(scheduleTests({ root, paths: ["a.ts"], timeoutMs: 60_000, waitForCapacity: false, stage: "edit" }))
            .rejects.toThrow("Project check capacity busy");
        expect(executeTestPlan).not.toHaveBeenCalled();
        expect(pendingTests(root).paths).toEqual(["a.ts"]);
        // test-contract: public-api — a retained request is a ledger row that names capacity, not a failed check
        expect(stageRows(root)).toMatchObject([{ stage: "edit", check: "vitest:selected", status: "deferred", reused: false, reuse_denied_reason: "capacity-timeout" }]);
    } finally { release(); }
}, 2000);

/** Rows the scheduler wrote for this fixture (the executor is mocked here, so only scheduler rows appear). */
function stageRows(root: string): Array<Record<string, unknown>> {
    const path = join(root, ".interlinked", "verification-stages.jsonl");
    // SAFETY: the fixture's ledger is written only by recordVerificationStage, one JSON object per line.
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
}

// test-contract: invariant — the executor's row carries the stage, the queue mark and the lease wait the scheduler measured
it("hands the stage, queue mark and lease wait to the executor", async () => {
    const root = fixture();
    await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000, stage: "edit", session: "s1" });
    const options = vi.mocked(executeTestPlan).mock.calls[0]?.[1];
    expect(options).toMatchObject({ stage: "edit", dryRun: false, session: "s1" });
    expect(typeof options?.queuedAt).toBe("number");
    expect(options?.waitCapacityMs).toBeGreaterThanOrEqual(0);
});

// test-contract: public-api — a hook-budget deferral is recorded as budget-exceeded before any executor runs
it("records a budget-exceeded row when the plan exceeds the hook budget", async () => {
    const root = fixture();
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000, maxTests: 0, stage: "edit" });
    expect(result.status).toBe("deferred");
    expect(executeTestPlan).not.toHaveBeenCalled();
    expect(stageRows(root)).toMatchObject([{ stage: "edit", check: "vitest:selected", status: "deferred", reuse_denied_reason: "budget-exceeded" }]);
    expect(typeof stageRows(root)[0]?.wait_capacity_ms).toBe("number");
});

// test-contract: invariant — timings are per batch: a batch queued by a mid-run edit carries its own queue mark and its own (re-acquired) lease wait
it("gives a second batch its own queue mark and its own lease wait", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "a.ts"), "export const a = 2;");
        await new Promise(resolve => global.setTimeout(resolve, 25));
        return { plan, status: "passed", runId: "first", reused: false, durationMs: 25, reason: "", output: "" };
    });
    await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000, stage: "edit" });
    const calls = vi.mocked(executeTestPlan).mock.calls;
    expect(calls).toHaveLength(2);
    const [first, second] = [calls[0]?.[1], calls[1]?.[1]];
    expect(first?.waitCapacityMs).toBeGreaterThanOrEqual(0);
    expect(typeof second?.waitCapacityMs).toBe("number");
    // The first batch slept 25 ms (a duration under test, not a wait for a condition); timer granularity allows a few ms of slack.
    expect(second?.queuedAt).toBeGreaterThanOrEqual((first?.queuedAt ?? 0) + 20);
    expect(second?.waitCapacityMs).toBeGreaterThanOrEqual(0);
});

/**
 * A second "process" that tries to take the given leases while a drain runs. It records how many batches the drain
 * had executed at the moment it got in, holds briefly, and releases. Polling tryAcquire is the cross-process shape:
 * a foreign process cannot observe this process's promise state, only the on-disk leases.
 */
async function interposeAtBatchBoundary(tryAcquire: () => (() => void) | null, deadlineMs: number): Promise<{ batchesSeen: number }> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        const release = tryAcquire();
        if (release) {
            const batchesSeen = vi.mocked(executeTestPlan).mock.calls.length;
            await new Promise(resolve => global.setTimeout(resolve, 30));
            release();
            return { batchesSeen };
        }
        if (Date.now() >= deadline) throw new Error("Interposer never acquired the leases");
        await new Promise(resolve => global.setTimeout(resolve, 1));
    }
}

/** A drain whose first batch queues a second one (an edit lands mid-run) and takes long enough for an interposer to poll. */
function twoBatchDrain(root: string): Promise<Awaited<ReturnType<typeof scheduleTests>>> {
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        if (vi.mocked(executeTestPlan).mock.calls.length === 1) writeFileSync(join(root, "a.ts"), "export const a = 2;");
        await new Promise(resolve => global.setTimeout(resolve, 40));
        return { plan, status: "passed", runId: `run-${vi.mocked(executeTestPlan).mock.calls.length}`, reused: false, durationMs: 40, reason: "", output: "" };
    });
    return scheduleTests({ root, paths: ["a.ts"], timeoutMs: 10_000, stage: "edit" });
}

// test-contract: invariant — a SAME-ROOT caller in another process gets the scheduler and project leases at a batch boundary, not after the whole drain
it("yields the scheduler and project leases to a same-root caller between batches", async () => {
    const root = fixture();
    const drain = twoBatchDrain(root);
    const sameRoot = (): (() => void) | null => {
        const owner = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
        if (!owner) return null;
        const project = tryAcquireProjectHeavyProcessLease(root);
        if (!project) {
            owner.release();
            return null;
        }
        return () => {
            project();
            owner.release();
        };
    };
    // Poll only once the first batch is executing, so the interposer cannot win before the drain ever started.
    await vi.waitFor(() => expect(executeTestPlan).toHaveBeenCalledTimes(1));
    const { batchesSeen } = await interposeAtBatchBoundary(sameRoot, 5000);
    expect(batchesSeen).toBe(1);
    const result = await drain;
    expect(result.status).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
});

// test-contract: invariant — a FOREGROUND waiter from ANOTHER root (a pre-push export blocking at the priority gate) gets the host slot at a batch boundary
it("yields the host test slot to another root's foreground waiter between batches", async () => {
    const root = fixture();
    const drain = twoBatchDrain(root);
    await vi.waitFor(() => expect(executeTestPlan).toHaveBeenCalledTimes(1));
    // The real pre-push shape: block on the priority gate and then the host slot, exactly as runResourceCommand does.
    const lease = await acquireTestCapacity("foreground", Date.now() + 5000, new AbortController().signal);
    if (!lease) throw new Error("Foreground waiter never acquired the host slot");
    const batchesSeen = vi.mocked(executeTestPlan).mock.calls.length;
    lease.release();
    expect(batchesSeen).toBe(1);
    expect((await drain).status).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
});

// test-contract: invariant — even a non-blocking poller from another root gets the host slot inside the yield window
it("leaves the host slot free for a polling caller between batches", async () => {
    const root = fixture();
    const drain = twoBatchDrain(root);
    await vi.waitFor(() => expect(executeTestPlan).toHaveBeenCalledTimes(1));
    const { batchesSeen } = await interposeAtBatchBoundary(() => {
        const lease = tryAcquireForegroundCapacity();
        return lease ? () => lease.release() : null;
    }, 5000);
    expect(batchesSeen).toBe(1);
    expect((await drain).status).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
});

// test-contract: invariant — a request that gains a freshness path DURING a run is never discharged by that run; the drain runs it next
it("does not complete an in-flight obligation that a mid-run request extended", async () => {
    const root = fixture();
    writeFileSync(join(root, "sample.txt"), "before");
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "sample.txt"), "after");
        requestTests(root, ["sample.txt"], false);
        return { plan, status: "passed", runId: "old", reused: false, runtimeVerified: false, durationMs: 1, reason: "", output: "" };
    });
    const result = await scheduleTests({ root, paths: [], full: true, timeoutMs: 5000 });
    expect(result.runId).toBe("run");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
    expect(pendingTests(root).ids).toEqual([]);
});

// test-contract: invariant — cancelling a caller while it waits for the host slot releases the project and scheduler slots it already held
it("releases the project and scheduler leases when host admission is aborted", async () => {
    const root = fixture();
    const controller = new AbortController();
    vi.mocked(currentProcessSignal).mockReturnValue(controller.signal);
    const host = tryAcquireForegroundCapacity();
    if (!host) throw new Error("Fixture host slot unavailable");
    try {
        const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000 });
        const rejection = expect(waiting).rejects.toThrow();
        await vi.waitFor(() => {
            const project = tryAcquireProjectHeavyProcessLease(root);
            if (project) {
                project();
                throw new Error("Scheduler has not acquired the project slot yet");
            }
        });
        controller.abort();
        await rejection;
        const project = tryAcquireProjectHeavyProcessLease(root);
        expect(project).not.toBeNull();
        project?.();
        const owner = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
        expect(owner).not.toBeNull();
        owner?.release();
    } finally { host.release(); }
});

// test-contract: invariant — a dry run must not move any ledger
it("writes no scheduler row for a dry run", async () => {
    const root = fixture();
    await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000, maxTests: 0, stage: "edit", dryRun: true });
    expect(stageRows(root)).toEqual([]);
});

async function completedByAnotherOwner(root: string): Promise<Awaited<ReturnType<typeof scheduleTests>>> {
    const requests = pendingTests(root), plan = await loadTestPlan(root, requests.paths, 1000);
    const result = { plan, status: "passed" as const, runId: "other-owner", reused: false, durationMs: 1, reason: "Fresh run", output: "" };
    publishTestCompletion(root, requests.ids, result, { inputHash: collectRepositoryInventory(root).inputHash,
        environmentHash: captureVitestEnvironment().environmentHash, known: captureKnownTestInputs(root, ["a.ts", "sample.txt"]) });
    completeTestRequests(root, requests.ids);
    return result;
}

it("consumes another owner's completion without starting a second runner", async () => {
    const root = fixture(), owner = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
    if (!owner) throw new Error("Fixture scheduler lease unavailable");
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    try {
        await completedByAnotherOwner(root);
    } finally { owner.release(); }
    const result = await waiting;
    expect(result.runId).toBe("other-owner");
    expect(result.shared).toBe(true);
    expect(executeTestPlan).not.toHaveBeenCalled();
    // test-contract: invariant — consuming a shared completion releases the scheduler slot; the next drain must be able to take it
    const reacquired = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
    expect(reacquired).not.toBeNull();
    reacquired?.release();
});

it.each(["a.ts", "sample.txt"])("refuses another owner's completion after %s changes", async path => {
    const root = fixture(), owner = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
    if (!owner) throw new Error("Fixture scheduler lease unavailable");
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    try {
        await completedByAnotherOwner(root);
        writeFileSync(join(root, path), "new input");
    } finally { owner.release(); }
    expect((await waiting).runId).toBe("run");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
});
