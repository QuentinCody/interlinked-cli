import { AsyncLocalStorage } from "node:async_hooks";

const cancellation = new AsyncLocalStorage<AbortSignal>();

/** A job owns its descendants, without cancelling work already owned by another job. */
export function withProcessCancellation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    return cancellation.run(signal, work);
}

export function currentProcessSignal(): AbortSignal | undefined {
    return cancellation.getStore();
}

export function combinedProcessSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
    const owner = currentProcessSignal();
    return owner && signal ? AbortSignal.any([owner, signal]) : owner ?? signal;
}
