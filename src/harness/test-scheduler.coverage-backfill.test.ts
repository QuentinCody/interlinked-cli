import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentProcessSignal } from "./check-engine/process-cancellation.js";
import { canonicalProjectRoot, tryAcquireCrossProcessCompilerLease } from "./project-compiler-lock.js";
import { executeTestPlan } from "./test-execution.js";
import { loadTestPlan } from "./test-plan-inputs.js";
import { pendingTests } from "./test-requests.js";
import type { TestExecution } from "./test-run-receipt.js";
import { scheduleTests } from "./test-scheduler.js";

vi.mock("./test-execution.js", () => ({ executeTestPlan: vi.fn() }));
vi.mock("./check-engine/process-cancellation.js", () => ({ currentProcessSignal: vi.fn() }));
vi.mock("./test-plan-inputs.js", async importOriginal => ({ ...await importOriginal<typeof import("./test-plan-inputs.js")>(), loadTestPlan: vi.fn(), readTestDependencies: () => ({}) }));

const roots: string[] = [];
beforeEach(() => {
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", "");
    // Contend on a PRIVATE host slot: the run hosting this file may hold the real one.
    vi.stubEnv("INTERLINKED_TEST_CAPACITY_SCOPE", `scheduler-backfill-${process.pid}-${Math.random().toString(16).slice(2)}`);
});
afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "test-scheduler-backfill-"));
    roots.push(root);
    writeFileSync(join(root, "a.ts"), "export const a = 1;");
    vi.mocked(loadTestPlan).mockImplementation(async (_root, paths) => ({ version: 1, snapshot: "snapshot", changedPaths: [...paths], mode: "selected", tests: [{ path: "a.test.ts", reasons: ["changed"], durationMs: null }], omitted: [], reasons: [], estimatedSerialMs: null, reusable: true }));
    return root;
}

function passed(plan: TestExecution["plan"], runId: string): TestExecution {
    return { plan, status: "passed", runId, reused: false, durationMs: 1, reason: "", output: "" };
}

function schedulerKey(root: string): string { return `interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`; }

// test-contract: boundary — a caller whose deadline expires while the run is still executing is rejected with the retained-work message, and the queued request survives for the next drain
it("rejects a caller whose deadline expires during a run and leaves the work queued", async () => {
    const root = fixture();
    let finish: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        await gate;
        return passed(plan, "late");
    });
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 150 });
    const rejection = expect(waiting).rejects.toThrow("Test request deadline exhausted; work remains queued");
    await vi.waitFor(() => expect(executeTestPlan).toHaveBeenCalledTimes(1));
    await rejection;
    // The run keeps going after the caller gave up; let it finish so its leases are released before cleanup.
    finish();
    await vi.waitFor(() => {
        const owner = tryAcquireCrossProcessCompilerLease(schedulerKey(root));
        if (!owner) throw new Error("Scheduler lease still held by the unfinished drain");
        owner.release();
    });
});

// test-contract: boundary — cancelling the process between two batches stops the drain at the boundary: it reports the earlier result as deferred and keeps the newer inputs queued
it("defers instead of starting a second batch when the process is cancelled during the yield", async () => {
    const root = fixture();
    const controller = new AbortController();
    vi.mocked(currentProcessSignal).mockReturnValue(controller.signal);
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        // An edit lands mid-run (queues a second batch) and the process is cancelled before the drain yields its leases.
        writeFileSync(join(root, "a.ts"), "export const a = 2;");
        controller.abort();
        return passed(plan, "first");
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000 });
    expect(result.status).toBe("deferred");
    expect(result.reason).toContain("newer inputs remain queued");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).ids.length).toBeGreaterThan(0);
});
