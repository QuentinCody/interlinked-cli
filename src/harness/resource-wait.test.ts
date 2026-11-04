import { afterEach, expect, it, vi } from "vitest";
import { waitForResource } from "./resource-wait.js";

afterEach(() => vi.useRealTimers());

// test-contract: regression — temporary admission shortages wait within the same deadline; no work is certified by waiting.
it("rechecks capacity and notifies only once before it becomes available", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValue(2);
    const notice = vi.fn();
    const pending = waitForResource(probe, Date.now() + 5000, undefined, notice);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(2);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(notice).toHaveBeenCalledOnce();
});

// test-contract: boundary — a budget never available, or cancellation during the wait, grants no capacity.
it.each(["deadline", "abort"])("does not grant capacity after %s", async mode => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const probe = vi.fn().mockReturnValue(null);
    const pending = waitForResource(probe, Date.now() + 700, controller.signal);
    if (mode === "abort") controller.abort();
    await vi.advanceTimersByTimeAsync(700);
    expect(await pending).toBeNull();
    expect(probe.mock.calls.length).toBeLessThanOrEqual(2);
});

// test-contract: invariant — expired or cancelled requests cannot start even if capacity is now available.
it("declines expired and pre-aborted requests without probing", async () => {
    const probe = vi.fn().mockReturnValue(1);
    expect(await waitForResource(probe, Date.now() - 1)).toBeNull();
    expect(await waitForResource(probe, Date.now() + 5000, AbortSignal.abort())).toBeNull();
    expect(probe).not.toHaveBeenCalled();
});

// test-contract: boundary — a slow probe cannot admit after its deadline, and a cancelling probe grants no capacity.
it.each(["slow", "cancelling"])("rechecks the boundary after a %s probe", async mode => {
    vi.useFakeTimers();
    const started = Date.now(), controller = new AbortController();
    const probe = () => {
        if (mode === "slow") vi.setSystemTime(started + 1001);
        else controller.abort();
        return 1;
    };
    expect(await waitForResource(probe, started + 1000, controller.signal)).toBeNull();
});
