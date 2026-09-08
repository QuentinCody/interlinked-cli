// Tests for the async-deferred finding queue — the per-session stash that
// parks slow async-check results until a later hook event can deliver them.
//
// The queue is deterministic given an injected clock, so staleness is
// exercised by handing the constructor a `now` that reports a time well
// past a finding's `computedAt` rather than by sleeping.
//
// Coverage (≥3 positive + ≥3 negative/edge):
//   positive — enqueue→drain roundtrip; dedup-by-id replaces in place;
//              maxPerSession evicts the oldest; clearSession empties.
//   negative — drain is atomic (second drain is []); per-session isolation
//              (draining A never returns B's); staleness drops aged-out
//              findings; pending() neither mutates nor staleness-filters;
//              drain of an unknown session is [].

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { AsyncFindingQueue, type DeferredFinding } from "../async-finding-queue.js";

// ===========================================
// Deterministic clock
// ===========================================
// The whole file runs under fake timers pinned to FIXED_NOW. This makes
// `mkFinding()`'s default `computedAt` (which calls `new Date()`) a stable
// value, and — because the queue's *default* `now` is `Date.now`, also
// faked — keeps the default-clock tests well within the 10-minute TTL.
// Staleness tests still inject their own `now` so they are explicit about
// elapsed time rather than relying on the pin.

const FIXED_NOW = Date.parse("2026-05-18T12:00:00.000Z");

beforeAll(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
	vi.useRealTimers();
});

// ===========================================
// Helpers
// ===========================================

/**
 * Build a DeferredFinding with sensible defaults; override per test.
 *
 * The default `computedAt` resolves to FIXED_NOW (the pinned fake clock),
 * so tests using the queue's default `now` get a finding that is fresh
 * (well within the 10-minute TTL). Staleness tests override both
 * `computedAt` and the queue's `now` so they never depend on this default.
 */
function mkFinding(overrides: Partial<DeferredFinding> = {}): DeferredFinding {
	const check = overrides.check ?? "coverage_delta";
	const sourceFile = overrides.sourceFile ?? "src/harness/evaluator.ts";
	return {
		id: overrides.id ?? `${check}:${sourceFile}`,
		check,
		message: overrides.message ?? "[interlinked:coverage] coverage dropped 4%",
		computedAt: overrides.computedAt ?? new Date().toISOString(),
		sourceFile,
	};
}

// ===========================================
// Positive cases
// ===========================================

describe("AsyncFindingQueue — enqueue/drain roundtrip", () => {
	it("returns every enqueued finding for the session", () => {
		const q = new AsyncFindingQueue();
		const a = mkFinding({ id: "coverage_delta:a.ts", sourceFile: "a.ts" });
		const b = mkFinding({ id: "render_smoke:b.ts", check: "render_smoke", sourceFile: "b.ts" });
		q.enqueue("session-1", a);
		q.enqueue("session-1", b);

		const drained = q.drain("session-1");

		expect(drained).toHaveLength(2);
		expect(drained.map((f) => f.id)).toEqual(["coverage_delta:a.ts", "render_smoke:b.ts"]);
	});

	it("preserves message and computedAt verbatim through the queue", () => {
		const q = new AsyncFindingQueue();
		// computedAt is fresh relative to FIXED_NOW so the finding survives
		// drain — this test asserts field pass-through, not staleness.
		const computedAt = "2026-05-18T11:55:30.500Z";
		const finding = mkFinding({
			message: "[interlinked:render] smoke test rendered a blank page",
			computedAt,
		});
		q.enqueue("s", finding);

		const out = nonNull(q.drain("s")[0]);

		expect(out.message).toBe("[interlinked:render] smoke test rendered a blank page");
		expect(out.computedAt).toBe(computedAt);
	});
});

describe("AsyncFindingQueue — dedup by id", () => {
	it("replaces an existing finding with the same id, count stays 1", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("s", mkFinding({ id: "coverage_delta:a.ts", message: "stale" }));
		q.enqueue("s", mkFinding({ id: "coverage_delta:a.ts", message: "fresh" }));

		expect(q.pending("s")).toHaveLength(1);
		const out = nonNull(q.drain("s")[0]);
		// Newer computation wins.
		expect(out.message).toBe("fresh");
	});

	it("treats distinct ids as distinct entries even for the same check", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("s", mkFinding({ id: "coverage_delta:a.ts", sourceFile: "a.ts" }));
		q.enqueue("s", mkFinding({ id: "coverage_delta:b.ts", sourceFile: "b.ts" }));

		expect(q.drain("s")).toHaveLength(2);
	});
});

describe("AsyncFindingQueue — maxPerSession", () => {
	it("drops the oldest finding(s) when a session exceeds the cap", () => {
		const q = new AsyncFindingQueue({ maxPerSession: 3 });
		// Enqueue 5 distinct findings into a cap-3 session.
		for (let i = 0; i < 5; i++) {
			q.enqueue("s", mkFinding({ id: `check:${i}`, sourceFile: `f${i}.ts` }));
		}

		const drained = q.drain("s");

		// Only the 3 newest survive; ids 0 and 1 (oldest) were evicted.
		expect(drained.map((f) => f.id)).toEqual(["check:2", "check:3", "check:4"]);
	});

	it("re-enqueueing an existing id does not count against the cap", () => {
		const q = new AsyncFindingQueue({ maxPerSession: 2 });
		q.enqueue("s", mkFinding({ id: "check:0" }));
		q.enqueue("s", mkFinding({ id: "check:1" }));
		// Replacing check:0 must not evict check:1 — replacement is in place.
		q.enqueue("s", mkFinding({ id: "check:0", message: "updated" }));

		const drained = q.drain("s");
		expect(drained.map((f) => f.id).sort()).toEqual(["check:0", "check:1"]);
	});
});

