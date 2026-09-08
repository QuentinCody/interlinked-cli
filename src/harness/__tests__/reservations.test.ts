// Property-based tests for the reservation state machine + integration
// tests for the optimistic-grant rollback.
//
// Pure-machine tests exercise `applyTransition` / `replayTransitions`
// directly (no I/O, no cohort, no timers) to assert invariants Bitar's
// SSoT framing buys us:
//   - replay(events) == applyEvent loop on the same events (no drift)
//   - release is idempotent and ownership-respecting
//   - no two distinct agents ever appear as holders of the same file
//   - evict_remote leaves local entries alone
//   - release_all targets exactly the named agent
//
// Integration tests exercise the rollback gap that previously had a
// silent `.catch(() => {})`: a server-rejected optimistic grant must
// remove the local entry and emit a conflict with reason "server-rejected".

import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "../cohort.js";
import {
	applyTransition,
	canonicalAgent,
	type ReservationCache,
	type ReservationEventSink,
	type ReservationLogEvent,
	ReservationManager,
	type ReservationTxn,
	replayTransitions,
	type ServerApiClient,
	type ServerReservation,
	sameOwner,
} from "../reservations.js";
import { ServerBridge } from "../server-bridge.js";
import type { HarnessEvent } from "../types.js";

// ===========================================
// Generators
// ===========================================

const fileArb = fc.constantFrom("a.ts", "b.ts", "c.ts", "d.ts");
const agentArb = fc.constantFrom("alice", "bob", "carol");

const grantLocalArb = fc.record({
	kind: fc.constant("grant_local" as const),
	file: fileArb,
	agent: agentArb,
	reservedAt: fc.constant("2026-05-01T00:00:00.000Z"),
	expiresAt: fc.constant("2026-05-01T01:00:00.000Z"),
});

const grantRemoteArb = fc.record({
	kind: fc.constant("grant_remote" as const),
	file: fileArb,
	agent: agentArb,
	reservedAt: fc.constant("2026-05-01T00:00:00.000Z"),
	expiresAt: fc.constant("2026-05-01T01:00:00.000Z"),
});

const releaseArb = fc.record({
	kind: fc.constant("release" as const),
	file: fileArb,
	agent: agentArb,
});

const releaseAllArb = fc.record({
	kind: fc.constant("release_all" as const),
	agent: agentArb,
});

const expireArb = fc.record({
	kind: fc.constant("expire" as const),
	file: fileArb,
});

const evictRemoteArb = fc.record({
	kind: fc.constant("evict_remote" as const),
	file: fileArb,
});

const txnArb: fc.Arbitrary<ReservationTxn> = fc.oneof(
	grantLocalArb,
	grantRemoteArb,
	releaseArb,
	releaseAllArb,
	expireArb,
	evictRemoteArb,
);

const txnSeqArb = fc.array(txnArb, { minLength: 0, maxLength: 50 });

function serialize(state: ReservationCache): Array<[string, unknown]> {
	return [...state.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => [k, { ...v }]);
}

// ===========================================
// Pure machine — Bitar SSoT invariants
// ===========================================

describe("ReservationTxn — pure state machine", () => {
	it("replay produces identical state to incremental application (Bitar invariant)", () => {
		fc.assert(
			fc.property(txnSeqArb, (events) => {
				const live: ReservationCache = new Map();
				for (const e of events) applyTransition(live, e);
				const replayed = replayTransitions(events);
				expect(serialize(live)).toEqual(serialize(replayed));
			}),
			{ numRuns: 200 },
		);
	});

	it("no two distinct agents ever appear as holders of the same file", () => {
		fc.assert(
			fc.property(txnSeqArb, (events) => {
				const state = replayTransitions(events);
				const seen = new Map<string, string>();
				for (const [file, entry] of state) {
					const prior = seen.get(file);
					expect(prior === undefined || prior === entry.agent_name).toBe(true);
					seen.set(file, entry.agent_name);
				}
			}),
			{ numRuns: 100 },
		);
	});

	it("release is idempotent: release(x,a) twice yields the same state as once", () => {
		const seed: ReservationTxn[] = [
			{ kind: "grant_local", file: "a.ts", agent: "alice", reservedAt: "t0", expiresAt: "t1" },
		];
		const once = replayTransitions([...seed, { kind: "release", file: "a.ts", agent: "alice" }]);
		const twice = replayTransitions([
			...seed,
			{ kind: "release", file: "a.ts", agent: "alice" },
			{ kind: "release", file: "a.ts", agent: "alice" },
		]);
		expect(serialize(once)).toEqual(serialize(twice));
	});

	it("release does NOT remove an entry held by a different agent", () => {
		const state = replayTransitions([
			{ kind: "grant_local", file: "a.ts", agent: "alice", reservedAt: "t0", expiresAt: "t1" },
			{ kind: "release", file: "a.ts", agent: "bob" }, // wrong owner
		]);
		expect(state.get("a.ts")?.agent_name).toBe("alice");
	});

	it("evict_remote leaves local entries untouched", () => {
		const state = replayTransitions([
			{ kind: "grant_local", file: "a.ts", agent: "alice", reservedAt: "t0", expiresAt: "t1" },
			{ kind: "grant_remote", file: "b.ts", agent: "bob", reservedAt: "t0", expiresAt: "t1" },
			{ kind: "evict_remote", file: "a.ts" },
			{ kind: "evict_remote", file: "b.ts" },
		]);
		expect(state.get("a.ts")?.cohort).toBe("local");
		expect(state.has("b.ts")).toBe(false);
	});

	it("release_all removes every entry held by the agent and only those", () => {
		fc.assert(
			fc.property(txnSeqArb, agentArb, (events, victim) => {
				const finalState = replayTransitions([
					...events,
					{ kind: "release_all", agent: victim },
				]);
				for (const [, entry] of finalState) {
					expect(entry.agent_name).not.toBe(victim);
				}
			}),
			{ numRuns: 100 },
		);
	});

	it("expire(file) is a no-op when the file is not in the cache", () => {
		const empty = replayTransitions([{ kind: "expire", file: "phantom.ts" }]);
		expect(empty.size).toBe(0);
	});
});

