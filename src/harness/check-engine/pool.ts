// ===========================================
// createLimiter — bounded concurrency for async tasks
// ===========================================
// Phase A.1 of the Free CLI Phase-2 roadmap. Caps the number of concurrent
// runner subprocesses to avoid CPU oversubscription on machines with fewer
// cores than concurrency-safe tools (e.g. a 4-core CI runner shouldn't spawn
// 8 subprocesses simultaneously — the OS scheduler ends up thrashing).
//
// Usage:
//   const limit = createLimiter(os.cpus().length - 1);
//   await Promise.all(tools.map(t => limit(() => runToolAsync(t))));
//
// Tasks above the limit are queued FIFO. Each task's Promise resolves /
// rejects exactly when the underlying work resolves / rejects; the limiter
// adds no observable error wrapping.

/** A function that wraps a task and returns the same Promise the task does,
 *  but enforces concurrency limits. */
type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Create a concurrency limiter. `maxConcurrent` is clamped to ≥1 — a 0/negative
 * limit would deadlock, so we degrade to "run sequentially" rather than fail.
 *
 * Implementation note: a single-counter + queue is sufficient — at our scale
 * (usually <30 concurrent submissions) the overhead of any heavier
 * scheduler isn't worth the dependency.
 */
export function createLimiter(maxConcurrent: number): Limiter {
	const cap = Math.max(1, maxConcurrent | 0);
	let inFlight = 0;
	const queue: Array<() => void> = [];

	const acquire = (): Promise<void> => {
		if (inFlight < cap) {
			inFlight++;
			return Promise.resolve();
		}
		return new Promise<void>((resolveAcquire) => {
			queue.push(() => {
				inFlight++;
				resolveAcquire();
			});
		});
	};

	const release = (): void => {
		inFlight--;
		const next = queue.shift();
		if (next) next();
	};

	return <T>(task: () => Promise<T>): Promise<T> =>
		acquire().then(async () => {
			try {
				return await task();
			} finally {
				release();
			}
		});
}
