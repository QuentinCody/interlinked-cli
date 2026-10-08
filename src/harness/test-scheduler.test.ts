import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduleTests, staleInputsReason } from "./test-scheduler.js";
import { pendingTests, completeTestRequests, requestTests, type RunRequirements } from "./test-requests.js";
import { currentProcessSignal } from "./check-engine/process-cancellation.js";
import { executeTestPlan } from "./test-execution.js";
import { loadTestPlan } from "./test-plan-inputs.js";
import { tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { acquireTestCapacity, tryAcquireForegroundCapacity } from "./test-capacity.js";
import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./project-compiler-lock.js";
import { publishTestCompletion } from "./test-request-completion.js";
import { collectRepositoryInventory, hashBytes } from "../lib/metrics/inventory.js";
import { captureKnownTestInputs } from "./test-runtime.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";

vi.mock("./test-execution.js", () => ({ executeTestPlan: vi.fn() }));
// Unmocked by default (returns undefined, so the scheduler polls); the abort pin installs a real signal.
vi.mock("./check-engine/process-cancellation.js", () => ({ currentProcessSignal: vi.fn() }));
vi.mock("./test-plan-inputs.js", async importOriginal => ({ ...await importOriginal<typeof import("./test-plan-inputs.js")>(), loadTestPlan: vi.fn(), readTestDependencies: () => ({}) }));
const roots: string[] = [];
// The pre-push hook exports INTERLINKED_STAGES_LEDGER; an inherited override would redirect the fixture's rows, so pin the default path.
// The host-slot pins contend on a PRIVATE slot: the run hosting this file may hold the real one and grant nested leases.
beforeEach(() => {
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", "");
    vi.stubEnv("INTERLINKED_TEST_CAPACITY_SCOPE", `scheduler-test-${process.pid}-${Math.random().toString(16).slice(2)}`);
});
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
// test-contract: invariant — a request file that disappears was either COMPLETED or RETIRED by another process; a retired
// caller follows `superseded.jsonl` to the replacement and returns ITS run, never the earlier pass that did not cover it
// (review 2026-10-06: the waiter returned a selected pass that omitted b.test.ts while the replacement stayed pending)
it("follows a cross-process retirement to the replacement request instead of returning an earlier pass", async () => {
    const root = fixture();
    const dir = join(root, ".interlinked/test-runs/requests");
    let runs = 0;
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        runs += 1;
        if (runs === 1) {
            // Another process enqueues a wider default request and retires the waiting caller's b.ts request into it.
            const waiting = readdirSync(dir).filter(name => name.endsWith(".json")).find(name => JSON.parse(readFileSync(join(dir, name), "utf8")).paths.includes("b.ts"));
            const retiredId = (waiting ?? "").replace(/\.json$/, ""), replacement = "replacement-from-other-process";
            writeFileSync(join(dir, `${replacement}.json`), JSON.stringify({ paths: ["b.ts", "c.ts"], full: false, requirements: {} }));
            rmSync(join(dir, `${retiredId}.json`));
            appendFileSync(join(dir, "superseded.jsonl"), `${JSON.stringify({ ts: "t", id: retiredId, by: replacement, full: false, paths: ["b.ts"] })}\n`);
        }
        return { plan, status: "passed", runId: `run${runs}`, reused: false, durationMs: 1, reason: "", output: "" };
    });
    const first = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 4000 });
    const waiter = scheduleTests({ root, paths: ["b.ts"], timeoutMs: 4000 });
    await first;
    const result = await waiter;
    expect(result.runId).not.toBe("run1");
    expect(result.plan.changedPaths).toEqual(expect.arrayContaining(["b.ts", "c.ts"]));
    expect(pendingTests(root).ids).toEqual([]);
});