// ===========================================
// Agent-identity canonicalization — session self-conflict fix
// ===========================================
//
// Regression guard for the mcp-agent-chat holdover: one CLI session could
// surface under two synthetic names (`session-<id>` from one hook path,
// `session-<source>-<id>` from another) and block itself out of files it
// had just reserved. `canonicalAgent` collapses the variants; `sameOwner`
// is the ownership predicate now used throughout ReservationManager.

describe("canonicalAgent / sameOwner — session identity", () => {
	it("collapses the session-<source>-<id> variant to session-<id>", () => {
		expect(canonicalAgent("session-claude-2d113be2")).toBe("session-2d113be2");
		expect(canonicalAgent("session-codex-2d113be2")).toBe("session-2d113be2");
		expect(canonicalAgent("session-2d113be2")).toBe("session-2d113be2");
	});

	it("passes non-session names through unchanged (explicit + subagent ids)", () => {
		expect(canonicalAgent("alice")).toBe("alice");
		expect(canonicalAgent("sub-abcd1234")).toBe("sub-abcd1234");
		// "clauded" is not the "claude" source token — must NOT be stripped.
		expect(canonicalAgent("session-clauded-x")).toBe("session-clauded-x");
	});

	it("treats name variants of one session as the same owner", () => {
		expect(sameOwner("session-2d113be2", "session-claude-2d113be2")).toBe(true);
		expect(sameOwner("session-claude-2d113be2", "session-2d113be2")).toBe(true);
		expect(sameOwner("session-2d113be2", "session-2d113be2")).toBe(true);
	});

	it("keeps genuinely different sessions / agents distinct", () => {
		expect(sameOwner("session-2d113be2", "session-99999999")).toBe(false);
		expect(sameOwner("session-claude-2d113be2", "session-claude-99999999")).toBe(false);
		expect(sameOwner("alice", "bob")).toBe(false);
	});
});

describe("ReservationManager — session self-conflict (regression)", () => {
	let events: ReservationLogEvent[];
	let cohort: CohortManager;
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		events = [];
		cohort = new CohortManager();
		// No apiClient: mirror the local daemon with no server configured, so
		// the grant path is purely local (no async confirm to flush).
		mgr = new ReservationManager(undefined, 60_000_000, sink);
	});

	afterEach(() => {
		mgr?.shutdown();
	});

	it("a session's other name variant does NOT conflict with its own reservation", () => {
		expect(mgr.checkAndReserve("doc.md", "session-2d113be2", cohort)).toBeNull();
		// Same session, different synthetic name — must be recognized as self.
		const conflict = mgr.checkAndReserve("doc.md", "session-claude-2d113be2", cohort);
		expect(conflict).toBeNull();
		expect(events.some((e) => e.action === "conflict")).toBe(false);
	});

	it("release under a different name variant frees the reservation", () => {
		mgr.checkAndReserve("doc.md", "session-2d113be2", cohort);
		mgr.release("doc.md", "session-claude-2d113be2", cohort);
		expect(mgr.getAll()).toEqual([]);
	});

	it("a genuinely different session still conflicts (coordination preserved)", () => {
		mgr.checkAndReserve("doc.md", "session-2d113be2", cohort);
		const conflict = mgr.checkAndReserve("doc.md", "session-99999999", cohort);
		expect(conflict).not.toBeNull();
		expect(conflict?.agent_name).toBe("session-2d113be2");
	});
});

// ===========================================
// ReservationManager — optimistic-grant rollback (the load-bearing fix)
// ===========================================

class StubApi implements ServerApiClient {
	public reserveCalls: Array<[string, string, number]> = [];
	public releaseCalls: Array<[string, string]> = [];
	/** Number of times listReservations has been invoked (for interval assertions). */
	public listCalls = 0;

	constructor(
		private behavior: "accept" | "reject" = "accept",
		private listing: ServerReservation[] = [],
	) {}

	/** Replace the server-side reservation feed seen by the next refresh. */
	setListing(listing: ServerReservation[]): void {
		this.listing = listing;
	}

	async reserveFile(filePath: string, agentName: string, ttlSeconds: number): Promise<void> {
		this.reserveCalls.push([filePath, agentName, ttlSeconds]);
		if (this.behavior === "reject") throw new Error("server rejected");
	}
	async releaseFile(filePath: string, agentName: string): Promise<void> {
		this.releaseCalls.push([filePath, agentName]);
	}
	async listReservations(): Promise<ServerReservation[]> {
		this.listCalls += 1;
		return this.listing;
	}
}

function joinEvent(name: string): HarnessEvent {
	return {
		hook_event: "SessionStart",
		session_id: `${name}-session`,
		agent_source: "claude",
		agent_name: name,
		timestamp: "2026-05-01T00:00:00.000Z",
	};
}

function flushMicrotasks(): Promise<void> {
	return new Promise((r) => setImmediate(r));
}

