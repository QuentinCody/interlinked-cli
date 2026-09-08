import { afterEach, describe, expect, it, vi } from "vitest";
import { CohortManager } from "./cohort.js";
import { runWithClock } from "./replay/harness-clock.js";
import { ReservationManager } from "./reservations.js";
import type { ReservationLogEvent } from "./reservations-state-machine.js";
import type { HarnessEvent } from "./types.js";

function baseEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		timestamp: "2026-06-06T00:00:00Z",
		...overrides,
	};
}

function registeredCohort(agentName: string): CohortManager {
	const cohort = new CohortManager();
	cohort.agentJoined(baseEvent({ agent_name: agentName, session_id: agentName }));
	return cohort;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ReservationManager — constructor apiClient guard", () => {
	it("does not start a background refresh interval when no apiClient is given", () => {
		const setIntervalSpy = vi.spyOn(global, "setInterval");
		const mgr = new ReservationManager();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		mgr.shutdown();
	});
});

describe("ReservationManager — checkAndReserve expiry pruning", () => {
	it("prunes a preexisting expired reservation on a different glob pattern, not just skips it", () => {
		// The glob entry's real expires_at is stamped at grant time (now +
		// 300s); freezing harnessNow() well past that makes it expired for the
		// pruning check without waiting on real time.
		const cohort = registeredCohort("agentA");
		const mgr = new ReservationManager();
		mgr.checkAndReserve("src/auth/**", "agentA", cohort);
		const farFuture = Date.now() + 10 * 60_000;
		const conflict = runWithClock(farFuture, () =>
			mgr.checkAndReserve("src/auth/login.ts", "agentB", registeredCohort("agentB")),
		);
		expect(conflict).toBeNull();
		const all = mgr.getAll();
		// Only the fresh grant for login.ts should remain — the expired glob
		// pattern entry must have been pruned via the SSoT "expire" transition.
		expect(all).toHaveLength(1);
		expect(all[0]?.file_pattern).toBe("src/auth/login.ts");
	});

	it("does not prune a reservation exactly at its own expiry boundary (strict <)", () => {
		// The reservation's expires_at is stamped from the real wall clock at
		// grant time; only the pruning check inside getAll() reads harnessNow(),
		// so we freeze harnessNow() at exactly that real expires_at to probe
		// the boundary without racing real time.
		const cohort = registeredCohort("agentX");
		const mgr = new ReservationManager();
		mgr.checkAndReserve("boundary.ts", "agentX", cohort);
		const entry = mgr.getAll()[0];
		if (!entry) throw new Error("expected a granted reservation");
		const expiryMs = new Date(entry.expires_at).getTime();
		const stillThere = runWithClock(expiryMs, () => mgr.getAll());
		expect(stillThere).toHaveLength(1);
	});

	it("reports the existing holder's cohort as local when the holder is in the local cohort", () => {
		const holderCohort = registeredCohort("holderAgent");
		const mgr = new ReservationManager();
		mgr.checkAndReserve("shared-file.ts", "holderAgent", holderCohort);
		const conflict = mgr.checkAndReserve("shared-file.ts", "otherAgent", holderCohort);
		expect(conflict).not.toBeNull();
		expect(conflict?.cohort).toBe("local");
	});

	it("emits a grant event with action 'grant' and cohort 'local' on successful reservation", () => {
		const events: ReservationLogEvent[] = [];
		const cohort = registeredCohort("agentG");
		const mgr = new ReservationManager(undefined, 30_000, (e) => events.push(e));
		const conflict = mgr.checkAndReserve("granted.ts", "agentG", cohort);
		expect(conflict).toBeNull();
		const grantEvent = events.find((e) => e.file === "granted.ts");
		expect(grantEvent).toBeDefined();
		expect(grantEvent?.action).toBe("grant");
		expect(grantEvent?.cohort).toBe("local");
	});
});

