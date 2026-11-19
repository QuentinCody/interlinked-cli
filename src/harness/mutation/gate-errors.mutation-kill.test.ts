import { describe, expect, it } from "vitest";
import { notMeasuredReason } from "./gate-errors.js";

describe("notMeasuredReason — pending count", () => {
	// test-contract: bug — a single pending job still counts as "still running", not as a runner failure
	it("reports still running when exactly one job is pending", () => {
		expect(notMeasuredReason(new Error("budget"), 1)).toBe("mutation still running past the budget");
	});

	// test-contract: invariant — zero pending jobs never reports still running
	it("does not report still running when no job is pending", () => {
		expect(notMeasuredReason(new Error("budget"), 0)).not.toBe("mutation still running past the budget");
	});
});