describe("ReservationManager — optimistic-grant rollback", () => {
	let events: ReservationLogEvent[];
	let cohort: CohortManager;
	let mgr: ReservationManager;
	let api: StubApi;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		events = [];
		cohort = new CohortManager();
	});

	afterEach(() => {
		mgr?.shutdown();
	});

	it("server-accept: local grant persists and no conflict event fires", async () => {
		api = new StubApi("accept");
		mgr = new ReservationManager(api, 60_000_000, sink);
		const conflict = mgr.checkAndReserve("a.ts", "alice", cohort);
		expect(conflict).toBeNull();
		await flushMicrotasks();
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
	});

	it("server-reject rolls back the local grant + emits a server-rejected conflict event", async () => {
		api = new StubApi("reject");
		mgr = new ReservationManager(api, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));
		const conflict = mgr.checkAndReserve("a.ts", "alice", cohort);
		// Optimistic grant returns null synchronously — caller can proceed.
		expect(conflict).toBeNull();
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);
		// Async server-confirm fails → rollback happens on the microtask queue.
		await flushMicrotasks();
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		const rejectEvt = events.find(
			(e) => e.action === "conflict" && e.conflict_reason === "server-rejected",
		);
		expect(rejectEvt).toBeDefined();
		expect(rejectEvt?.file).toBe("a.ts");
		expect(rejectEvt?.agent_name).toBe("alice");
		// Cohort tracking is rolled back too.
		expect(cohort.getAgent("alice")?.files_reserved).toEqual([]);
	});

	it("server-reject clears a pending idle-release timer during rollback", async () => {
		// Covers rollbackOptimisticGrant's timer-cleanup arm (line 344-346): a
		// release timer armed between the optimistic grant and the async server
		// rejection must be cleared by the rollback so it can't fire later.
		vi.useFakeTimers();
		try {
			api = new StubApi("reject");
			mgr = new ReservationManager(api, 60_000_000, sink);
			cohort.agentJoined(joinEvent("alice"));

			mgr.checkAndReserve("race.ts", "alice", cohort); // optimistic local grant
			mgr.scheduleRelease("race.ts", "alice", cohort); // arm the idle-release timer
			expect(mgr.getAll().some((e) => e.file_pattern === "race.ts")).toBe(true);

			// Drain the rejected reserveFile promise → rollback runs, finds the
			// pending timer, and clears it.
			await vi.advanceTimersByTimeAsync(0);
			expect(mgr.getAll().some((e) => e.file_pattern === "race.ts")).toBe(false);

			const releasesBefore = events.filter((e) => e.action === "release").length;
			// Advance well past the idle timeout — the (now-cleared) timer must NOT fire.
			await vi.advanceTimersByTimeAsync(120_000);
			expect(events.filter((e) => e.action === "release").length).toBe(releasesBefore);
			// Exactly one server-rejected conflict was emitted by the rollback.
			expect(
				events.filter(
					(e) => e.action === "conflict" && e.conflict_reason === "server-rejected",
				).length,
			).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("server-reject after explicit release: cache stays empty + conflict still emits", async () => {
		api = new StubApi("reject");
		mgr = new ReservationManager(api, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		mgr.release("a.ts", "alice", cohort); // released before server replies
		await flushMicrotasks();
		expect(mgr.getAll()).toEqual([]);
		expect(events.some((e) => e.action === "release")).toBe(true);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
	});

	it("preexisting conflict is tagged differently than server-rejected", async () => {
		api = new StubApi("accept");
		mgr = new ReservationManager(api, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));
		cohort.agentJoined(joinEvent("bob"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		await flushMicrotasks();
		events.length = 0;
		const conflict = mgr.checkAndReserve("a.ts", "bob", cohort);
		expect(conflict?.agent_name).toBe("alice");
		const conflictEvt = events.find((ev) => ev.action === "conflict");
		expect(conflictEvt?.conflict_reason).toBe("preexisting");
	});
});

// ===========================================
// ServerBridge — real reserveFile() path (the regression of record)
// ===========================================
//
// The pre-fix `ServerBridge.reserveFile()` swallowed *all* callTool errors,
// so the rollback path in reservations.ts:266-269 only fired against the
// in-test StubApi. These tests exercise the real ServerBridge by mocking
// global fetch, so a regression that re-introduces a bare catch-all
// `void e` will fail here — not just in the stub.

describe("ServerBridge.reserveFile — real path (fetch-mocked)", () => {
	let cohort: CohortManager;
	let events: ReservationLogEvent[];
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		cohort = new CohortManager();
		events = [];
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		mgr?.shutdown();
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	function makeBridge(): ServerBridge {
		return new ServerBridge({
			serverUrl: "http://localhost:9999",
			workspaceKey: "main",
			projectKey: "main",
		});
	}

	function mockFetch(impl: (url: string) => Response | Promise<Response>): void {
		globalThis.fetch = vi.fn(((input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			return Promise.resolve(impl(url));
		}));
	}

	it("server-rejected (conflicts[] non-empty): rolls back local grant + emits server-rejected conflict", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			// /api/ui/call → file_reservation_paths returns explicit conflict
			return new Response(
				JSON.stringify({
					result: {
						granted: [],
						conflicts: [
							{ file: "a.ts", reserved_by: "other-agent", reservation_pattern: "a.ts" },
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		const conflict = mgr.checkAndReserve("a.ts", "alice", cohort);
		expect(conflict).toBeNull(); // optimistic local grant
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);

		// async server-confirm fails → rollback on microtask queue
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		const rejectEvt = events.find(
			(e) => e.action === "conflict" && e.conflict_reason === "server-rejected",
		);
		expect(rejectEvt).toBeDefined();
		expect(rejectEvt?.file).toBe("a.ts");
		expect(rejectEvt?.agent_name).toBe("alice");
		expect(cohort.getAgent("alice")?.files_reserved).toEqual([]);
		bridge.shutdown();
	});

	it("server-rejected (ok:false): rolls back local grant + emits server-rejected conflict", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response(JSON.stringify({ result: { ok: false, reason: "denied" } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("b.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "b.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});

	it("network error: optimistic grant is preserved (no rollback, no conflict event)", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			throw new TypeError("simulated network error");
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("c.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "c.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		expect(cohort.getAgent("alice")?.files_reserved).toContain("c.ts");
		bridge.shutdown();
	});

	it("HTTP 5xx (transient/timeout class): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("internal error", { status: 503 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("d.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		// callTool throws on !res.ok → swallowed → no rollback
		expect(mgr.getAll().some((e) => e.file_pattern === "d.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("server-accept (granted, empty conflicts): grant persists, no conflict", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response(
				JSON.stringify({ result: { granted: ["e.ts"], conflicts: [] } }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("e.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "e.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 409 (callTool throws explicit denial): rolls back local grant", async () => {
		// Pre-fix: callTool's `throw new Error("Server API error: 409")` was
		// caught and swallowed unconditionally, so 4xx denials never reached
		// the rollback path. Post-fix: isExplicitDenialError re-throws on 4xx.
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("conflict", { status: 409 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("f.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "f.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});

	it("HTTP 408 (request timeout class): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("timeout", { status: 408 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("g.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "g.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 429 (rate limited): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("too many", { status: 429 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("h.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "h.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 401 (auth/expired-token): optimistic grant is preserved (NOT a reservation conflict)", async () => {
		// Regression: pre-fix, ANY 4xx (except 408/429) was treated as a
		// reservation denial and rolled back the local grant. 401/403/404 say
		// nothing about whether another agent holds the file — they're
		// auth/config errors. They must fail open.
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("expired token", { status: 401 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("auth.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "auth.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 403 (forbidden): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("forbidden", { status: 403 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("forbidden.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "forbidden.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 404 (wrong server URL / endpoint missing): optimistic grant is preserved", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("not found", { status: 404 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("nf.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "nf.ts")).toBe(true);
		expect(events.find((e) => e.action === "conflict")).toBeUndefined();
		bridge.shutdown();
	});

	it("HTTP 423 (Locked): rolls back — explicit reservation denial", async () => {
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response("locked", { status: 423 });
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("locked.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "locked.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});

	it("server-rejected with normalized path (`./a.ts` vs `a.ts`): rolls back", async () => {
		// Pre-fix: the classifier compared conflicts[].file === filePath with
		// raw equality. A server that normalized paths (./a.ts vs a.ts, abs
		// vs rel) would slip past the rejection check, leaving the optimistic
		// grant in place — recreating the double-allocation bug.
		mockFetch((url) => {
			if (url.endsWith("/health")) return new Response("ok", { status: 200 });
			return new Response(
				JSON.stringify({
					result: {
						granted: [],
						conflicts: [
							{ file: "./a.ts", reserved_by: "other-agent" }, // note the leading ./
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const bridge = makeBridge();
		mgr = new ReservationManager(bridge, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("a.ts", "alice", cohort);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		bridge.shutdown();
	});
});

// ===========================================
// emit — no eventSink configured
// ===========================================

describe("ReservationManager — emit without an eventSink", () => {
	it("grants/releases work with no sink (emit early-returns, never throws)", () => {
		const cohort = new CohortManager();
		// No sink, no apiClient: emit() must hit the `!this.eventSink` early return.
		const mgr = new ReservationManager();
		try {
			expect(mgr.checkAndReserve("solo.ts", "alice", cohort)).toBeNull();
			expect(mgr.getAll().some((e) => e.file_pattern === "solo.ts")).toBe(true);
			// release also calls emit() — still a no-op, still removes the entry.
			mgr.release("solo.ts", "alice", cohort);
			expect(mgr.getAll()).toEqual([]);
		} finally {
			mgr.shutdown();
		}
	});

	it("a throwing eventSink does not break the lock primitive (emit swallows sink errors)", () => {
		const cohort = new CohortManager();
		let calls = 0;
		const throwingSink: ReservationEventSink = () => {
			calls += 1;
			throw new Error("sink blew up");
		};
		const mgr = new ReservationManager(undefined, 60_000_000, throwingSink);
		try {
			// grant fires the sink; the throw must be caught inside emit().
			expect(() => mgr.checkAndReserve("x.ts", "alice", cohort)).not.toThrow();
			expect(calls).toBeGreaterThan(0);
			// the grant still landed despite the sink throwing
			expect(mgr.getAll().some((e) => e.file_pattern === "x.ts")).toBe(true);
		} finally {
			mgr.shutdown();
		}
	});
});

// ===========================================
// checkAndReserve — expiry pruning during conflict scan
// ===========================================

describe("ReservationManager — expired holder is pruned, not treated as a conflict", () => {
	let cohort: CohortManager;
	let events: ReservationLogEvent[];
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		cohort = new CohortManager();
		events = [];
	});
	afterEach(() => {
		mgr?.shutdown();
	});

	it("an expired reservation by another agent is pruned and the new agent gets the grant", async () => {
		// Seed an already-expired remote reservation for "bob" via the server feed.
		const pastIso = new Date(Date.now() - 60_000).toISOString();
		const api = new StubApi("accept", [
			{ agent_name: "bob", path_pattern: "shared.ts", expires_at: pastIso },
		]);
		mgr = new ReservationManager(api, 60_000_000, sink);
		await flushMicrotasks(); // let the constructor's initial refresh land bob's entry
		// NB: do NOT call getAll() here — it would prune the expired entry first.
		// We want checkAndReserve's own in-scan expiry prune (line 256-258) to fire.

		// alice now writes shared.ts — bob's entry is expired, so it's pruned in the
		// conflict scan (line 256-258) and alice is granted instead of blocked.
		const conflict = mgr.checkAndReserve("shared.ts", "alice", cohort);
		expect(conflict).toBeNull();
		await flushMicrotasks();
		const entry = mgr.getAll().find((e) => e.file_pattern === "shared.ts");
		expect(entry?.agent_name).toBe("alice");
		expect(entry?.cohort).toBe("local");
	});

	it("a non-expired holder in a different cohort is reported as remote", async () => {
		const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
		// bob is on the server (remote) but NOT registered in this local cohort.
		const api = new StubApi("accept", [
			{ agent_name: "bob", path_pattern: "live.ts", expires_at: futureIso },
		]);
		mgr = new ReservationManager(api, 60_000_000, sink);
		await flushMicrotasks();

		const conflict = mgr.checkAndReserve("live.ts", "alice", cohort);
		expect(conflict).not.toBeNull();
		expect(conflict?.agent_name).toBe("bob");
		// cohort.hasAgent("bob") is false → classified remote (line 260-263).
		expect(conflict?.cohort).toBe("remote");
		const conflictEvt = events.find((e) => e.action === "conflict");
		expect(conflictEvt?.cohort).toBe("remote");
		expect(conflictEvt?.conflict_reason).toBe("preexisting");
	});
});

// ===========================================
// scheduleRelease — idle auto-release timer
// ===========================================

describe("ReservationManager — scheduleRelease (idle auto-release)", () => {
	let cohort: CohortManager;
	let events: ReservationLogEvent[];
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		vi.useFakeTimers();
		cohort = new CohortManager();
		events = [];
		mgr = new ReservationManager(undefined, 60_000_000, sink);
	});
	afterEach(() => {
		mgr?.shutdown();
		vi.useRealTimers();
	});

	it("auto-releases the file after the idle timeout fires", () => {
		mgr.checkAndReserve("idle.ts", "alice", cohort);
		expect(mgr.getAll().some((e) => e.file_pattern === "idle.ts")).toBe(true);

		mgr.scheduleRelease("idle.ts", "alice", cohort);
		// Nothing released yet — timer is pending.
		expect(mgr.getAll().some((e) => e.file_pattern === "idle.ts")).toBe(true);

		// Advance past AUTO_RELEASE_MS (30s). The setTimeout body releases + deletes.
		vi.advanceTimersByTime(30_000);
		expect(mgr.getAll().some((e) => e.file_pattern === "idle.ts")).toBe(false);
		expect(events.some((e) => e.action === "release" && e.file === "idle.ts")).toBe(true);
	});

	it("re-scheduling resets the timer (debounce): an edit before timeout pushes release out", () => {
		mgr.checkAndReserve("hot.ts", "alice", cohort);
		mgr.scheduleRelease("hot.ts", "alice", cohort);

		vi.advanceTimersByTime(20_000); // not yet expired
		mgr.scheduleRelease("hot.ts", "alice", cohort); // resets — clears the old timer
		vi.advanceTimersByTime(20_000); // 40s total, but only 20s since the reset
		// Still held, because the reset pushed the deadline to 50s total.
		expect(mgr.getAll().some((e) => e.file_pattern === "hot.ts")).toBe(true);

		vi.advanceTimersByTime(10_000); // now 30s since the reset
		expect(mgr.getAll().some((e) => e.file_pattern === "hot.ts")).toBe(false);
	});

	it("scheduleRelease is a no-op when the file is not reserved", () => {
		mgr.scheduleRelease("ghost.ts", "alice", cohort);
		vi.advanceTimersByTime(30_000);
		// Nothing to release; no release event emitted.
		expect(events.some((e) => e.action === "release")).toBe(false);
	});

	it("scheduleRelease is a no-op when a different agent owns the file", () => {
		mgr.checkAndReserve("owned.ts", "alice", cohort);
		// bob is a genuinely different owner — must not schedule a release.
		mgr.scheduleRelease("owned.ts", "bob", cohort);
		vi.advanceTimersByTime(30_000);
		expect(mgr.getAll().some((e) => e.file_pattern === "owned.ts")).toBe(true);
	});

	it("schedules under a name variant but releases the stored owner identity", () => {
		// grant under the bare session id, schedule under the per-source variant.
		mgr.checkAndReserve("variant.ts", "session-2d113be2", cohort);
		mgr.scheduleRelease("variant.ts", "session-claude-2d113be2", cohort);
		vi.advanceTimersByTime(30_000);
		expect(mgr.getAll()).toEqual([]);
		// the release event is keyed on the STORED owner, not the caller variant.
		const rel = events.find((e) => e.action === "release");
		expect(rel?.agent_name).toBe("session-2d113be2");
	});
});

// ===========================================
// release — server-side release + timer cleanup
// ===========================================

describe("ReservationManager — release (server + timer cleanup)", () => {
	let cohort: CohortManager;
	let events: ReservationLogEvent[];
	let mgr: ReservationManager;
	let api: StubApi;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		cohort = new CohortManager();
		events = [];
	});
	afterEach(() => {
		mgr?.shutdown();
		vi.useRealTimers();
	});

	it("release() calls the server's releaseFile with the stored owner", async () => {
		api = new StubApi("accept");
		mgr = new ReservationManager(api, 60_000_000, sink);
		mgr.checkAndReserve("rel.ts", "alice", cohort);
		await flushMicrotasks();
		api.releaseCalls.length = 0;

		mgr.release("rel.ts", "alice", cohort);
		await flushMicrotasks();
		expect(api.releaseCalls).toContainEqual(["rel.ts", "alice"]);
		expect(mgr.getAll()).toEqual([]);
	});

	it("release() is a no-op for a file not in the cache (no server call, no event)", async () => {
		api = new StubApi("accept");
		mgr = new ReservationManager(api, 60_000_000, sink);
		await flushMicrotasks();
		api.releaseCalls.length = 0;
		events.length = 0;

		mgr.release("missing.ts", "alice", cohort);
		await flushMicrotasks();
		expect(api.releaseCalls).toEqual([]);
		expect(events.some((e) => e.action === "release")).toBe(false);
	});

	it("release() is a no-op when a different agent owns the entry", () => {
		mgr = new ReservationManager(undefined, 60_000_000, sink);
		mgr.checkAndReserve("mine.ts", "alice", cohort);
		mgr.release("mine.ts", "bob", cohort); // wrong owner
		expect(mgr.getAll().some((e) => e.file_pattern === "mine.ts")).toBe(true);
	});

	it("explicit release() clears the pending idle timer (no double release later)", () => {
		vi.useFakeTimers();
		mgr = new ReservationManager(undefined, 60_000_000, sink);
		mgr.checkAndReserve("timed.ts", "alice", cohort);
		mgr.scheduleRelease("timed.ts", "alice", cohort); // arms the auto-release timer

		mgr.release("timed.ts", "alice", cohort); // explicit release clears that timer
		expect(mgr.getAll()).toEqual([]);
		const releaseCount = events.filter((e) => e.action === "release").length;

		// Advancing past the timeout must NOT fire a second release.
		vi.advanceTimersByTime(60_000);
		expect(events.filter((e) => e.action === "release").length).toBe(releaseCount);
	});

	it("server-side releaseFile rejection is swallowed (best-effort, reconciled by TTL)", async () => {
		// releaseFile that throws must not propagate — release() catches it.
		class RejectReleaseApi extends StubApi {
			override async releaseFile(filePath: string, agentName: string): Promise<void> {
				this.releaseCalls.push([filePath, agentName]);
				throw new Error("server release failed");
			}
		}
		api = new RejectReleaseApi("accept");
		mgr = new ReservationManager(api, 60_000_000, sink);
		mgr.checkAndReserve("rj.ts", "alice", cohort);
		await flushMicrotasks();

		expect(() => mgr.release("rj.ts", "alice", cohort)).not.toThrow();
		await flushMicrotasks();
		expect(mgr.getAll()).toEqual([]);
		expect(api.releaseCalls).toContainEqual(["rj.ts", "alice"]);
	});
});

// ===========================================
// releaseAllForAgent — bulk release on session end
// ===========================================

describe("ReservationManager — releaseAllForAgent", () => {
	let cohort: CohortManager;
	let events: ReservationLogEvent[];
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		cohort = new CohortManager();
		events = [];
		mgr = new ReservationManager(undefined, 60_000_000, sink);
	});
	afterEach(() => {
		mgr?.shutdown();
	});

	it("releases every file held by the agent and emits a release_all summary", () => {
		mgr.checkAndReserve("one.ts", "alice", cohort);
		mgr.checkAndReserve("two.ts", "alice", cohort);
		mgr.checkAndReserve("other.ts", "bob", cohort);

		mgr.releaseAllForAgent("alice", cohort);

		const remaining = mgr.getAll().map((e) => e.file_pattern);
		expect(remaining).toEqual(["other.ts"]); // bob's file survives
		// individual release events + one release_all summary
		expect(events.some((e) => e.action === "release" && e.file === "one.ts")).toBe(true);
		expect(events.some((e) => e.action === "release" && e.file === "two.ts")).toBe(true);
		const summary = events.find((e) => e.action === "release_all");
		expect(summary).toBeDefined();
		expect(summary?.file).toBe("[2 files]");
		expect(summary?.agent_name).toBe("alice");
	});

	it("emits NO release_all summary when the agent held nothing", () => {
		mgr.checkAndReserve("held.ts", "bob", cohort);
		mgr.releaseAllForAgent("alice", cohort); // alice holds nothing
		expect(events.some((e) => e.action === "release_all")).toBe(false);
		// bob's reservation untouched
		expect(mgr.getAll().some((e) => e.file_pattern === "held.ts")).toBe(true);
	});

	it("collapses name variants — releaseAllForAgent under one variant frees all the session's files", () => {
		mgr.checkAndReserve("a.ts", "session-2d113be2", cohort);
		mgr.checkAndReserve("b.ts", "session-claude-2d113be2", cohort);
		// both grants belong to the same canonical session; one call clears both.
		mgr.releaseAllForAgent("session-codex-2d113be2", cohort);
		expect(mgr.getAll()).toEqual([]);
	});
});

// ===========================================
// getForAgent / getAll — read + expiry pruning
// ===========================================

describe("ReservationManager — getForAgent / getAll expiry pruning", () => {
	let cohort: CohortManager;
	let mgr: ReservationManager;

	beforeEach(() => {
		cohort = new CohortManager();
	});
	afterEach(() => {
		mgr?.shutdown();
	});

	it("getForAgent returns only that agent's reservations (across name variants)", () => {
		mgr = new ReservationManager(undefined, 60_000_000);
		mgr.checkAndReserve("a.ts", "session-2d113be2", cohort);
		mgr.checkAndReserve("b.ts", "bob", cohort);

		const mine = mgr.getForAgent("session-claude-2d113be2");
		expect(mine.map((e) => e.file_pattern).sort()).toEqual(["a.ts"]);
		expect(mgr.getForAgent("bob").map((e) => e.file_pattern)).toEqual(["b.ts"]);
		expect(mgr.getForAgent("nobody")).toEqual([]);
	});

	it("getAll prunes entries whose expires_at has passed", async () => {
		const pastIso = new Date(Date.now() - 60_000).toISOString();
		const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
		const api = new StubApi("accept", [
			{ agent_name: "ann", path_pattern: "stale.ts", expires_at: pastIso },
			{ agent_name: "ben", path_pattern: "fresh.ts", expires_at: futureIso },
		]);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks(); // initial refresh upserts both

		const all = mgr.getAll().map((e) => e.file_pattern);
		// stale.ts pruned by the expiry sweep (line 456-457); fresh.ts retained.
		expect(all).toEqual(["fresh.ts"]);
	});

	it("getAll keeps a server entry that omits expires_at (no-expiry branch)", async () => {
		// expires_at omitted by the server → reservation upsert fills a default
		// future TTL, so it is NOT pruned. Exercises the falsy-guard short circuit
		// in both getAll and the upsert default.
		const api = new StubApi("accept", [{ agent_name: "cara", path_pattern: "noexp.ts" }]);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks();
		expect(mgr.getAll().some((e) => e.file_pattern === "noexp.ts")).toBe(true);
	});
});

// ===========================================
// refreshFromServer — eviction + upsert + cohort authority
// ===========================================

describe("ReservationManager — refreshFromServer", () => {
	let cohort: CohortManager;
	let mgr: ReservationManager;

	beforeEach(() => {
		cohort = new CohortManager();
	});
	afterEach(() => {
		mgr?.shutdown();
	});

	it("upserts server reservations as remote entries", async () => {
		const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
		const api = new StubApi("accept", [
			{ agent_name: "remote-1", path_pattern: "srv.ts", expires_at: futureIso },
		]);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks();

		const entry = mgr.getAll().find((e) => e.file_pattern === "srv.ts");
		expect(entry?.agent_name).toBe("remote-1");
		expect(entry?.cohort).toBe("remote");
		expect(entry?.expires_at).toBe(futureIso);
	});

	it("evicts a remote entry that disappears from the server feed", async () => {
		const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
		const api = new StubApi("accept", [
			{ agent_name: "remote-1", path_pattern: "gone.ts", expires_at: futureIso },
		]);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks();
		expect(mgr.getAll().some((e) => e.file_pattern === "gone.ts")).toBe(true);

		// Server no longer lists gone.ts → next refresh evicts it (line 482-483).
		api.setListing([]);
		await mgr.refreshFromServer();
		expect(mgr.getAll().some((e) => e.file_pattern === "gone.ts")).toBe(false);
	});

	it("does NOT evict a LOCAL entry that is absent from the server feed", async () => {
		const api = new StubApi("accept", []);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks();

		// Local optimistic grant — server feed never mentions it.
		mgr.checkAndReserve("localonly.ts", "alice", cohort);
		await flushMicrotasks();
		await mgr.refreshFromServer(); // eviction only targets cohort==="remote"
		expect(mgr.getAll().some((e) => e.file_pattern === "localonly.ts")).toBe(true);
	});

	it("does NOT overwrite a local grant with a server (remote) entry for the same path", async () => {
		const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
		const api = new StubApi("accept", []);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks();

		// alice locally holds shared.ts.
		mgr.checkAndReserve("shared.ts", "alice", cohort);
		await flushMicrotasks();

		// Server now claims shared.ts for someone else; the upsert guard
		// (`!existing || existing.cohort === "remote"`) must keep alice's LOCAL grant.
		api.setListing([
			{ agent_name: "intruder", path_pattern: "shared.ts", expires_at: futureIso },
		]);
		await mgr.refreshFromServer();

		const entry = mgr.getAll().find((e) => e.file_pattern === "shared.ts");
		expect(entry?.agent_name).toBe("alice");
		expect(entry?.cohort).toBe("local");
	});

	it("refreshes an existing REMOTE entry's holder from the server", async () => {
		const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
		const api = new StubApi("accept", [
			{ agent_name: "holder-a", path_pattern: "rmt.ts", expires_at: futureIso },
		]);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks();
		expect(mgr.getAll().find((e) => e.file_pattern === "rmt.ts")?.agent_name).toBe("holder-a");

		// Server reassigns the same remote path to a different holder.
		api.setListing([{ agent_name: "holder-b", path_pattern: "rmt.ts", expires_at: futureIso }]);
		await mgr.refreshFromServer();
		expect(mgr.getAll().find((e) => e.file_pattern === "rmt.ts")?.agent_name).toBe("holder-b");
	});

	it("refreshFromServer is a no-op with no apiClient", async () => {
		mgr = new ReservationManager(undefined, 60_000_000);
		await expect(mgr.refreshFromServer()).resolves.toBeUndefined();
		expect(mgr.getAll()).toEqual([]);
	});

	it("listReservations rejection is swallowed (cache left intact)", async () => {
		class ThrowListApi extends StubApi {
			override async listReservations(): Promise<ServerReservation[]> {
				throw new Error("list failed");
			}
		}
		const api = new ThrowListApi("accept");
		mgr = new ReservationManager(api, 60_000_000);
		// Constructor's initial refresh hits the catch; must not throw.
		await flushMicrotasks();
		// A direct call also swallows.
		await expect(mgr.refreshFromServer()).resolves.toBeUndefined();
		expect(mgr.getAll()).toEqual([]);
	});

	it("periodic interval refresh pulls new server reservations over time", async () => {
		vi.useFakeTimers();
		try {
			const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();
			const api = new StubApi("accept", []);
			// Small refresh interval so the setInterval callback fires under fake timers.
			mgr = new ReservationManager(api, 1_000);
			await vi.advanceTimersByTimeAsync(0); // flush the constructor's initial refresh
			expect(mgr.getAll()).toEqual([]);

			// New server-side reservation appears; the periodic tick should pick it up.
			api.setListing([
				{ agent_name: "late", path_pattern: "tick.ts", expires_at: futureIso },
			]);
			await vi.advanceTimersByTimeAsync(1_000); // fire one interval
			expect(mgr.getAll().some((e) => e.file_pattern === "tick.ts")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

// ===========================================
// pathMatchesPattern — glob arms (exercised via remote-reservation patterns)
// ===========================================
//
// pathMatchesPattern is private; the only way a non-literal pattern lands in
// the cache is a server reservation whose path_pattern is a glob. We seed the
// pattern via the server feed, then checkAndReserve a candidate path — a match
// surfaces as a conflict (a different remote holder), a non-match as a grant.

describe("ReservationManager — pathMatchesPattern (glob matching)", () => {
	let cohort: CohortManager;
	let mgr: ReservationManager;
	const futureIso = new Date(Date.now() + 5 * 60_000).toISOString();

	async function withRemotePattern(pattern: string): Promise<void> {
		const api = new StubApi("accept", [
			{ agent_name: "globholder", path_pattern: pattern, expires_at: futureIso },
		]);
		mgr = new ReservationManager(api, 60_000_000);
		await flushMicrotasks();
	}

	beforeEach(() => {
		cohort = new CohortManager();
	});
	afterEach(() => {
		mgr?.shutdown();
	});

	it("exact path equality matches", async () => {
		await withRemotePattern("src/exact.ts");
		expect(mgr.checkAndReserve("src/exact.ts", "alice", cohort)?.agent_name).toBe("globholder");
		expect(mgr.checkAndReserve("src/other.ts", "alice", cohort)).toBeNull();
	});

	it('prefix glob "dir/**" matches files under the dir and the dir itself', async () => {
		await withRemotePattern("src/auth/**");
		expect(mgr.checkAndReserve("src/auth/login.ts", "alice", cohort)?.agent_name).toBe(
			"globholder",
		);
		// the bare prefix path also matches
		expect(mgr.checkAndReserve("src/auth", "alice", cohort)?.agent_name).toBe("globholder");
		// outside the prefix → no conflict
		expect(mgr.checkAndReserve("src/db/query.ts", "alice", cohort)).toBeNull();
	});

	it('"**/*.ext" matches any file with that extension in any directory', async () => {
		await withRemotePattern("**/*.ts");
		expect(mgr.checkAndReserve("deep/nested/file.ts", "alice", cohort)?.agent_name).toBe(
			"globholder",
		);
		expect(mgr.checkAndReserve("top.ts", "alice", cohort)?.agent_name).toBe("globholder");
		expect(mgr.checkAndReserve("file.md", "alice", cohort)).toBeNull();
	});

	it('"**/Name" matches a bare filename in any directory (incl. root)', async () => {
		await withRemotePattern("**/Makefile");
		expect(mgr.checkAndReserve("services/api/Makefile", "alice", cohort)?.agent_name).toBe(
			"globholder",
		);
		// the bare suffix itself (root-level) matches
		expect(mgr.checkAndReserve("Makefile", "alice", cohort)?.agent_name).toBe("globholder");
		expect(mgr.checkAndReserve("Makefile.bak", "alice", cohort)).toBeNull();
	});

	it('"*.ext" suffix glob matches files ending in the suffix', async () => {
		await withRemotePattern("*.env");
		expect(mgr.checkAndReserve(".env", "alice", cohort)?.agent_name).toBe("globholder");
		expect(mgr.checkAndReserve("staging.env", "alice", cohort)?.agent_name).toBe("globholder");
		expect(mgr.checkAndReserve("env.example", "alice", cohort)).toBeNull();
	});

	it("a pattern with no recognized glob form and no exact match never matches (returns false)", async () => {
		// "src/a?.ts" is not exact, not /**, not **/, not *-prefixed → falls
		// through every arm to the final `return false`.
		await withRemotePattern("src/a?.ts");
		expect(mgr.checkAndReserve("src/ab.ts", "alice", cohort)).toBeNull();
		expect(mgr.checkAndReserve("src/a1.ts", "alice", cohort)).toBeNull();
	});
});

// ===========================================
// shutdown — interval + timer teardown
// ===========================================

describe("ReservationManager — shutdown", () => {
	it("stops the refresh interval and clears pending release timers", () => {
		vi.useFakeTimers();
		try {
			const events: ReservationLogEvent[] = [];
			const sink: ReservationEventSink = (e) => events.push(e);
			const cohort = new CohortManager();
			const api = new StubApi("accept", []);
			const mgr = new ReservationManager(api, 1_000, sink);

			mgr.checkAndReserve("s.ts", "alice", cohort);
			mgr.scheduleRelease("s.ts", "alice", cohort); // arm an idle timer

			mgr.shutdown(); // clears the interval AND the pending release timer

			vi.advanceTimersByTime(120_000);
			// No auto-release fired (timer was cleared by shutdown).
			expect(events.some((e) => e.action === "release")).toBe(false);
			// listReservations is not called again after shutdown (interval cleared).
			const callsAfter = api.listCalls;
			vi.advanceTimersByTime(120_000);
			expect(api.listCalls).toBe(callsAfter);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shutdown is safe to call when no apiClient/interval was ever set", () => {
		const mgr = new ReservationManager();
		expect(() => mgr.shutdown()).not.toThrow();
	});
});
