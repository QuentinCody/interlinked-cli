import { describe, expect, it } from "vitest";
import { freshInstability, updateInstability } from "./instability.js";

describe("instability mutation-kill", () => {
	// test-contract: invariant — a never-quarantined symbol stays unquarantined after a stable run below the threshold
	it("does not quarantine a symbol that was never quarantined", () => {
		const next = updateInstability(freshInstability(), { churned: false, at: "t", threshold: 3 });
		expect(next.quarantined).toBe(false);
		expect(next.consecutiveStableRuns).toBe(1);
	});
});