describe("ReservationManager — rollbackOptimisticGrant (server rejection path)", () => {
	function deferredApiClient(listReservations: () => Promise<Array<{ agent_name: string; path_pattern: string; expires_at?: string }>>) {
		let rejectReserve!: (err: Error) => void;
		const pending = new Promise<void>((_resolve, reject) => {
			rejectReserve = reject;
		});
		const apiClient = {
			reserveFile: vi.fn(() => pending),
			releaseFile: vi.fn(async () => undefined),
			listReservations: vi.fn(listReservations),
		};
		return { apiClient, pending, rejectReserve: () => rejectReserve(new Error("rejected")) };
	}

	it("rolls back only when the entry is still the local optimistic grant, not a differently-cohorted entry with the same owner", async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		const { apiClient, pending, rejectReserve } = deferredApiClient(async () => []);
		const cohort = registeredCohort("agentA");
		const mgr = new ReservationManager(apiClient, 999_999_999);
		await Promise.resolve();
		await Promise.resolve();

		mgr.checkAndReserve("shared.ts", "agentA", cohort);

		// Simulate the agent releasing, then the server reporting the SAME
		// file now held remotely by the SAME agent name, before the pending
		// reserveFile rejection is observed.
		mgr.release("shared.ts", "agentA", cohort);
		apiClient.listReservations.mockResolvedValueOnce([
			{ agent_name: "agentA", path_pattern: "shared.ts", expires_at: future },
		]);
		await mgr.refreshFromServer();

		rejectReserve();
		await pending.catch(() => undefined);
		await Promise.resolve();

		const all = mgr.getAll();
		expect(all.some((e) => e.file_pattern === "shared.ts" && e.cohort === "remote")).toBe(true);
		mgr.shutdown();
	});

	it("clears the release timer keyed by the entry owner and file on rollback", async () => {
		const { apiClient, pending, rejectReserve } = deferredApiClient(async () => []);
		const cohort = registeredCohort("agentZ");
		const mgr = new ReservationManager(apiClient, 999_999_999);
		await Promise.resolve();
		await Promise.resolve();

		mgr.checkAndReserve("timed.ts", "agentZ", cohort);
		const setTimeoutSpy = vi.spyOn(global, "setTimeout");
		mgr.scheduleRelease("timed.ts", "agentZ", cohort);
		const lastResult = setTimeoutSpy.mock.results.at(-1);
		if (!lastResult) throw new Error("expected setTimeout to have been called");
		const handle = lastResult.value;
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

		rejectReserve();
		await pending.catch(() => undefined);
		await Promise.resolve();

		expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
		mgr.shutdown();
	});

	it("does not call clearTimeout on rollback when no release timer was scheduled", async () => {
		const { apiClient, pending, rejectReserve } = deferredApiClient(async () => []);
		const cohort = registeredCohort("agentY");
		const mgr = new ReservationManager(apiClient, 999_999_999);
		await Promise.resolve();
		await Promise.resolve();

		mgr.checkAndReserve("notimer.ts", "agentY", cohort);
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

		rejectReserve();
		await pending.catch(() => undefined);
		await Promise.resolve();

		expect(clearTimeoutSpy).not.toHaveBeenCalled();
		mgr.shutdown();
	});
});

describe("ReservationManager — scheduleRelease timer keying", () => {
	it("does not clobber another file's release timer (distinct owner:file keys)", () => {
		const cohort = registeredCohort("agent1");
		const cohort2 = registeredCohort("agent2");
		const mgr = new ReservationManager();
		mgr.checkAndReserve("fileA.ts", "agent1", cohort);
		mgr.checkAndReserve("fileB.ts", "agent2", cohort2);

		mgr.scheduleRelease("fileA.ts", "agent1", cohort);
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
		mgr.scheduleRelease("fileB.ts", "agent2", cohort2);
		expect(clearTimeoutSpy).not.toHaveBeenCalled();
		mgr.shutdown();
	});

	it("does not call clearTimeout on the very first scheduleRelease for a file", () => {
		const cohort = registeredCohort("agent3");
		const mgr = new ReservationManager();
		mgr.checkAndReserve("fresh.ts", "agent3", cohort);
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
		mgr.scheduleRelease("fresh.ts", "agent3", cohort);
		expect(clearTimeoutSpy).not.toHaveBeenCalled();
		mgr.shutdown();
	});
});

