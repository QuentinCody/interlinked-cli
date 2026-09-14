import { expect, it, vi } from "vitest";
import { runProcessAsync } from "./check-engine/spawn-async.js";

vi.mock("./resource-memory.js", () => ({ readResourceMemory: () => ({ totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }) }));

it("reaps a real runner that exceeds its RSS ceiling and preserves the interruption reason", async () => {
    // A one-byte ceiling exercises enforcement without allocating a large buffer.
    const result = await runProcessAsync(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
        timeout: 10_000, resourceBudget: { reserveBytes: 1024 ** 3, maxRssBytes: 1 },
    });
    expect(result.killed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.resourceReason).toBe("Runner process tree exceeded its memory budget");
    expect(result.code).not.toBe(0);
});
