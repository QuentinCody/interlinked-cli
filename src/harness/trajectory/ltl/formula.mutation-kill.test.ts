import { describe, expect, it } from "vitest";
import { always, atom, eventually, within } from "./formula.js";

const p = atom<{ n: number }, { x: boolean }>("p", (_s, e) => e.x);

// Census fault: `n >= 1` became `n > 1`, so a bound of 1 meant unbounded (docs/reviews/kill-proof-census-e2e-structure.md #35).
describe("bounds — 1 is the smallest valid bound", () => {
	// test-contract: boundary — a bound of exactly 1 is kept by always, eventually and within
	it("keeps a bound of 1", () => {
		expect(always(p, 1).bound).toBe(1);
		expect(eventually(p, 1).bound).toBe(1);
		expect(within(eventually(p), 1).bound).toBe(1);
	});
	// test-contract: boundary — a fractional bound in [1, 2) floors to 1, not to unbounded
	it("floors 1.5 to a bound of 1", () => {
		expect(eventually(p, 1.5).bound).toBe(1);
	});
});
