import { expect, it, vi } from "vitest";
import { acquireTestCapacity, foregroundWantsCapacity, tryAcquireForegroundCapacity } from "./test-capacity.js";

it("makes background work yield admission to a waiting foreground request", async () => {
    const controller = new AbortController();
    const background = await acquireTestCapacity("background", Date.now() + 2000, controller.signal);
    expect(background).not.toBeNull();
    const foreground = acquireTestCapacity("foreground", Date.now() + 2000, controller.signal);
    try {
        await vi.waitFor(() => expect(foregroundWantsCapacity()).toBe(true));
        expect(tryAcquireForegroundCapacity()).toBeNull();
    } finally { background?.release(); }
    const admitted = await foreground;
    expect(admitted).not.toBeNull();
    admitted?.release();
});

it("does not acquire capacity after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(acquireTestCapacity("background", Date.now() + 1000, controller.signal)).resolves.toBeNull();
});
