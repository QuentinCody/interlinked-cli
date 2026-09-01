// Supplementary BEHAVIORAL coverage test for reservations.ts.
//
// The companion file `__tests__/reservations.test.ts` (fast-check property
// tests + optimistic-rollback integration) covers the pure state machine and
// the server-confirm rollback. This file drives the branches that file leaves
// cold — all exercised through observable behavior, not smoke:
//   - scheduleRelease (idle auto-release via fake timers + non-owner no-op +
//     timer-reset on a re-edit)
//   - releaseAllForAgent (multi-file release + name-variant ownership)
//   - refreshFromServer (evict-remote, remote upsert, local-not-clobbered,
//     listReservations throwing)
//   - constructor apiClient branch (initial refresh + periodic interval)
//   - getForAgent / getAll expiry pruning / checkAndReserve expiry pruning
//   - rollbackOptimisticGrant clearing a pending scheduled-release timer
//   - release: clears the pending timer + server release + non-owner no-op
//   - emit with no sink (silent), and a throwing sink (must not break)
//   - every pathMatchesPattern glob arm via checkAndReserve conflict matching
//   - shutdown clearing live release timers
//
// Constraints honored: only this file is written; exactOptionalPropertyTypes
// is on, so absent optional keys are omitted (never `key: undefined`); no
// real model/provider names; no `as any`; tsc-clean.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "./cohort.js";
import {
	type ReservationEventSink,
	type ReservationLogEvent,
	ReservationManager,
	type ServerApiClient,
	type ServerReservation,
} from "./reservations.js";
import type { HarnessEvent } from "./types.js";

// ===========================================
// Helpers
// ===========================================

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

/** Configurable stub server client. Records calls; can resolve/reject reserve,
 *  and returns a (possibly mutating) listing for refreshFromServer. */
class StubApi implements ServerApiClient {
	public reserveCalls: Array<[string, string, number]> = [];
	public releaseCalls: Array<[string, string]> = [];
	public listCalls = 0;

	constructor(
		private reserveBehavior: "accept" | "reject" = "accept",
		private listingProvider: () => ServerReservation[] | Promise<ServerReservation[]> = () => [],
	) {}

	async reserveFile(filePath: string, agentName: string, ttlSeconds: number): Promise<void> {
		this.reserveCalls.push([filePath, agentName, ttlSeconds]);
		if (this.reserveBehavior === "reject") throw new Error("server rejected");
	}

	async releaseFile(filePath: string, agentName: string): Promise<void> {
		this.releaseCalls.push([filePath, agentName]);
	}

	async listReservations(): Promise<ServerReservation[]> {
		this.listCalls++;
		return this.listingProvider();
	}
}

// ===========================================
// scheduleRelease — auto-release timer (fake timers)
// ===========================================

