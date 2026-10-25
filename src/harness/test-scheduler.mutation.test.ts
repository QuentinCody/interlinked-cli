import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduleTests, staleInputsReason } from "./test-scheduler.js";
import { pendingTests, completeTestRequests } from "./test-requests.js";
import { currentProcessSignal } from "./check-engine/process-cancellation.js";
import { executeTestPlan } from "./test-execution.js";
import { loadTestPlan } from "./test-plan-inputs.js";
import { tryAcquireProjectHeavyProcessLease } from "./project-heavy-process-lock.js";
import { tryAcquireForegroundCapacity } from "./test-capacity.js";
import { tryAcquireCrossProcessCompilerLease, canonicalProjectRoot } from "./project-compiler-lock.js";
import { publishTestCompletion } from "./test-request-completion.js";
import { collectRepositoryInventory } from "../lib/metrics/inventory.js";
import { captureKnownTestInputs } from "./test-runtime.js";
import { captureVitestEnvironment } from "./coverage-shards/discovery.js";
import type { TestExecution } from "./test-run-receipt.js";

// Observation hooks for the pins below: every wrapper delegates to the real module, so behavior is unchanged.
const probes = vi.hoisted(() => ({
    gitStatusFailure: null as unknown,
    timerCalls: [] as unknown[][],
    capacityKinds: [] as string[],
    observed: [] as unknown[],
}));
vi.mock("node:child_process", async importOriginal => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const wrapped = (...args: unknown[]): unknown => {
        const argv = args[1];
        if (probes.gitStatusFailure !== null && args[0] === "git" && Array.isArray(argv) && argv.includes("--ignored=matching")) throw probes.gitStatusFailure;
        return (actual.execFileSync as (...rest: unknown[]) => unknown)(...args);
    };
    return { ...actual, execFileSync: wrapped };
});
vi.mock("node:timers/promises", async importOriginal => {
    const actual = await importOriginal<typeof import("node:timers/promises")>();
    const wrapped = (...args: unknown[]): unknown => {
        probes.timerCalls.push(args);
        return (actual.setTimeout as (...rest: unknown[]) => unknown)(...args);
    };
    return { ...actual, setTimeout: wrapped };
});
vi.mock("./test-capacity.js", async importOriginal => {
    const actual = await importOriginal<typeof import("./test-capacity.js")>();
    const acquireTestCapacity: typeof actual.acquireTestCapacity = (kind, deadline, signal) => {
        probes.capacityKinds.push(kind);
        return actual.acquireTestCapacity(kind, deadline, signal);
    };
    return { ...actual, acquireTestCapacity };
});
vi.mock("./test-run-observation.js", async importOriginal => {
    const actual = await importOriginal<typeof import("./test-run-observation.js")>();
    const observeTestRun: typeof actual.observeTestRun = (root, result) => {
        probes.observed.push(result);
        return actual.observeTestRun(root, result);
    };
    return { ...actual, observeTestRun };
});
vi.mock("./test-execution.js", () => ({ executeTestPlan: vi.fn() }));
vi.mock("./check-engine/process-cancellation.js", () => ({ currentProcessSignal: vi.fn() }));
vi.mock("./test-plan-inputs.js", async importOriginal => ({ ...await importOriginal<typeof import("./test-plan-inputs.js")>(), loadTestPlan: vi.fn(), readTestDependencies: () => ({}) }));

