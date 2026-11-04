import { combinedProcessSignal } from "./check-engine/process-cancellation.js";

const RESOURCE_POLL_MS = 500;

/** Abortable delay; cancellation resolves admission as unavailable instead of rejecting the caller. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise(resolve => {
        const finish = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) finish();
    });
}

/** Wait within the caller's existing deadline; a wait grants no verification verdict or larger resource budget. */
export async function waitForResource<T>(probe: () => T | null, deadline: number, signal?: AbortSignal, onWait?: () => void): Promise<T | null> {
    const owner = combinedProcessSignal(signal);
    let notified = false;
    while (!owner?.aborted && Date.now() < deadline) {
        const available = probe();
        if (owner?.aborted || Date.now() >= deadline) return null;
        if (available !== null) return available;
        if (!notified) { onWait?.(); notified = true; }
        await pause(Math.min(RESOURCE_POLL_MS, Math.max(0, deadline - Date.now())), owner);
    }
    return null;
}