describe("ReservationManager.scheduleRelease — idle auto-release", () => {
	let events: ReservationLogEvent[];
	let cohort: CohortManager;
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		vi.useFakeTimers();
		events = [];
		cohort = new CohortManager();
		// No apiClient → purely local grant path, no async confirm to flush.
		mgr = new ReservationManager(undefined, 60_000_000, sink);
	});

	afterEach(() => {
		mgr?.shutdown();
		vi.useRealTimers();
	});

	it("auto-releases the file after the idle timeout fires", () => {
		cohort.agentJoined(joinEvent("alice"));
		expect(mgr.checkAndReserve("a.ts", "alice", cohort)).toBeNull();
		mgr.scheduleRelease("a.ts", "alice", cohort);
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);

		// Advance past the 30s auto-release window → the timer fires release().
		vi.advanceTimersByTime(30_000);

		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		expect(events.some((e) => e.action === "release" && e.file === "a.ts")).toBe(true);
		// Cohort tracking is cleared by the release.
		expect(cohort.getAgent("alice")?.files_reserved).toEqual([]);
	});

	it("re-editing the same file resets the idle timer (clears the prior one)", () => {
		cohort.agentJoined(joinEvent("alice"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		mgr.scheduleRelease("a.ts", "alice", cohort);

		// Almost-but-not-quite expire, then re-edit → resets the window.
		vi.advanceTimersByTime(20_000);
		mgr.scheduleRelease("a.ts", "alice", cohort); // hits the clearTimeout(existing) branch
		vi.advanceTimersByTime(20_000); // 40s total but only 20s since reset

		// Still held — the reset moved the deadline out.
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);

		// Now let the reset timer elapse fully.
		vi.advanceTimersByTime(10_000);
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
	});

	it("scheduleRelease on an unheld / non-owned file is a no-op", () => {
		cohort.agentJoined(joinEvent("alice"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		// File the agent does not hold → early return, no timer set.
		mgr.scheduleRelease("nonexistent.ts", "alice", cohort);
		// Held by alice, but bob asks → not the owner → early return.
		mgr.scheduleRelease("a.ts", "bob", cohort);

		vi.advanceTimersByTime(60_000);
		// a.ts never had a release timer scheduled, so it survives the clock.
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);
	});

	it("keys the release timer on the stored owner across name variants", () => {
		// Reserve under the bare session name, then schedule release under the
		// per-source variant — sameOwner() must recognize it and arm the timer
		// against the *stored* owner name.
		expect(mgr.checkAndReserve("doc.md", "session-2d113be2", cohort)).toBeNull();
		mgr.scheduleRelease("doc.md", "session-claude-2d113be2", cohort);
		vi.advanceTimersByTime(30_000);
		expect(mgr.getAll().some((e) => e.file_pattern === "doc.md")).toBe(false);
	});
});

// ===========================================
// release — clear pending timer + server release + non-owner no-op
// ===========================================