// test-contract: invariant — when another process retires the DRAIN OWNER's request A into B, B's completion answers A: the
// drain resolves A→B before its completion lookups, so a later unrelated batch C (here failing) never supplies A's result
// (review 2026-10-06: the drain kept looking up A, ran C, and returned C's failure to A)
it("answers a retired drain owner with its replacement's completion, not a later batch's failure", async () => {
    const root = fixture();
    const dir = join(root, ".interlinked/test-runs/requests");
    let runs = 0;
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        runs += 1;
        // During B's run another process queues unrelated work C.
        if (runs === 1) writeFileSync(join(dir, "c-from-other-process.json"), JSON.stringify({ paths: ["c.ts"], full: false, requirements: {} }));
        return { plan, status: runs === 1 ? "passed" : "failed", runId: `run${runs}`, reused: false, durationMs: 1, reason: "", output: "" };
    });
    const owner = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 4000 });
    // Before the drain reads the queue (it first awaits its leases), another process retires A into B = {a.ts, b.ts}.
    const ownerFile = readdirSync(dir).find(name => name.endsWith(".json")) ?? "";
    const ownerId = ownerFile.replace(/\.json$/, ""), replacement = "b-from-other-process";
    writeFileSync(join(dir, `${replacement}.json`), JSON.stringify({ paths: ["a.ts", "b.ts"], full: false, requirements: {} }));
    appendFileSync(join(dir, "superseded.jsonl"), `${JSON.stringify({ ts: "t", id: ownerId, by: replacement, full: false, paths: ["a.ts"] })}\n`);
    rmSync(join(dir, ownerFile));
    const result = await owner;
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(result.status, result.reason).toBe("passed");
    expect(result.runId).toBe("run1");
});

// test-contract: invariant — a request file removed with NO completion and NO retirement row (the unlink-before-audit window,
// a crashed writer) leaves the caller unresolved: deferred, never the earlier pass (review 2026-10-06)
it("defers a caller whose request vanished without completion or retirement evidence", async () => {
    const root = fixture();
    const dir = join(root, ".interlinked/test-runs/requests");
    let runs = 0;
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        runs += 1;
        if (runs === 1) {
            const waiting = readdirSync(dir).filter(name => name.endsWith(".json")).find(name => JSON.parse(readFileSync(join(dir, name), "utf8")).paths.includes("b.ts"));
            if (waiting) rmSync(join(dir, waiting));
        }
        return { plan, status: "passed", runId: `run${runs}`, reused: false, durationMs: 1, reason: "", output: "" };
    });
    const first = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 4000 });
    const waiter = scheduleTests({ root, paths: ["b.ts"], timeoutMs: 4000 });
    await first;
    const result = await waiter;
    expect(result.status).toBe("deferred");
    expect(result.reason).toMatch(/Request state unresolved/);
});

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

// test-contract: invariant — a run whose inputs changed while it executed is stale, and the reason NAMES what changed, so a test that rewrites the checkout on every run is found by its path instead of an endless "Inputs changed" loop (H6, 2026-10-02)
it("names the inputs that changed during a stale batch, deduplicated, sorted and bounded", () => {
    expect(staleInputsReason(["b.ts", "a.ts", "a.ts"])).toBe("Inputs changed during execution: a.ts, b.ts");
    const many = Array.from({ length: 12 }, (_, index) => `f${String(index).padStart(2, "0")}.ts`);
    expect(staleInputsReason(many)).toBe(`Inputs changed during execution: ${many.slice(0, 10).join(", ")} (+2 more)`);
});

