import { describe, expect, it } from "vitest";
import { consumeWalkEntry, createWalkBudget } from "./bounded-walk.js";

describe("consumeWalkEntry after a deadline trip", () => {
	// test-contract: invariant — once the deadline truncates a walk, every later entry is refused
	it("keeps returning false after the periodic clock check tripped the deadline", () => {
		const budget = createWalkBudget();
		budget.deadline = Number.NEGATIVE_INFINITY;
		for (let i = 1; i < 512; i++) expect(consumeWalkEntry(budget)).toBe(true);
		expect(consumeWalkEntry(budget)).toBe(false);
		expect(budget.truncated).toBe(true);
		expect(consumeWalkEntry(budget)).toBe(false);
		expect(consumeWalkEntry(budget)).toBe(false);
	});
});