describe("ReservationManager.release", () => {
	let cohort: CohortManager;

	beforeEach(() => {
		vi.useFakeTimers();
		cohort = new CohortManager();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears a pending auto-release timer and releases on the server", async () => {
		const api = new StubApi("accept");
		const mgr = new ReservationManager(api, 60_000_000);
		cohort.agentJoined(joinEvent("alice"));

		mgr.checkAndReserve("a.ts", "alice", cohort);
		await vi.advanceTimersByTimeAsync(0); // flush async reserve confirm
		mgr.scheduleRelease("a.ts", "alice", cohort); // arms a release timer

		mgr.release("a.ts", "alice", cohort); // explicit release clears that timer
		await vi.advanceTimersByTimeAsync(0);

		expect(mgr.getAll()).toEqual([]);
		// Server-side release was requested for the file.
		expect(api.releaseCalls.some(([f]) => f === "a.ts")).toBe(true);
		mgr.shutdown();
	});

	it("release by a non-owner is a no-op (file stays reserved)", async () => {
		const api = new StubApi("accept");
		const mgr = new ReservationManager(api, 60_000_000);
		cohort.agentJoined(joinEvent("alice"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		await vi.advanceTimersByTimeAsync(0);

		mgr.release("a.ts", "bob", cohort); // bob does not own a.ts
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);
		// No server release call was made for bob's no-op.
		expect(api.releaseCalls).toEqual([]);
		mgr.shutdown();
	});
});

// ===========================================
// releaseAllForAgent
// ===========================================

describe("ReservationManager.releaseAllForAgent", () => {
	let events: ReservationLogEvent[];
	let cohort: CohortManager;
	let mgr: ReservationManager;
	const sink: ReservationEventSink = (e) => events.push(e);

	beforeEach(() => {
		events = [];
		cohort = new CohortManager();
		mgr = new ReservationManager(undefined, 60_000_000, sink);
	});

	afterEach(() => {
		mgr?.shutdown();
	});

	it("releases every file held by the agent and emits one release_all", () => {
		cohort.agentJoined(joinEvent("alice"));
		cohort.agentJoined(joinEvent("bob"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		mgr.checkAndReserve("b.ts", "alice", cohort);
		mgr.checkAndReserve("c.ts", "bob", cohort);

		mgr.releaseAllForAgent("alice", cohort);

		const remaining = mgr.getAll().map((e) => e.file_pattern).sort();
		expect(remaining).toEqual(["c.ts"]); // bob's reservation survives
		expect(cohort.getAgent("alice")?.files_reserved).toEqual([]);

		const releaseAllEvt = events.find((e) => e.action === "release_all");
		expect(releaseAllEvt).toBeDefined();
		expect(releaseAllEvt?.agent_name).toBe("alice");
		expect(releaseAllEvt?.file).toBe("[2 files]");
	});

	it("does not emit release_all when the agent holds nothing", () => {
		cohort.agentJoined(joinEvent("alice"));
		mgr.releaseAllForAgent("alice", cohort);
		expect(events.some((e) => e.action === "release_all")).toBe(false);
	});

	it("matches the agent across synthetic name variants", () => {
		mgr.checkAndReserve("doc.md", "session-2d113be2", cohort);
		// Release-all under the per-source variant must still find the holding.
		mgr.releaseAllForAgent("session-claude-2d113be2", cohort);
		expect(mgr.getAll()).toEqual([]);
	});
});

// ===========================================
// refreshFromServer — evict / upsert / local-preserve / throwing list
// ===========================================

describe("ReservationManager.refreshFromServer", () => {
	let cohort: CohortManager;

	beforeEach(() => {
		cohort = new CohortManager();
	});

	it("upserts remote reservations from the server listing", async () => {
		const api = new StubApi("accept", () => [
			{ agent_name: "remote-bot", path_pattern: "remote.ts", expires_at: "2099-01-01T00:00:00Z" },
		]);
		const mgr = new ReservationManager(api, 60_000_000);
		await mgr.refreshFromServer();

		const remote = mgr.getAll().find((e) => e.file_pattern === "remote.ts");
		expect(remote).toBeDefined();
		expect(remote?.agent_name).toBe("remote-bot");
		expect(remote?.cohort).toBe("remote");
		mgr.shutdown();
	});

	it("synthesizes an expiry when the server omits expires_at", async () => {
		// path with no expires_at → falls back to now + TTL (the `||` arm).
		const api = new StubApi("accept", () => [
			{ agent_name: "remote-bot", path_pattern: "noexp.ts" },
		]);
		const mgr = new ReservationManager(api, 60_000_000);
		await mgr.refreshFromServer();

		const remote = mgr.getAll().find((e) => e.file_pattern === "noexp.ts");
		expect(remote).toBeDefined();
		// A future expiry was synthesized, so getAll() does not prune it.
		expect(new Date(remote?.expires_at ?? "").getTime()).toBeGreaterThan(Date.now());
		mgr.shutdown();
	});

	it("evicts a remote entry once the server stops listing it", async () => {
		let listing: ServerReservation[] = [
			{ agent_name: "remote-bot", path_pattern: "remote.ts", expires_at: "2099-01-01T00:00:00Z" },
		];
		const api = new StubApi("accept", () => listing);
		const mgr = new ReservationManager(api, 60_000_000);

		await mgr.refreshFromServer();
		expect(mgr.getAll().some((e) => e.file_pattern === "remote.ts")).toBe(true);

		// Server drops it → next refresh evicts the remote-cohort entry.
		listing = [];
		await mgr.refreshFromServer();
		expect(mgr.getAll().some((e) => e.file_pattern === "remote.ts")).toBe(false);
		mgr.shutdown();
	});

	it("does NOT clobber or evict a locally-held reservation", async () => {
		// Local grant for shared.ts; server lists a DIFFERENT agent for it.
		// The upsert must skip it (existing.cohort === "local"), and the
		// evict-remote pass must leave it alone (it is local, not remote).
		const api = new StubApi("accept", () => [
			{ agent_name: "remote-bot", path_pattern: "shared.ts", expires_at: "2099-01-01T00:00:00Z" },
		]);
		const mgr = new ReservationManager(api, 60_000_000);
		cohort.agentJoined(joinEvent("alice"));
		mgr.checkAndReserve("shared.ts", "alice", cohort);
		await flushMicrotasks();

		await mgr.refreshFromServer();

		const entry = mgr.getAll().find((e) => e.file_pattern === "shared.ts");
		expect(entry?.agent_name).toBe("alice"); // not overwritten by remote-bot
		expect(entry?.cohort).toBe("local");
		mgr.shutdown();
	});

	it("swallows a throwing listReservations (best-effort refresh)", async () => {
		const api = new StubApi("accept", () => {
			throw new Error("list boom");
		});
		const mgr = new ReservationManager(api, 60_000_000);
		// Must not reject — the catch arm absorbs it.
		await expect(mgr.refreshFromServer()).resolves.toBeUndefined();
		mgr.shutdown();
	});

	it("refreshFromServer is a no-op without an apiClient", async () => {
		const mgr = new ReservationManager(undefined, 60_000_000);
		await expect(mgr.refreshFromServer()).resolves.toBeUndefined();
		expect(mgr.getAll()).toEqual([]);
		mgr.shutdown();
	});
});

// ===========================================
// constructor apiClient branch — initial refresh + periodic interval
// ===========================================

describe("ReservationManager constructor — server-backed", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does an initial refresh and then refreshes on the interval", async () => {
		const api = new StubApi("accept", () => []);
		const mgr = new ReservationManager(api, 1_000); // 1s refresh interval

		// The constructor kicks off an initial refreshFromServer().
		await vi.runOnlyPendingTimersAsync();
		const afterInitial = api.listCalls;
		expect(afterInitial).toBeGreaterThanOrEqual(1);

		// Advancing past the interval fires the periodic refresh callback.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(api.listCalls).toBeGreaterThan(afterInitial);

		mgr.shutdown();
		// After shutdown the interval no longer fires.
		const frozen = api.listCalls;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(api.listCalls).toBe(frozen);
	});

	it("an initial-refresh rejection does not throw out of the constructor", async () => {
		const api = new StubApi("accept", () => {
			throw new Error("initial list boom");
		});
		// Construction must not throw even though the first refresh rejects.
		const mgr = new ReservationManager(api, 1_000);
		await vi.runOnlyPendingTimersAsync();
		expect(mgr.getAll()).toEqual([]);
		mgr.shutdown();
	});
});