const roots: string[] = [];
beforeEach(() => {
    vi.stubEnv("INTERLINKED_STAGES_LEDGER", "");
    vi.stubEnv("INTERLINKED_TEST_CAPACITY_SCOPE", `scheduler-mutation-${process.pid}-${Math.random().toString(16).slice(2)}`);
    probes.gitStatusFailure = null;
    probes.timerCalls.length = 0;
    probes.capacityKinds.length = 0;
    probes.observed.length = 0;
});
afterEach(() => {
    probes.gitStatusFailure = null;
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function passing(plan: TestExecution["plan"], runId = "run", status: TestExecution["status"] = "passed", reason = ""): TestExecution {
    return { plan, status, runId, reused: false, durationMs: 1, reason, output: "" };
}
function fixture(mode: "selected" | "full" = "selected"): string {
    const root = mkdtempSync(join(tmpdir(), "test-scheduler-mutation-")); roots.push(root);
    writeFileSync(join(root, "a.ts"), "export const a = 1;");
    vi.mocked(loadTestPlan).mockImplementation(async (_root, paths) => ({ version: 1, snapshot: "snapshot", changedPaths: [...paths], mode, tests: [{ path: "a.test.ts", reasons: ["changed"], durationMs: null }], omitted: [], reasons: [], estimatedSerialMs: null, reusable: true }));
    vi.mocked(executeTestPlan).mockImplementation(async plan => passing(plan));
    return root;
}
function gitRepo(root: string): void {
    writeFileSync(join(root, ".gitignore"), ".interlinked/\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
}
const schedulerKey = (root: string): string => `interlinked-test-scheduler-v1\0${canonicalProjectRoot(root)}`;
function stageRows(root: string): Array<Record<string, unknown>> {
    const path = join(root, ".interlinked", "verification-stages.jsonl");
    // SAFETY: the fixture's ledger is written only by recordVerificationStage, one JSON object per line.
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
}
async function completedByAnotherOwner(root: string): Promise<void> {
    const requests = pendingTests(root), plan = await loadTestPlan(root, requests.paths, 1000);
    publishTestCompletion(root, requests.ids, { ...passing(plan, "other-owner", "passed", "Fresh run") }, { inputHash: collectRepositoryInventory(root).inputHash,
        environmentHash: captureVitestEnvironment().environmentHash, known: captureKnownTestInputs(root, ["a.ts"]) });
    completeTestRequests(root, requests.ids);
}
/** A drain whose first batch edits an input (queuing a second batch). */
function editDuringFirstRun(root: string, afterEdit?: () => void, timerMarks?: number[]): void {
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        const call = vi.mocked(executeTestPlan).mock.calls.length;
        if (call === 2) timerMarks?.push(probes.timerCalls.length);
        if (call === 1) {
            writeFileSync(join(root, "a.ts"), "export const a = 2;");
            afterEdit?.();
        }
        const result = passing(plan, `run-${call}`);
        if (call === 1) timerMarks?.push(probes.timerCalls.length);
        return result;
    });
}

// --- acquireProject: a process signal selects the blocking/non-blocking lease path by waitForCapacity ---

// basis: ScheduleTestsOptions.waitForCapacity === false means "do not wait" (hook callers retain the request immediately; existing test at test-scheduler.test.ts:274 pins the no-signal path)
it("retains a request immediately when capacity is not awaited, even with a process signal installed", async () => {
    const root = fixture(), release = tryAcquireProjectHeavyProcessLease(root);
    if (!release) throw new Error("Fixture lease unavailable");
    vi.mocked(currentProcessSignal).mockReturnValue(new AbortController().signal);
    try {
        const started = Date.now();
        await expect(scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000, waitForCapacity: false, stage: "edit" })).rejects.toThrow("Project check capacity busy");
        expect(Date.now() - started).toBeLessThan(2000);
        expect(executeTestPlan).not.toHaveBeenCalled();
    } finally { release(); }
}, 8000);

it("waits for a busy project slot when capacity is awaited and a process signal is installed", async () => {
    const root = fixture(), release = tryAcquireProjectHeavyProcessLease(root);
    if (!release) throw new Error("Fixture lease unavailable");
    vi.mocked(currentProcessSignal).mockReturnValue(new AbortController().signal);
    let releasedAt = Number.POSITIVE_INFINITY, startedAt = 0;
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        startedAt = Date.now();
        return passing(plan);
    });
    global.setTimeout(() => { releasedAt = Date.now(); release(); }, 300);
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 8000, stage: "cli" });
    expect(result.status, result.reason).toBe("passed");
    expect(startedAt).toBeGreaterThanOrEqual(releasedAt);
}, 12_000);

// --- checkoutWritesDuring: an INPUT created during a run is staleness, not checkout pollution ---

// basis: doc comment on checkoutWritesDuring (test-scheduler.ts:93-94): "Inputs are `changedDuring`'s business; these never make a run stale"
it("does not report a newly created input file as a non-input checkout write", async () => {
    const root = fixture();
    gitRepo(root);
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "created.ts"), "export const created = 1;");
        return passing(plan, "creates-input", "failed", "original diagnostic");
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000 });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("created.ts");
    expect(result.checkoutWrites).toBeUndefined();
}, 8000);

