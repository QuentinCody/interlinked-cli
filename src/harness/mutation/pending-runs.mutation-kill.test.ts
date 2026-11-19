import { describe, expect, it } from "vitest";
import {
	PENDING_TTL_MS,
	createPendingStore,
	reapExpired,
	recordPending,
	takePending,
} from "./pending-runs.js";

const run = { file: "a.ts", overlayHash: "h", jobId: "j", runnerUrl: "u", startedAt: 1000 };

describe("pending-runs mutation-kill", () => {
	// test-contract: boundary — a run exactly PENDING_TTL_MS old is still claimable
	it("claims a run whose age equals the TTL", () => {
		const store = createPendingStore();
		recordPending(store, run);
		expect(takePending(store, "a.ts", "h", 1000 + PENDING_TTL_MS)).toEqual([run]);
	});

	// test-contract: boundary — a run one ms past the TTL is expired
	it("does not claim a run older than the TTL", () => {
		const store = createPendingStore();
		recordPending(store, run);
		expect(takePending(store, "a.ts", "h", 1000 + PENDING_TTL_MS + 1)).toEqual([]);
	});

	// test-contract: boundary — reapExpired keeps a run exactly at the TTL
	it("reaps nothing at exactly the TTL age", () => {
		const store = createPendingStore();
		recordPending(store, run);
		expect(reapExpired(store, 1000 + PENDING_TTL_MS)).toBe(0);
		expect(store.runs).toHaveLength(1);
	});
});
