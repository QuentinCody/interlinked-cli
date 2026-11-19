import { expect, it } from "vitest";
import { aggregateBurden } from "./score-profile.js";

// test-contract: boundary — normalized burden lives in [0, 1]; a burden above 1 would push the score past 100 and must be refused
it("rejects a normalized burden above one", () => {
	expect(() => aggregateBurden([{ burden: 1.5, exposure: 1 }])).toThrow("Normalized burden must be between zero and one");
});

// test-contract: boundary — a burden of exactly 1 is the worst valid value and scores 100
it("accepts a burden of exactly one", () => {
	expect(aggregateBurden([{ burden: 1, exposure: 1 }])?.score).toBeCloseTo(100);
});
