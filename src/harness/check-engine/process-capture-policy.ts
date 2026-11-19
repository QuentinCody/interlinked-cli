import { AsyncLocalStorage } from "node:async_hooks";

const captureLimit = new AsyncLocalStorage<number | null>();

/** A foreground report can retain complete output without changing other jobs. */
export function withProcessCaptureLimit<T>(limit: number | null, work: () => Promise<T>): Promise<T> {
	return captureLimit.run(limit, work);
}

export function currentProcessCaptureLimit(): number | null | undefined {
	return captureLimit.getStore();
}
