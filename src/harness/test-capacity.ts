import { setTimeout } from "node:timers/promises";
import { acquireCrossProcessCompilerLease, tryAcquireCrossProcessCompilerLease, type CrossProcessCompilerLease } from "./project-compiler-lock.js";

const HOST = "interlinked-background-host-v1";
const PRIORITY = "interlinked-foreground-priority-v1";

/** A waiting foreground owner closes admission to new background jobs. */
export function foregroundWantsCapacity(): boolean {
    const lease = tryAcquireCrossProcessCompilerLease(PRIORITY);
    if (!lease) return true;
    lease.release();
    return false;
}

export function tryAcquireForegroundCapacity(): CrossProcessCompilerLease | null {
    const priority = tryAcquireCrossProcessCompilerLease(PRIORITY);
    if (!priority) return null;
    try { return tryAcquireCrossProcessCompilerLease(HOST); }
    finally { priority.release(); }
}

/** Both lanes spend the same host slot. Waiting background work never holds the priority gate. */
export async function acquireTestCapacity(kind: "foreground" | "background", deadline: number, signal: AbortSignal): Promise<CrossProcessCompilerLease | null> {
    if (kind === "foreground") {
        const priority = await acquireCrossProcessCompilerLease(PRIORITY, deadline, signal);
        if (!priority) return null;
        try { return await acquireCrossProcessCompilerLease(HOST, deadline, signal); }
        finally { priority.release(); }
    }
    while (!signal.aborted && Date.now() < deadline) {
        const lease = tryAcquireForegroundCapacity();
        if (lease) return lease;
        await setTimeout(50, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
    return null;
}
