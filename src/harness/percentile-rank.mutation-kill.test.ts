import { describe, expect, it } from "vitest";
import { percentileOf } from "./percentile-rank.js";

describe("percentileOf — mutation-directed (rounding)", () => {
	// test-contract: boundary — a share with a fractional part ≥ .5 rounds UP (2 of 3 below = 66.67 → 67), so a floor/truncate regression is visible
	it("rounds a fractional share to the nearest integer, not down", () => {
		expect(percentileOf(5, [1, 2, 9])).toBe(67);
	});

	// test-contract: boundary — a share below .5 still rounds down (1 of 3 below = 33.33 → 33), pinning round-half behaviour from both sides
	it("rounds a fractional share below one half down", () => {
		expect(percentileOf(2, [1, 5, 9])).toBe(33);
	});
});