// test-contract: invariant — a run that creates a NON-input file in the checkout (here a learned `.claude/settings.json`) is not stale, but the write is reported by path on the result (H6)
it("reports non-input files a run wrote into the checkout without making it stale", async () => {
    const root = fixture();
    // A real repository that ignores `.claude/*`, as this one does: the inventory never lists it, the status snapshot does.
    writeFileSync(join(root, ".gitignore"), ".claude/*\n.interlinked/\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        mkdirSync(join(root, ".claude"), { recursive: true });
        writeFileSync(join(root, ".claude", "settings.json"), "{}");
        return { plan, status: "passed", runId: "polluting", reused: false, durationMs: 1, reason: "", output: "" };
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    expect(result).toMatchObject({ status: "passed", runId: "polluting", checkoutWrites: [".claude/settings.json"] });
});

it("collapses ignored dependency trees while retaining individual ignored config files", async () => {
    const root = fixture();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n.claude/*\n.interlinked/\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });
        writeFileSync(join(root, "node_modules", "fixture", "index.js"), "module.exports = 1;");
        mkdirSync(join(root, ".claude"), { recursive: true });
        writeFileSync(join(root, ".claude", "settings.json"), "{}");
        return { plan, status: "passed", runId: "dependencies", reused: false, durationMs: 1, output: "", reason: "" };
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    expect(result).toMatchObject({ status: "passed", checkoutWrites: [".claude/settings.json", "node_modules"] });
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
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

// Live reproduction: the recovery cohort passed, but a later scratch-file request
// held its caller until the entire shared queue drained and the deadline expired.
it("returns a completed request without draining unrelated work that arrived during its run", async () => {
    const root = fixture();
    writeFileSync(join(root, "late.txt"), "separate input");
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        requestTests(root, ["late.txt"], false);
        return { plan, status: "passed", runId: "original", reused: false, durationMs: 1, reason: "", output: "" };
    });
    const first = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    expect(first).toMatchObject({ status: "passed", runId: "original" });
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).paths).toEqual(["late.txt"]);
    expect((await scheduleTests({ root, paths: ["late.txt"], timeoutMs: 2000 })).runId).toBe("run");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
    expect(pendingTests(root).ids).toEqual([]);
});

it("does not replace one caller's completed pass with a later subscriber's failure", async () => {
    const root = fixture();
    writeFileSync(join(root, "late.txt"), "separate input");
    let later: Promise<Awaited<ReturnType<typeof scheduleTests>>> | undefined;
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        later = scheduleTests({ root, paths: ["late.txt"], timeoutMs: 2000 });
        return { plan, status: "passed", runId: "original", reused: false, durationMs: 1, reason: "", output: "" };
    }).mockImplementationOnce(async plan => ({ plan, status: "failed", runId: "later", reused: false, durationMs: 1, reason: "later failure", output: "" }));
    expect(await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 })).toMatchObject({ status: "passed", runId: "original" });
    expect(await later).toMatchObject({ status: "failed", runId: "later" });
    expect(pendingTests(root).paths).toEqual(["late.txt"]);
});

it.each(["failed", "deferred"] as const)("returns a %s run without retrying when source inputs also change", async status => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "a.ts"), "export const a = 2;");
        return { plan, status, runId: "unfinished", reused: false, durationMs: 1, reason: "original diagnostic", output: "run output" };
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    expect(result).toMatchObject({ status, runId: "unfinished", output: "run output" });
    expect(result.reason).toContain("original diagnostic");
    expect(result.reason).toContain("Inputs changed during execution: a.ts");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).paths).toEqual(["a.ts"]);
});

it("rejects inputs outside the project before adding durable work", () => {
    const root = fixture();
    expect(() => scheduleTests({ root, paths: ["../outside.ts"], timeoutMs: 2000 })).toThrow("outside project");
    expect(pendingTests(root).ids).toEqual([]);
});

it.each(["failed", "deferred"] as const)("returns a %s run without retrying when its environment changes", async status => {
    const root = fixture();
    vi.stubEnv("SCHEDULER_TEST_INPUT", "before");
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        vi.stubEnv("SCHEDULER_TEST_INPUT", "after");
        return { plan, status, runId: "environment-changed", reused: false, durationMs: 1, reason: "original diagnostic", output: "run output" };
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    expect(result).toMatchObject({ status, runId: "environment-changed", output: "run output" });
    expect(result.reason).toContain("original diagnostic; Environment changed during execution");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root)).toMatchObject({ paths: ["a.ts"], full: true });
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

// test-contract: invariant — a freshness path requested DURING a run is not discharged by that run; its caller receives a separate execution
it("does not complete an in-flight obligation that a mid-run request extended", async () => {
    const root = fixture();
    writeFileSync(join(root, "sample.txt"), "before");
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "sample.txt"), "after");
        requestTests(root, ["sample.txt"], false);
        return { plan, status: "passed", runId: "old", reused: false, runtimeVerified: false, durationMs: 1, reason: "", output: "" };
    });
    const result = await scheduleTests({ root, paths: [], full: true, timeoutMs: 5000 });
    expect(result.runId).toBe("old");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).paths).toEqual(["sample.txt"]);
    const later = await scheduleTests({ root, paths: ["sample.txt"], timeoutMs: 5000 });
    expect(later.runId).toBe("run");
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

// test-contract: invariant — a coverage request that arrives during a plain run is not satisfied by it: the next batch runs WITH coverage and only then discharges it
it("runs a second batch with coverage for a coverage request that a plain run cannot satisfy", async () => {
    const root = fixture();
    let coverageRequest: Promise<Awaited<ReturnType<typeof scheduleTests>>> | null = null;
    vi.mocked(executeTestPlan).mockImplementation(async (plan, options) => {
        if (!coverageRequest) coverageRequest = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000, coverage: { reporters: ["scope.mjs"] } });
        return { plan, status: "passed", runId: options.coverage ? "with-coverage" : "plain", reused: false, durationMs: 1, reason: "", output: "", ...(options.coverage ? { artifacts: { coverage_summary: { path: "x", sha256: "0".repeat(64) } } } : {}) };
    });
    const plain = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000 });
    // The plain caller finishes with its own result; the coverage caller still needs a separate execution.
    expect(plain).toMatchObject({ status: "passed", runId: "plain" });
    const covered = await coverageRequest!;
    expect(covered.runId).toBe("with-coverage");
    expect(covered.artifacts).toBeDefined();
    const calls = vi.mocked(executeTestPlan).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1].coverage).toBeUndefined();
    expect(calls[1]?.[1].coverage).toEqual({ reporters: ["scope.mjs"] });
    expect(pendingTests(root).ids).toEqual([]);
});

// test-contract: invariant — a subscriber with a DIFFERENT receipt store sharing one drain gets the artifacts materialized into its own store (sha256-verified), so its export never depends on the producer's store
it("materializes a shared run's artifacts into each subscriber's own store", async () => {
    const root = fixture();
    const producerStore = join(root, "store-a"), subscriberStore = join(root, "store-b");
    const summary = '{"total":{"lines":{"pct":100}}}';
    vi.mocked(executeTestPlan).mockImplementation(async (plan, options) => {
        const store = options.receiptStore ?? "";
        mkdirSync(join(store, "shared", "coverage"), { recursive: true });
        writeFileSync(join(store, "shared", "coverage", "coverage-summary.json"), summary);
        return { plan, status: "passed", runId: "shared", reused: false, durationMs: 1, reason: "", output: "",
            artifacts: { coverage_summary: { path: "shared/coverage/coverage-summary.json", sha256: hashBytes(Buffer.from(summary)) } }, artifactStore: store };
    });
    const coverage = { reporters: ["scope.mjs"] };
    const first = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000, coverage, receiptStore: producerStore });
    const second = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000, coverage, receiptStore: subscriberStore });
    const [producer, subscriber] = await Promise.all([first, second]);
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(producer.artifactStore).toBe(producerStore);
    expect(subscriber.artifactStore).toBe(subscriberStore);
    expect(subscriber.artifacts).toEqual(producer.artifacts);
    expect(readFileSync(join(subscriberStore, "shared", "coverage", "coverage-summary.json"), "utf8")).toBe(summary);
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
    const result = await waiting;
    expect(result.runId).toBe("run");
    // The fresh run answers the caller: its requeued request carries the obligation (review 2026-10-06: the waiter kept
    // checking the stale completion and returned `deferred`, so `tests run` exited 75 after a passing run).
    expect(result.status, result.reason).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
});

// test-contract: invariant — a handover after a stale completion keeps the SHARED request's full obligation, not only the
// weaker caller's: every waiter on the old id will accept the replacement's result (review 2026-10-06: a plain caller
// dropped coverage, an opt-in caller turned a default request into a selected run)
const handoverCases: Array<[string, RunRequirements, { staticSelection?: boolean }]> = [
    ["coverage required by the shared request", { coverage: { reporters: ["scope.mjs"] } }, {}],
    ["no static selection required by the shared request", {}, { staticSelection: true }],
];
it.each(handoverCases)("keeps %s when a weaker caller hands over a stale completion", async (_label, shared, caller) => {
    const root = fixture(), owner = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
    if (!owner) throw new Error("Fixture scheduler lease unavailable");
    // Another process queued the stronger request first; the weaker caller coalesces onto it.
    requestTests(root, ["a.ts"], false, shared);
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000, ...caller });
    try {
        await completedByAnotherOwner(root);
        writeFileSync(join(root, "a.ts"), "new input");
    } finally { owner.release(); }
    await waiting;
    const options = vi.mocked(executeTestPlan).mock.calls.at(-1)?.[1];
    const planOptions = vi.mocked(loadTestPlan).mock.calls.at(-1)?.[4];
    if (shared.coverage) expect(options?.coverage).toEqual(shared.coverage);
    else expect(planOptions?.staticSelection).toBe(false);
});

// test-contract: invariant — after a cross-process retirement A→B and B's completion going stale, the handover works on the
// RESOLVED id B: it replays B's stored obligation and hands B on, so A's waiter gets the passing rerun (review 2026-10-07:
// the lookup read A, found no pointer, took the legacy fallback and returned `deferred` — CLI exit 75)
it("requeues the resolved request when a retired request's completion goes stale", async () => {
    const root = fixture(), owner = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
    if (!owner) throw new Error("Fixture scheduler lease unavailable");
    const dir = join(root, ".interlinked/test-runs/requests");
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 2000 });
    try {
        // Another process retires A into B (which also requires coverage), completes B, and then a.ts changes.
        const aFile = readdirSync(dir).find(name => name.endsWith(".json")) ?? "";
        const replacement = "b-from-other-process";
        writeFileSync(join(dir, `${replacement}.json`), JSON.stringify({ paths: ["a.ts"], full: false, requirements: { coverage: { reporters: ["scope.mjs"] } } }));
        appendFileSync(join(dir, "superseded.jsonl"), `${JSON.stringify({ ts: "t", id: aFile.replace(/\.json$/, ""), by: replacement, full: false, paths: ["a.ts"] })}\n`);
        rmSync(join(dir, aFile));
        await completedByAnotherOwner(root);
        writeFileSync(join(root, "a.ts"), "new input");
    } finally { owner.release(); }
    const result = await waiting;
    expect(result.status, result.reason).toBe("passed");
    expect(vi.mocked(executeTestPlan).mock.calls.at(-1)?.[1]?.coverage).toEqual({ reporters: ["scope.mjs"] });
});

it("returns another owner's completion at a retry boundary with unrelated work still queued", async () => {
    const root = fixture();
    writeFileSync(join(root, "late.txt"), "later input");
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "a.ts"), "export const a = 2;");
        return { plan, status: "passed", runId: "stale", reused: false, durationMs: 1, output: "", reason: "" };
    });
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000 });
    await vi.waitFor(() => expect(executeTestPlan).toHaveBeenCalledTimes(1), { interval: 5 });
    const owner = await vi.waitFor(() => {
        const lease = tryAcquireCrossProcessCompilerLease(`interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`);
        if (!lease) throw new Error("Waiting for retry boundary");
        return lease;
    }, { interval: 5 });
    try {
        await completedByAnotherOwner(root);
        requestTests(root, ["late.txt"], false);
    } finally { owner.release(); }
    expect((await waiting).runId).toBe("other-owner");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).paths).toEqual(["late.txt"]);
});