// --- checkoutEntries: only a missing repository / git binary falls back; anything else is a real failure ---

// basis: comment in checkoutEntries (test-scheduler.ts:114): "Not a repository (git exits non-zero) or no git binary: fall back; anything else is a real failure."
it("fails the request when the git status snapshot breaks for a reason other than exit or a missing binary", async () => {
    const root = fixture();
    probes.gitStatusFailure = Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
    await expect(scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000 })).rejects.toThrow("ETIMEDOUT");
    expect(executeTestPlan).not.toHaveBeenCalled();
}, 8000);

it.each([
    ["git exits non-zero (not a repository)", Object.assign(new Error("exit 128"), { status: 128 })],
    ["the git binary is missing", Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" })],
])("falls back to the inventory snapshot when %s", async (_label, failure) => {
    const root = fixture();
    probes.gitStatusFailure = failure;
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000 });
    expect(result.status, result.reason).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
}, 8000);

// --- staleInputsReason: bound ---

// basis: doc comment on staleInputsReason (test-scheduler.ts:144) "a, b (+3 more)": the suffix counts paths NOT shown
it("names exactly ten changed inputs without a 'more' suffix", () => {
    const ten = Array.from({ length: 10 }, (_, index) => `f${String(index).padStart(2, "0")}.ts`);
    expect(staleInputsReason(ten)).toBe(`Inputs changed during execution: ${ten.join(", ")}`);
});

// --- overBudget ---

// basis: the deferral reason reads "Plan needs N tests; hook budget is M" (test-scheduler.ts:156): a plan of exactly M tests is within budget
it("runs a selected plan whose test count equals the hook budget", async () => {
    const root = fixture();
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000, maxTests: 1, stage: "edit" });
    expect(result.status, result.reason).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(stageRows(root)).toEqual([]);
}, 8000);

// basis: overBudget treats the full suite as its own scope ("the full suite", test-scheduler.ts:155): a full plan never fits a hook budget by test count
it("defers a full-suite plan under a hook budget even when its test list is short", async () => {
    const root = fixture("full");
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000, maxTests: 100, stage: "edit" });
    expect(result.status).toBe("deferred");
    expect(executeTestPlan).not.toHaveBeenCalled();
    expect(stageRows(root)).toMatchObject([{ status: "deferred", reuse_denied_reason: "budget-exceeded", check: "vitest:full" }]);
}, 8000);

// --- withInputChange ---

// basis: the reason composes only non-empty parts ([...].filter(Boolean), test-scheduler.ts:170): an empty original reason leaves no dangling separator
it("starts the stale reason with the changed inputs when the run had no reason of its own", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "a.ts"), "export const a = 2;");
        return passing(plan, "unfinished", "failed", "");
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000 });
    expect(result.status).toBe("failed");
    expect(result.reason).not.toMatch(/^[;\s]/);
    expect(result.reason).toMatch(/^Inputs changed during execution: a\.ts/);
}, 8000);

// --- satisfiedRequests / runOneBatch completion ---

// basis: satisfiedRequests doc (test-scheduler.ts:159): a pass discharges "later ones its scope covers"; a FULL request that arrives mid-run is wider than a selected batch
it("keeps a full-suite request that arrived during a selected run pending", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        // A different caller (another process) queues the full suite while this selected batch executes.
        mkdirSync(join(root, ".interlinked/test-runs/requests"), { recursive: true });
        writeFileSync(join(root, ".interlinked/test-runs/requests/full-from-other-process.json"), JSON.stringify({ paths: [], full: true, requirements: {} }));
        return passing(plan, "selected");
    });
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000 });
    expect(result).toMatchObject({ status: "passed", runId: "selected" });
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).full).toBe(true);
}, 8000);

// basis: runOneBatch re-requests a full run for a stale result (test-scheduler.ts:198); the next batch plans the FULL suite
it("plans the next batch as a full run after an execution reports stale", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => passing(plan, "stale-run", "stale", "snapshot moved"));
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000 });
    expect(result.status, result.reason).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
    expect(vi.mocked(loadTestPlan).mock.calls[0]?.[3]).toBe(false);
    expect(vi.mocked(loadTestPlan).mock.calls[1]?.[3]).toBe(true);
}, 12_000);

