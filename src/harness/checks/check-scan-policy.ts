import { AsyncLocalStorage } from "node:async_hooks";

const foregroundScan = new AsyncLocalStorage<true>();

/** Explicit surveys retain the complete population recognized by participating
 * detectors. Other callers keep their existing per-edit result limits. This
 * changes collection limits, not predicates, applicability or enforcement. */
export function withForegroundCheckScan<T>(run: () => T): T {
	return foregroundScan.run(true, run);
}

/** A detector must opt in explicitly; this is not a claim about every check. */
export function checkMatchLimit(runtimeLimit: number): number {
	return foregroundScan.getStore() ? Number.POSITIVE_INFINITY : runtimeLimit;
}

/** Traversal callers can keep their own bounded runtime admission policy. */
export function isForegroundCheckScan(): boolean {
	return foregroundScan.getStore() === true;
}
