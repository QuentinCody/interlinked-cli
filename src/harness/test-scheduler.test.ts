import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { scheduleTests } from "./test-scheduler.js";
import { pendingTests, completeTestRequests } from "./test-requests.js";
import { executeTestPlan } from "./test-execution.js";
import { loadTestPlan } from "./test-plan-inputs.js";
import { tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./project-compiler-lock.js";
import { publishTestCompletion } from "./test-request-completion.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { captureKnownTestInputs } from "./test-runtime.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";

vi.mock("./test-execution.js", () => ({ executeTestPlan: vi.fn() }));
vi.mock("./test-plan-inputs.js", async importOriginal => ({ ...await importOriginal<typeof import("./test-plan-inputs.js")>(), loadTestPlan: vi.fn(), readTestDependencies: () => ({}) }));
const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
        await expect(scheduleTests({ root, paths: ["a.ts"], timeoutMs: 60_000, waitForCapacity: false }))
            .rejects.toThrow("Project check capacity busy");
        expect(executeTestPlan).not.toHaveBeenCalled();
        expect(pendingTests(root).paths).toEqual(["a.ts"]);
    } finally { release(); }
}, 2000);

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
