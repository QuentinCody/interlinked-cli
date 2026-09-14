import { afterEach, expect, it, vi } from "vitest";
import { runResourceCommand } from "./resource-command.js";
import { acquireTestCapacity } from "./test-capacity.js";
import { readResourceBudget } from "./resource-budget.js";
import { runProcessAsync } from "./check-engine/spawn-async.js";

vi.mock("./test-capacity.js", () => ({ acquireTestCapacity: vi.fn() }));
vi.mock("./resource-budget.js", () => ({ readResourceBudget: vi.fn() }));
vi.mock("./check-engine/spawn-async.js", () => ({ runProcessAsync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("does not spawn when another project owns the host lane", async () => {
    vi.mocked(acquireTestCapacity).mockResolvedValue(null);
    expect(await runResourceCommand("node", [], new AbortController().signal)).toBeNull();
    expect(runProcessAsync).not.toHaveBeenCalled();
});
it("rechecks memory after admission and releases a deferred lane", async () => {
    const release = vi.fn();
    vi.mocked(acquireTestCapacity).mockResolvedValue({ release });
    vi.mocked(readResourceBudget).mockReturnValue(null);
    expect(await runResourceCommand("node", [], new AbortController().signal)).toBeNull();
    expect(runProcessAsync).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
});
it("keeps the lease until an interrupted command is reaped and propagates its result", async () => {
    const release = vi.fn();
    const budget = { reserveBytes: 1024 ** 3, maxRssBytes: 2 * 1024 ** 3 };
    vi.mocked(acquireTestCapacity).mockResolvedValue({ release });
    vi.mocked(readResourceBudget).mockReturnValue(budget);
    const interrupted = { code: null, killed: true, timedOut: false, stdout: "", stderr: "", resourceReason: "budget" };
    vi.mocked(runProcessAsync).mockImplementation(async (_file, _args, options) => {
        expect(release).not.toHaveBeenCalled();
        expect(options).toMatchObject({ resourceBudget: budget, inheritOutput: true });
        return interrupted;
    });
    expect(await runResourceCommand("node", ["--version"], new AbortController().signal)).toEqual(interrupted);
    expect(release).toHaveBeenCalledOnce();
});