// basis: TestExecution statuses "passed" and "empty" both certify (settledBatch, test-scheduler.ts:290 treats them alike)
it("completes the request after a run with no tests to execute", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => passing(plan, "nothing-to-run", "empty"));
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000 });
    expect(result).toMatchObject({ status: "empty", runId: "nothing-to-run" });
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    expect(pendingTests(root).ids).toEqual([]);
}, 8000);

// basis: same contract as test-scheduler.test.ts:98 (a vanished request with no completion or retirement evidence is deferred), for an "empty" run
it("defers a caller whose request vanished even when the shared run was empty", async () => {
    const root = fixture();
    const dir = join(root, ".interlinked/test-runs/requests");
    let runs = 0;
    vi.mocked(executeTestPlan).mockImplementation(async plan => {
        runs += 1;
        if (runs === 1) {
            const waiting = readdirSync(dir).filter(name => name.endsWith(".json")).find(name => JSON.parse(readFileSync(join(dir, name), "utf8")).paths.includes("b.ts"));
            if (waiting) rmSync(join(dir, waiting));
        }
        return passing(plan, `run${runs}`, "empty");
    });
    const first = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 4000 });
    const waiter = scheduleTests({ root, paths: ["b.ts"], timeoutMs: 4000 });
    await first;
    const result = await waiter;
    expect(result.status).toBe("deferred");
    expect(result.reason).toMatch(/Request state unresolved/);
}, 10_000);

// --- priority -> host admission kind ---

// basis: ScheduleTestsOptions.priority doc (test-scheduler.ts:39-43) and priorityOf doc (:212): interactive waits as foreground; background otherwise; default is background for stage `edit`, else interactive
it.each([
    ["an edit-stage hook defaults to background", { stage: "edit" as const }, "background"],
    ["a cli-stage caller defaults to interactive", { stage: "cli" as const }, "foreground"],
    ["an explicit interactive priority beats the edit stage", { stage: "edit" as const, priority: "interactive" as const }, "foreground"],
    ["an explicit background priority beats the cli stage", { stage: "cli" as const, priority: "background" as const }, "background"],
])("admits at the host gate as %s", async (_label, options, kind) => {
    const root = fixture();
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000, ...options });
    expect(result.status, result.reason).toBe("passed");
    expect(probes.capacityKinds).toEqual([kind]);
}, 12_000);

// --- batch boundary ---

// basis: BATCH_YIELD_MS doc (test-scheduler.ts:265-268): waiters poll leases every 25 ms (scheduler/project) and 50 ms (background host admission); an immediate re-acquire "would win every race"
it("stays out of the leases at a batch boundary for longer than the slowest waiter poll interval", async () => {
    const root = fixture();
    const marks: number[] = [];
    editDuringFirstRun(root, undefined, marks);
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 8000, stage: "edit" });
    expect(result.status, result.reason).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
    // Timers armed with an abort signal between the end of batch 1 and the start of batch 2: the yield (lease polls are shorter).
    expect(marks).toHaveLength(2);
    const between = probes.timerCalls.slice(marks[0], marks[1]).filter(args => (args[2] as { signal?: unknown } | undefined)?.signal !== undefined).map(args => args[0] as number);
    expect(between.length).toBeGreaterThan(0);
    expect(Math.max(...between)).toBeGreaterThan(50);
}, 12_000);

// basis: the yield swallows its own cancellation (`.catch(() => undefined)`, test-scheduler.ts:274) so an aborted wait still proceeds to lease acquisition; existing abort pin: test-scheduler.test.ts:438
it("continues to the next batch when the process is cancelled during the batch-boundary yield and capacity is not awaited", async () => {
    const root = fixture();
    const controller = new AbortController();
    vi.mocked(currentProcessSignal).mockReturnValue(controller.signal);
    editDuringFirstRun(root, () => controller.abort());
    const result = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 8000, waitForCapacity: false, stage: "edit" });
    expect(result.status, result.reason).toBe("passed");
    expect(executeTestPlan).toHaveBeenCalledTimes(2);
}, 12_000);

