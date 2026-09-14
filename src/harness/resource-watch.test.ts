import { afterEach, expect, it, vi } from "vitest";
import { processTreeRss, watchResources } from "./resource-watch.js";
import { readResourceMemory } from "./resource-memory.js";

vi.mock("./resource-memory.js", () => ({ readResourceMemory: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it("counts out-of-order descendants and reparented group members without counting a neighboring model", () => {
    const table = "30 20 10 300\n20 10 10 200\n10 1 10 100\n40 1 10 400\n50 1 50 999999";
    expect(processTreeRss(table, 10)).toBe(1000 * 1024);
});
it.each(["", "10 1 10 NaN", "10 1 10 -2", "10 1 10", "10 1 10 Infinity"])("rejects unavailable process readings %j", table => {
    expect(() => processTreeRss(table, 10)).toThrow("Invalid process memory sample");
});
it("interrupts when host capacity disappears and stops observing after cleanup", async () => {
    vi.useFakeTimers();
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * 1024 ** 3, availableBytes: 1024 ** 3 });
    const stop = vi.fn();
    const close = watchResources(12345, { reserveBytes: 6 * 1024 ** 3, maxRssBytes: 4 * 1024 ** 3 }, stop);
    await vi.advanceTimersByTimeAsync(500);
    expect(stop).toHaveBeenCalledWith("Host memory reserve exhausted or unavailable");
    close();
    stop.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).not.toHaveBeenCalled();
});