describe("ReservationManager — release() timer cleanup", () => {
	it("clears the matching release timer when releasing a file that has one scheduled", () => {
		const cohort = registeredCohort("agentA");
		const mgr = new ReservationManager();
		mgr.checkAndReserve("f1.ts", "agentA", cohort);
		const setTimeoutSpy = vi.spyOn(global, "setTimeout");
		mgr.scheduleRelease("f1.ts", "agentA", cohort);
		const lastResult = setTimeoutSpy.mock.results.at(-1);
		if (!lastResult) throw new Error("expected setTimeout to have been called");
		const handle = lastResult.value;
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

		mgr.release("f1.ts", "agentA", cohort);
		expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);
	});

	it("does not call clearTimeout when releasing a file with no scheduled timer", () => {
		const cohort = registeredCohort("agentB");
		const mgr = new ReservationManager();
		mgr.checkAndReserve("f2.ts", "agentB", cohort);
		const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
		mgr.release("f2.ts", "agentB", cohort);
		expect(clearTimeoutSpy).not.toHaveBeenCalled();
	});
});

describe("ReservationManager — refreshFromServer eviction + upsert", () => {
	it("does not evict a local reservation just because it is absent from the server list", async () => {
		const listReservations = vi.fn(async () : Promise<Array<{ agent_name: string; path_pattern: string; expires_at?: string }>> => []);
		const apiClient = {
			reserveFile: vi.fn(async () => undefined),
			releaseFile: vi.fn(async () => undefined),
			listReservations,
		};
		const cohort = registeredCohort("agentZ");
		const mgr = new ReservationManager(apiClient, 999_999_999);
		await Promise.resolve();
		await Promise.resolve();

		mgr.checkAndReserve("local-file.ts", "agentZ", cohort);
		await mgr.refreshFromServer();

		const all = mgr.getAll();
		expect(all.some((e) => e.file_pattern === "local-file.ts")).toBe(true);
		mgr.shutdown();
	});

	it("keeps a remote reservation that is still reported by the server on the next refresh", async () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		const listReservations = vi.fn(async () => [
			{ agent_name: "agentR", path_pattern: "remote-file.ts", expires_at: future },
		]);
		const apiClient = {
			reserveFile: vi.fn(async () => undefined),
			releaseFile: vi.fn(async () => undefined),
			listReservations,
		};
		const mgr = new ReservationManager(apiClient, 999_999_999);
		await Promise.resolve();
		await Promise.resolve();

		await mgr.refreshFromServer();

		const all = mgr.getAll();
		expect(all.some((e) => e.file_pattern === "remote-file.ts")).toBe(true);
		mgr.shutdown();
	});
});

describe("ReservationManager — shutdown() interval guard", () => {
	it("does not call clearInterval when constructed without an apiClient (no interval to clear)", () => {
		const clearIntervalSpy = vi.spyOn(global, "clearInterval");
		const mgr = new ReservationManager();
		mgr.shutdown();
		expect(clearIntervalSpy).not.toHaveBeenCalled();
	});
});

describe("ReservationManager — pathMatchesPattern via checkAndReserve conflicts", () => {
	it("does not false-positive-match a '**/suffix' glob when the path lacks the required '/' boundary", () => {
		const holderCohort = registeredCohort("agentA");
		const mgr = new ReservationManager();
		// Reservation held on a "**/test.ts" glob pattern.
		mgr.checkAndReserve("**/test.ts", "agentA", holderCohort);
		// "best.ts" ends with "est.ts" (suffix minus its first char) but does
		// NOT end with "/test.ts" and is not exactly "test.ts" — it must not
		// match the glob.
		const conflict = mgr.checkAndReserve("best.ts", "agentB", registeredCohort("agentB"));
		expect(conflict).toBeNull();
	});
});