// basis: same lease-release contract as test-scheduler.test.ts:525 (consuming a shared completion releases the scheduler slot), at a retry boundary
it("releases every lease when another owner's completion answers the caller at a retry boundary", async () => {
    const root = fixture();
    vi.mocked(executeTestPlan).mockImplementationOnce(async plan => {
        writeFileSync(join(root, "a.ts"), "export const a = 2;");
        return passing(plan, "stale");
    });
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 8000 });
    await vi.waitFor(() => expect(executeTestPlan).toHaveBeenCalledTimes(1), { interval: 5 });
    const owner = await vi.waitFor(() => {
        const lease = tryAcquireCrossProcessCompilerLease(schedulerKey(root));
        if (!lease) throw new Error("Waiting for retry boundary");
        return lease;
    }, { interval: 5 });
    try {
        await completedByAnotherOwner(root);
    } finally { owner.release(); }
    expect((await waiting).runId).toBe("other-owner");
    expect(executeTestPlan).toHaveBeenCalledTimes(1);
    const scheduler = tryAcquireCrossProcessCompilerLease(schedulerKey(root));
    const project = tryAcquireProjectHeavyProcessLease(root);
    const host = tryAcquireForegroundCapacity();
    try {
        expect(scheduler).not.toBeNull();
        expect(project).not.toBeNull();
        expect(host).not.toBeNull();
    } finally { scheduler?.release(); project?.(); host?.release(); }
}, 15_000);

// --- observeTestRun ---

// basis: a result with a run id is a run on disk and is observed; a deferral that ran nothing (runId "") has nothing to observe (test-scheduler.ts:302)
it("observes an executed run and does not observe a budget deferral that ran nothing", async () => {
    const root = fixture();
    await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000, maxTests: 0, stage: "edit" });
    expect(probes.observed).toEqual([]);
    const executed = await scheduleTests({ root, paths: ["a.ts"], timeoutMs: 3000 });
    expect(executed.runId).toBe("run");
    expect(probes.observed).toHaveLength(1);
    expect(probes.observed[0]).toMatchObject({ runId: "run" });
}, 10_000);

// --- requeueRejectedCompletion: a handover keeps the union of the shared obligation and the caller's own ---

async function handOverStaleCompletion(root: string, shared: { full: boolean }, caller: { full?: boolean }): Promise<void> {
    const owner = tryAcquireCrossProcessCompilerLease(schedulerKey(root));
    if (!owner) throw new Error("Fixture scheduler lease unavailable");
    const dir = join(root, ".interlinked/test-runs/requests");
    const waiting = scheduleTests({ root, paths: ["a.ts"], timeoutMs: 5000, ...caller });
    try {
        // Another process retires the caller's request A into B, completes B, then a.ts changes.
        const aFile = readdirSync(dir).find(name => name.endsWith(".json")) ?? "";
        const replacement = "b-from-other-process";
        writeFileSync(join(dir, `${replacement}.json`), JSON.stringify({ paths: ["a.ts"], full: shared.full, requirements: {} }));
        appendFileSync(join(dir, "superseded.jsonl"), `${JSON.stringify({ ts: "t", id: aFile.replace(/\.json$/, ""), by: replacement, full: shared.full, paths: ["a.ts"] })}\n`);
        rmSync(join(dir, aFile));
        await completedByAnotherOwner(root);
        writeFileSync(join(root, "a.ts"), "new input");
    } finally { owner.release(); }
    const result = await waiting;
    expect(result.status, result.reason).toBe("passed");
}

// basis: requeueRejectedCompletion comment (test-scheduler.ts:358-360): the replacement carries the SHARED request's obligation so every waiter on the old id accepts it; the caller's own need is added, never subtracted
it.each([
    ["the shared request was selected and the caller asked for the full suite", { full: false }, { full: true }],
    ["the shared request was the full suite and the caller asked for a selection", { full: true }, {}],
])("replays a full obligation when %s", async (_label, shared, caller) => {
    const root = fixture();
    await handOverStaleCompletion(root, shared, caller);
    expect(vi.mocked(loadTestPlan).mock.calls.at(-1)?.[3]).toBe(true);
}, 12_000);

it("keeps a selected obligation selected when neither the shared request nor the caller asked for the full suite", async () => {
    const root = fixture();
    await handOverStaleCompletion(root, { full: false }, {});
    expect(vi.mocked(loadTestPlan).mock.calls.at(-1)?.[3]).toBe(false);
}, 12_000);
