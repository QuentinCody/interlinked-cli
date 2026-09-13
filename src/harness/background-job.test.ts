import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runBackgroundJob } from "./background-job.js";
import { runProcessAsync, type RunProcessResult } from "./check-engine/spawn-async.js";
import { readResourceMemory } from "./resource-memory.js";

vi.mock("./resource-memory.js", () => ({ readResourceMemory: vi.fn() }));
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));

const result: RunProcessResult = { code: 0, stdout: "", stderr: "", timedOut: false, killed: false };
const job = { name: "test-fuzz", file: "npx", args: ["vitest", "run", "--maxWorkers=8"] };
let cwd: string;

beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "background-job-"));
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 });
    vi.mocked(runProcessAsync).mockResolvedValue(result);
});

afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    rmSync(cwd, { recursive: true, force: true });
});

it("rechecks an old worker plan against 8 GiB RAM and enforces heap and timeout limits", async () => {
    await expect(runBackgroundJob(job, cwd, new AbortController().signal)).resolves.toEqual(result);
    expect(runProcessAsync).toHaveBeenCalledWith("npx", ["vitest", "run", "--maxWorkers=1"], {
        cwd, timeout: 600_000, signal: expect.any(AbortSignal), env: { NODE_OPTIONS: "--max-old-space-size=768" },
    });
});

it("coalesces repeated job launches until the existing process completes", async () => {
    const controller = new AbortController();
    let complete: (value: RunProcessResult) => void = () => {};
    const pending = new Promise<RunProcessResult>(resolve => { complete = resolve; });
    vi.mocked(runProcessAsync).mockReturnValue(pending);
    const first = runBackgroundJob(job, cwd, controller.signal);
    await vi.waitFor(() => expect(runProcessAsync).toHaveBeenCalledTimes(1));
    try {
        await expect(runBackgroundJob(job, cwd, controller.signal)).resolves.toBeNull();
        expect(runProcessAsync).toHaveBeenCalledTimes(1);
    } finally {
        complete(result);
        await first;
    }
    await expect(runBackgroundJob(job, cwd, controller.signal)).resolves.toEqual(result);
    expect(runProcessAsync).toHaveBeenCalledTimes(2);
});

it("defers without starting a runner when host headroom has disappeared", async () => {
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 8 * 1024 ** 3, availableBytes: 2 * 1024 ** 3 });
    await expect(runBackgroundJob(job, cwd, new AbortController().signal)).resolves.toBeNull();
    expect(runProcessAsync).not.toHaveBeenCalled();
});

it("does not overlap different background jobs", async () => {
    let complete: (value: RunProcessResult) => void = () => {};
    const pending = new Promise<RunProcessResult>(resolve => { complete = resolve; });
    let active = 0;
    let peak = 0;
    vi.mocked(runProcessAsync).mockImplementation(async () => {
        active += 1;
        peak = Math.max(active, peak);
        await pending;
        active -= 1;
        return result;
    });
    const controller = new AbortController();
    const first = runBackgroundJob(job, cwd, controller.signal);
    await vi.waitFor(() => expect(active).toBe(1));
    const second = runBackgroundJob({ ...job, name: "other-job" }, cwd, controller.signal);
    // One event-loop turn lets a competing admission attempt reach the runner.
    await new Promise<void>(resolve => setImmediate(resolve));
    complete(result);
    await Promise.all([first, second]);
    expect(runProcessAsync).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
});

it("aborts the process group when available memory drops below the host reserve", async () => {
    vi.useFakeTimers();
    vi.mocked(runProcessAsync).mockImplementation(async (_file, _args, options) => {
        vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 8 * 1024 ** 3, availableBytes: 512 * 1024 ** 2 });
        await vi.advanceTimersByTimeAsync(500);
        expect(options?.signal?.aborted).toBe(true);
        return { ...result, code: null, killed: true };
    });
    await expect(runBackgroundJob(job, cwd, new AbortController().signal)).resolves.toMatchObject({ killed: true });
});