// ===========================================
// expiry pruning — checkAndReserve + getAll
// ===========================================

describe("ReservationManager — expiry pruning", () => {
	let cohort: CohortManager;
	let mgr: ReservationManager;

	beforeEach(() => {
		cohort = new CohortManager();
		mgr = new ReservationManager(undefined, 60_000_000);
	});

	afterEach(() => {
		mgr?.shutdown();
	});

	it("getAll() prunes an entry whose expiry has passed", async () => {
		// Seed a remote entry that is already expired via refreshFromServer.
		const api = new StubApi("accept", () => [
			{ agent_name: "remote-bot", path_pattern: "stale.ts", expires_at: "2000-01-01T00:00:00Z" },
		]);
		const seeded = new ReservationManager(api, 60_000_000);
		await seeded.refreshFromServer();
		// The expired entry is pruned the moment getAll() walks the cache.
		expect(seeded.getAll().some((e) => e.file_pattern === "stale.ts")).toBe(false);
		seeded.shutdown();
	});

	it("checkAndReserve prunes an expired conflicting entry and grants", async () => {
		// remote-bot holds old.ts but it is already expired → a new agent must
		// be able to reserve it (the expiry branch inside the conflict scan).
		const api = new StubApi("accept", () => [
			{ agent_name: "remote-bot", path_pattern: "old.ts", expires_at: "2000-01-01T00:00:00Z" },
		]);
		const m = new ReservationManager(api, 60_000_000);
		await m.refreshFromServer();
		cohort.agentJoined(joinEvent("alice"));

		const conflict = m.checkAndReserve("old.ts", "alice", cohort);
		expect(conflict).toBeNull(); // expired holder pruned → grant proceeds
		expect(m.getForAgent("alice").some((e) => e.file_pattern === "old.ts")).toBe(true);
		await flushMicrotasks();
		m.shutdown();
	});
});

