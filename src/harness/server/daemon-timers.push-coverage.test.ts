import { afterEach, expect, it, vi } from "vitest";
import { installDaemonTimers } from "./daemon-timers.js";

afterEach(() => vi.useRealTimers());

it.each(["absent", "contended"])("recycles once when the startup lease is %s", (lease) => {
    vi.useFakeTimers();
    const shutdown = vi.fn();
    const log = vi.fn();
    const acquireRecycleLease = vi.fn(() => false);
    const stop = installDaemonTimers({
        refreshStatuslineSnapshot: vi.fn(),
        shutdown,
        log,
        rssBytes: () => 2 * 1024 * 1024,
        ceilingBytes: 1024 * 1024,
        ...(lease === "contended" ? { acquireRecycleLease } : {}),
    });
    try {
        vi.advanceTimersByTime(90_000);
        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledExactlyOnceWith(
            "Recycling: RSS 2MB over 1MB ceiling — startup already locked; stopping without spawning to release memory",
        );
        expect(acquireRecycleLease).toHaveBeenCalledTimes(lease === "contended" ? 1 : 0);
    } finally {
        stop();
    }
});
