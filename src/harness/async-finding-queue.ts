// ===========================================
// Async Finding Queue — per-session stash for deferred harness findings
// ===========================================
// The harness daemon (`server.ts`) evaluates agent tool calls on
// PreToolUse / PostToolUse hooks under a hard sub-500ms budget. Some
// future code-review checks — test-coverage-delta, browser render-smoke —
// take *seconds* to compute and cannot run inline on a PostToolUse hook
// without blowing that budget.
//
// The pattern for slow checks and background mutation results is: compute or
// durably receive the finding off the hook path, stash its agent-facing
// projection here keyed by session, and deliver it on a *later* hook event
// folded into the decision's `additional_context`. This module is that
// in-memory notification stash — nothing more.
//
// Integration:
//   - `enqueue()` is called by an async PostToolUse check once it finishes,
//     or by the protocol-v3 mutation background delivery after its JSONL row
//     is fsynced. The producer formats the agent-facing string (already
//     carrying its `[interlinked:...]` tag) as a `DeferredFinding`.
//   - `drain()` is called at the top of PreToolUse evaluation. Its results
//     are folded into the harness decision's `additional_context` so the
//     agent sees the deferred finding on its next turn — the same delivery
//     channel PostToolUse warnings already use.
//   - `clearSession()` is called on SessionEnd to drop a finished session's
//     queue.
//
// A daemon restart loses this in-memory notification queue. Async checks can
// recompute; protocol-v3 mutation findings remain in the versioned local
// JSONL delivery feed keyed by their stable outbox id. The queue is advisory
// presentation only and never retroactively blocks an edit.

/**
 * A single deferred finding — the result of an async check, parked until a
 * later hook event can deliver it to the agent.
 */
export interface DeferredFinding {
	/**
	 * Stable dedup key. Convention: `${check}:${sourceFile}` (e.g.
	 * `coverage_delta:src/harness/evaluator.ts`). Re-enqueueing a finding
	 * with an `id` already present REPLACES the older entry — a fresher
	 * computation for the same (check, file) supersedes the stale one.
	 */
	id: string;
	/** Check name, e.g. `"coverage_delta"` or `"render_smoke"`. */
	check: string;
	/**
	 * The agent-facing string, already formatted with its
	 * `[interlinked:...]` tag — `drain()` hands this through verbatim into
	 * `additional_context`.
	 */
	message: string;
	/** ISO 8601 timestamp string marking when the finding was computed. */
	computedAt: string;
	/** The file the finding pertains to, when the check is file-scoped. */
	sourceFile?: string;
}

/** Constructor options for {@link AsyncFindingQueue}. */
interface AsyncFindingQueueOptions {
	/**
	 * Staleness horizon in milliseconds. A finding is dropped (never
	 * returned) by `drain()` once `now() - Date.parse(computedAt)` exceeds
	 * this. Default: 600_000 (10 minutes).
	 */
	ttlMs?: number;
	/**
	 * Hard cap on findings retained per session. When a session would
	 * exceed it, the oldest finding(s) are dropped. Default: 50.
	 */
	maxPerSession?: number;
	/**
	 * Clock injection. The harness has an `untestable_time_in_source` check
	 * that flags direct `Date.now()` calls, and an injected clock makes
	 * staleness deterministically testable. Default: `Date.now`.
	 */
	now?: () => number;
}

/** Default staleness horizon — 10 minutes. */
const DEFAULT_TTL_MS = 600_000;

/** Default per-session retention cap. */
const DEFAULT_MAX_PER_SESSION = 50;

/**
 * Per-session queue of deferred findings. Backed by a single in-memory
 * `Map<string, DeferredFinding[]>` — no I/O, no external dependencies,
 * fully deterministic given an injected clock.
 *
 * Within a session the backing array is kept in insertion order, so the
 * oldest finding is always at index 0 — both the `maxPerSession` eviction
 * and the (purely informational) ordering of `pending()` rely on that.
 */
export class AsyncFindingQueue {
	private readonly queues: Map<string, DeferredFinding[]> = new Map();
	private readonly ttlMs: number;
	private readonly maxPerSession: number;
	private readonly now: () => number;

	constructor(options: AsyncFindingQueueOptions = {}) {
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxPerSession = options.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Store a finding for a session.
	 *
	 * Dedup by `finding.id`: if a finding with the same `id` already exists
	 * for the session, it is REPLACED in place (newer computation wins) —
	 * the queue never holds two entries with the same `id`. Replacement
	 * keeps the existing slot, so a re-enqueue does not reset the entry's
	 * age relative to its siblings for eviction purposes.
	 *
	 * Enforces `maxPerSession`: a fresh `id` that pushes the session over
	 * the cap evicts the OLDEST finding(s) until the queue is back at the
	 * cap.
	 */
	enqueue(sessionId: string, finding: DeferredFinding): void {
		let queue = this.queues.get(sessionId);
		if (!queue) {
			queue = [];
			this.queues.set(sessionId, queue);
		}

		const existingIdx = queue.findIndex((f) => f.id === finding.id);
		if (existingIdx !== -1) {
			// Replace in place — newer computation supersedes the stale one,
			// and the entry keeps its position so eviction ordering is stable.
			queue[existingIdx] = finding;
			return;
		}

		queue.push(finding);

		// Enforce the per-session cap by dropping from the front (oldest).
		// A loop rather than a single splice so the cap holds even if it is
		// somehow already overshot.
		while (queue.length > this.maxPerSession) {
			queue.shift();
		}
	}

	/**
	 * Atomically remove and return all *non-stale* findings for a session.
	 *
	 * Staleness is `now() - Date.parse(finding.computedAt) > ttlMs`; stale
	 * findings are dropped, never returned. After this call the session's
	 * queue is empty regardless of how many findings were stale. An unknown
	 * session yields `[]`.
	 *
	 * This is the call the PreToolUse path makes — its result is folded
	 * into the decision's `additional_context`.
	 */
	drain(sessionId: string): DeferredFinding[] {
		const queue = this.queues.get(sessionId);
		if (!queue || queue.length === 0) {
			// Keep the map tidy — an empty entry left behind serves nothing.
			this.queues.delete(sessionId);
			return [];
		}

		// Atomic: the session's queue is cleared before we return, so a
		// concurrent (next-event) drain sees nothing.
		this.queues.delete(sessionId);

		const cutoff = this.now();
		const fresh: DeferredFinding[] = [];
		for (const finding of queue) {
			if (!this.isStale(finding, cutoff)) {
				fresh.push(finding);
			}
		}
		return fresh;
	}

	/**
	 * Peek at a session's findings WITHOUT draining and WITHOUT staleness
	 * filtering. For introspection and tests only — never the delivery
	 * path. The returned array is a defensive copy: mutating it does not
	 * touch the queue.
	 */
	pending(sessionId: string): readonly DeferredFinding[] {
		const queue = this.queues.get(sessionId);
		if (!queue) return [];
		return [...queue];
	}

	/**
	 * Drop everything for a session. Called on SessionEnd. A no-op for an
	 * unknown session.
	 */
	clearSession(sessionId: string): void {
		this.queues.delete(sessionId);
	}

	/** True iff the finding's age exceeds `ttlMs` relative to `nowMs`. */
	private isStale(finding: DeferredFinding, nowMs: number): boolean {
		const computedMs = Date.parse(finding.computedAt);
		// An unparseable timestamp cannot be aged-out meaningfully — treat
		// it as fresh so a malformed `computedAt` never silently swallows a
		// finding the agent should still see.
		if (Number.isNaN(computedMs)) return false;
		return nowMs - computedMs > this.ttlMs;
	}
}