describe("AsyncFindingQueue — clearSession", () => {
	it("empties a session's queue", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("s", mkFinding());
		expect(q.pending("s")).toHaveLength(1);

		q.clearSession("s");

		expect(q.pending("s")).toEqual([]);
		expect(q.drain("s")).toEqual([]);
	});

	it("is a no-op for an unknown session", () => {
		const q = new AsyncFindingQueue();
		// A buggy clearSession that wipes every session (rather than just the
		// named one) would still "not throw" — pin that an unrelated session's
		// queue survives the call, not merely that it's exception-free.
		q.enqueue("other", mkFinding({ id: "check:0" }));
		expect(() => q.clearSession("never-seen")).not.toThrow();
		expect(q.pending("other").map((f) => f.id)).toEqual(["check:0"]);
	});
});

// ===========================================
// Negative / edge cases
// ===========================================

describe("AsyncFindingQueue — drain is atomic", () => {
	it("a second drain of the same session returns []", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("s", mkFinding());

		expect(q.drain("s")).toHaveLength(1);
		expect(q.drain("s")).toEqual([]);
	});

	it("leaves the session empty after draining", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("s", mkFinding());
		q.drain("s");

		expect(q.pending("s")).toEqual([]);
	});
});

describe("AsyncFindingQueue — per-session isolation", () => {
	it("draining session A never returns session B's findings", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("session-A", mkFinding({ id: "a-only", sourceFile: "a.ts" }));
		q.enqueue("session-B", mkFinding({ id: "b-only", sourceFile: "b.ts" }));

		const drainedA = q.drain("session-A");

		expect(drainedA.map((f) => f.id)).toEqual(["a-only"]);
		// B is untouched by A's drain.
		expect(q.pending("session-B").map((f) => f.id)).toEqual(["b-only"]);
	});

	it("maxPerSession is enforced independently per session", () => {
		const q = new AsyncFindingQueue({ maxPerSession: 1 });
		q.enqueue("A", mkFinding({ id: "a:0" }));
		q.enqueue("B", mkFinding({ id: "b:0" }));

		// Each session still holds its single finding — no cross-session eviction.
		expect(q.pending("A")).toHaveLength(1);
		expect(q.pending("B")).toHaveLength(1);
	});
});

describe("AsyncFindingQueue — staleness", () => {
	it("drains drop a finding older than ttlMs", () => {
		// Inject a clock 11 minutes past the finding's computedAt; ttl is 10m.
		const computedAt = "2026-05-18T12:00:00.000Z";
		const elevenMinutesLater = Date.parse(computedAt) + 11 * 60_000;
		const q = new AsyncFindingQueue({
			ttlMs: 600_000,
			now: () => elevenMinutesLater,
		});
		q.enqueue("s", mkFinding({ computedAt }));

		// Stale → dropped, never returned.
		expect(q.drain("s")).toEqual([]);
	});

	it("keeps a finding still within ttlMs", () => {
		const computedAt = "2026-05-18T12:00:00.000Z";
		const nineMinutesLater = Date.parse(computedAt) + 9 * 60_000;
		const q = new AsyncFindingQueue({
			ttlMs: 600_000,
			now: () => nineMinutesLater,
		});
		q.enqueue("s", mkFinding({ computedAt }));

		expect(q.drain("s")).toHaveLength(1);
	});

	it("drops only the stale findings, returning the fresh ones", () => {
		const base = Date.parse("2026-05-18T12:00:00.000Z");
		const drainTime = base + 30 * 60_000; // 30 minutes after base
		const q = new AsyncFindingQueue({ ttlMs: 600_000, now: () => drainTime });
		// stale: computed 30m before drain; fresh: computed 5m before drain.
		q.enqueue("s", mkFinding({ id: "stale", computedAt: new Date(base).toISOString() }));
		q.enqueue(
			"s",
			mkFinding({ id: "fresh", computedAt: new Date(drainTime - 5 * 60_000).toISOString() }),
		);

		const drained = q.drain("s");

		expect(drained.map((f) => f.id)).toEqual(["fresh"]);
	});
});

describe("AsyncFindingQueue — pending does not mutate or staleness-filter", () => {
	it("pending returns findings without draining them", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("s", mkFinding());

		expect(q.pending("s")).toHaveLength(1);
		// Still drainable — pending was a peek, not a take.
		expect(q.drain("s")).toHaveLength(1);
	});

	it("pending shows stale findings (no staleness filtering)", () => {
		const computedAt = "2026-05-18T12:00:00.000Z";
		const wayLater = Date.parse(computedAt) + 60 * 60_000; // 1 hour later
		const q = new AsyncFindingQueue({ ttlMs: 600_000, now: () => wayLater });
		q.enqueue("s", mkFinding({ computedAt }));

		// pending() ignores staleness — introspection sees the stale entry...
		expect(q.pending("s")).toHaveLength(1);
		// ...while drain() drops it.
		expect(q.drain("s")).toEqual([]);
	});

	it("mutating the array returned by pending does not affect the queue", () => {
		const q = new AsyncFindingQueue();
		q.enqueue("s", mkFinding());

		const peeked = q.pending("s");
		assert(Array.isArray(peeked));
		peeked.pop();

		// Defensive copy — the real queue is intact.
		expect(q.pending("s")).toHaveLength(1);
	});
});

describe("AsyncFindingQueue — unknown session", () => {
	it("drain of an unknown session returns []", () => {
		const q = new AsyncFindingQueue();
		expect(q.drain("never-enqueued")).toEqual([]);
	});

	it("pending of an unknown session returns []", () => {
		const q = new AsyncFindingQueue();
		expect(q.pending("never-enqueued")).toEqual([]);
	});
});
import assert from "node:assert/strict";
