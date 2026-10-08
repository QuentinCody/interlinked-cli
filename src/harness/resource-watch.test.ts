import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createPeakTracker, processTreeRss, watchResources } from "./resource-watch.js";
import { readResourceMemory } from "./resource-memory.js";

vi.mock("./resource-memory.js", () => ({ readResourceMemory: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
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

/** A `ps` table whose only process (pid 10, group 10) holds `rssKib` of resident memory. */
function psTable(rssKib: number): string { return `10 1 10 ${rssKib}`; }

// test-contract: public-api — onSample receives every tree RSS reading in bytes, in sampling order
it("reports each sampled tree RSS to onSample", async () => {
    vi.useFakeTimers();
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 });
    const tables = [psTable(100), psTable(300), psTable(200)];
    type PsDone = (error: Error | null, stdout: string) => void;
    const fakePs = (_file: string, _args: unknown, _options: unknown, done: PsDone): void => { done(null, tables.shift() ?? psTable(1)); };
    // SAFETY: the sampler only calls execFile(file, args, options, callback); `never` bridges the overloaded real signature to this fake.
    vi.mocked(execFile).mockImplementation(fakePs as never);
    const samples: number[] = [];
    const close = watchResources(10, { reserveBytes: 6 * 1024 ** 3, maxRssBytes: 4 * 1024 ** 3 }, vi.fn(), rss => samples.push(rss));
    await vi.advanceTimersByTimeAsync(1000);
    close();
    expect(samples.slice(0, 3)).toEqual([100 * 1024, 300 * 1024, 200 * 1024]);
});

// test-contract: boundary — a host with no spare memory is interrupted before any RSS is read, so no sample is reported
it("reports no sample when the host reserve check interrupts first", async () => {
    vi.useFakeTimers();
    vi.mocked(readResourceMemory).mockReturnValue({ totalBytes: 48 * 1024 ** 3, availableBytes: 1024 ** 3 });
    const onSample = vi.fn();
    const close = watchResources(10, { reserveBytes: 6 * 1024 ** 3, maxRssBytes: 4 * 1024 ** 3 }, vi.fn(), onSample);
    await vi.advanceTimersByTimeAsync(500);
    close();
    expect(onSample).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
});

describe("createPeakTracker", () => {
    // test-contract: invariant — the peak is the maximum of the samples, not the last one, whatever their order
    it("keeps the maximum of several samples", () => {
        const tracker = createPeakTracker();
        for (const rss of [100, 900, 400, 900, 50]) tracker.observe(rss);
        expect(tracker.peak).toBe(900);
    });

    // test-contract: boundary — with no sample the peak is undefined, not zero
    it("has no peak before the first sample", () => {
        expect(createPeakTracker().peak).toBeUndefined();
    });

    // test-contract: boundary — a first sample of 0 is a real reading and is kept as the peak
    it("keeps a first sample of zero", () => {
        const tracker = createPeakTracker();
        tracker.observe(0);
        expect(tracker.peak).toBe(0);
    });
});