// ===========================================
// getForAgent
// ===========================================

describe("ReservationManager.getForAgent", () => {
	it("returns only the named agent's reservations (name-variant aware)", () => {
		const cohort = new CohortManager();
		const mgr = new ReservationManager(undefined, 60_000_000);
		cohort.agentJoined(joinEvent("alice"));
		cohort.agentJoined(joinEvent("bob"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		mgr.checkAndReserve("b.ts", "bob", cohort);
		mgr.checkAndReserve("doc.md", "session-2d113be2", cohort);

		expect(mgr.getForAgent("alice").map((e) => e.file_pattern)).toEqual(["a.ts"]);
		// Variant lookup resolves to the same owner.
		expect(mgr.getForAgent("session-claude-2d113be2").map((e) => e.file_pattern)).toEqual([
			"doc.md",
		]);
		mgr.shutdown();
	});
});

// ===========================================
// rollbackOptimisticGrant — clears a pending scheduled-release timer
// ===========================================

describe("ReservationManager — rollback clears a scheduled-release timer", () => {
	let cohort: CohortManager;

	beforeEach(() => {
		vi.useFakeTimers();
		cohort = new CohortManager();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a server-rejected grant that already armed a release timer rolls back cleanly", async () => {
		const events: ReservationLogEvent[] = [];
		const sink: ReservationEventSink = (e) => events.push(e);
		const api = new StubApi("reject"); // server will reject the optimistic grant
		const mgr = new ReservationManager(api, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));

		// Grant returns null synchronously; arm a release timer for it BEFORE the
		// async reject lands, so the rollback path has a timer to clear.
		expect(mgr.checkAndReserve("a.ts", "alice", cohort)).toBeNull();
		mgr.scheduleRelease("a.ts", "alice", cohort);
		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(true);

		// Let the rejected reserveFile() promise settle → rollbackOptimisticGrant
		// runs, removing the entry and clearing the pending timer.
		await vi.advanceTimersByTimeAsync(0);

		expect(mgr.getAll().some((e) => e.file_pattern === "a.ts")).toBe(false);
		expect(
			events.some((e) => e.action === "conflict" && e.conflict_reason === "server-rejected"),
		).toBe(true);
		expect(cohort.getAgent("alice")?.files_reserved).toEqual([]);
		mgr.shutdown();
	});
});

// ===========================================
// emit — no sink (silent) + throwing sink (must not break the primitive)
// ===========================================

describe("ReservationManager.emit — sink robustness", () => {
	it("operates with no event sink configured", () => {
		const cohort = new CohortManager();
		const mgr = new ReservationManager(); // no apiClient, no sink
		cohort.agentJoined(joinEvent("alice"));
		// grant + release with no sink → the emit() early-return arm runs.
		expect(mgr.checkAndReserve("a.ts", "alice", cohort)).toBeNull();
		mgr.release("a.ts", "alice", cohort);
		expect(mgr.getAll()).toEqual([]);
		mgr.shutdown();
	});

	it("a throwing sink does not break grant/release", () => {
		const cohort = new CohortManager();
		const throwingSink: ReservationEventSink = () => {
			throw new Error("sink boom");
		};
		const mgr = new ReservationManager(undefined, 60_000_000, throwingSink);
		cohort.agentJoined(joinEvent("alice"));
		// Both grant and release fire the sink; the try/catch swallows the throw.
		expect(() => mgr.checkAndReserve("a.ts", "alice", cohort)).not.toThrow();
		expect(() => mgr.release("a.ts", "alice", cohort)).not.toThrow();
		expect(mgr.getAll()).toEqual([]);
		mgr.shutdown();
	});
});

// ===========================================
// pathMatchesPattern — every glob arm, via conflict matching
// ===========================================
//
// pathMatchesPattern is private; we exercise it through checkAndReserve, where
// a remote-held *pattern* is matched against a concrete file path. A match
// surfaces as a conflict; a non-match grants. A remote holder (different agent)
// is seeded via refreshFromServer so the conflict scan actually evaluates the
// pattern.

describe("ReservationManager — pathMatchesPattern glob arms", () => {
	const cohort = new CohortManager();

	async function managerHolding(pattern: string): Promise<ReservationManager> {
		const api = new StubApi("accept", () => [
			{ agent_name: "remote-bot", path_pattern: pattern, expires_at: "2099-01-01T00:00:00Z" },
		]);
		const mgr = new ReservationManager(api, 60_000_000);
		await mgr.refreshFromServer();
		return mgr;
	}

	it("exact path match conflicts", async () => {
		const mgr = await managerHolding("src/exact.ts");
		expect(mgr.checkAndReserve("src/exact.ts", "alice", cohort)?.agent_name).toBe("remote-bot");
		mgr.shutdown();
	});

	it("'dir/**' matches files under the prefix and the bare prefix", async () => {
		const mgr = await managerHolding("src/auth/**");
		expect(mgr.checkAndReserve("src/auth/login.ts", "alice", cohort)).not.toBeNull();
		// The bare prefix itself also matches (filePath === prefix arm).
		expect(mgr.checkAndReserve("src/auth", "alice", cohort)).not.toBeNull();
		// A sibling outside the prefix does not match → grant.
		expect(mgr.checkAndReserve("src/other/x.ts", "alice", cohort)).toBeNull();
		mgr.shutdown();
	});

	it("'*.env' matches by suffix", async () => {
		const mgr = await managerHolding("*.env");
		expect(mgr.checkAndReserve("staging.env", "alice", cohort)).not.toBeNull();
		expect(mgr.checkAndReserve("config.json", "alice", cohort)).toBeNull();
		mgr.shutdown();
	});

	it("'**/*.ts' matches any .ts by extension", async () => {
		const mgr = await managerHolding("**/*.ts");
		expect(mgr.checkAndReserve("deep/nested/file.ts", "alice", cohort)).not.toBeNull();
		expect(mgr.checkAndReserve("file.md", "alice", cohort)).toBeNull();
		mgr.shutdown();
	});

	it("'**/name' (non-star suffix) matches the basename in any directory", async () => {
		// The `**/` arm is now checked BEFORE the single-'*' arm, so "**/Makefile"
		// correctly matches a Makefile in any directory (endsWith("/Makefile"))
		// and the bare basename (=== suffix) — previously the '*' arm shadowed it
		// and every "**/" reservation was silently a no-op.
		const mgr = await managerHolding("**/Makefile");
		expect(mgr.checkAndReserve("project/Makefile", "alice", cohort)).not.toBeNull();
		expect(mgr.checkAndReserve("Makefile", "alice", cohort)).not.toBeNull();
		// A different basename still falls through to a clean grant.
		expect(mgr.checkAndReserve("project/Cargo.toml", "alice", cohort)).toBeNull();
		mgr.shutdown();
	});

	it("an unrecognized pattern shape never matches (returns false → grant)", async () => {
		// A bare path that is neither exact, '/**', '*'-prefixed, nor '**/'-prefixed
		// falls through to the final `return false`.
		const mgr = await managerHolding("src/dir");
		expect(mgr.checkAndReserve("src/dir/child.ts", "alice", cohort)).toBeNull();
		mgr.shutdown();
	});
});

// ===========================================
// shutdown — clears live release timers
// ===========================================

describe("ReservationManager.shutdown", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("clears pending release timers so they never fire after shutdown", () => {
		const events: ReservationLogEvent[] = [];
		const sink: ReservationEventSink = (e) => events.push(e);
		const cohort = new CohortManager();
		const mgr = new ReservationManager(undefined, 60_000_000, sink);
		cohort.agentJoined(joinEvent("alice"));
		mgr.checkAndReserve("a.ts", "alice", cohort);
		mgr.scheduleRelease("a.ts", "alice", cohort); // live timer in the map

		mgr.shutdown(); // must clear the timer

		// Advancing the clock must NOT produce a release event — the timer was cleared.
		vi.advanceTimersByTime(60_000);
		expect(events.some((e) => e.action === "release")).toBe(false);
	});
});
