import { describe, expect, it } from "vitest";
import { createAggregateState, finalizeAggregate, foldRecord } from "./aggregate.js";

describe("aggregate mutation kills", () => {
	// test-contract: invariant — groups with equal sums are ordered by higher count before key order
	it("breaks sum ties by count descending", () => {
		const state = createAggregateState();
		foldRecord(state, { k: "a", v: 10 }, "k", "v");
		foldRecord(state, { k: "b", v: 5 }, "k", "v");
		foldRecord(state, { k: "b", v: 5 }, "k", "v");
		expect(finalizeAggregate(state, 10)).toEqual([
			{ key: "b", count: 2, sum: 10 },
			{ key: "a", count: 1, sum: 10 },
		]);
	});
});
