import { describe, expect, it } from "vitest";
import { aggregateBurden, interpolateBurden, STRUCTURE_PROFILE } from "./score-profile.js";

describe("structural burden arithmetic", () => {
    it("includes a fractional final entity in the worst exposure decile", () => {
        expect(aggregateBurden([{ burden: 0, exposure: 90 }, { burden: .5, exposure: 10 }])?.score).toBeCloseTo(16.25);
        expect(aggregateBurden([{ burden: 0, exposure: 999 }, { burden: 1, exposure: 1 }])?.score).toBeCloseTo(.325);
    });

    it("does not invent a clean measurement for an empty population", () => {
        expect(aggregateBurden([])).toBeNull();
    });

    it("preserves the published cyclomatic knots and interpolates between them", () => {
        const knots = STRUCTURE_PROFILE.metrics.cyclomatic.knots;
        expect(interpolateBurden(5, knots)).toBe(0);
        expect(interpolateBurden(10, knots)).toBeCloseTo(.125);
        expect(interpolateBurden(50, knots)).toBe(1);
        expect(interpolateBurden(200, knots)).toBe(1);
    });

    it("rejects non-finite values and invalid exposure", () => {
        expect(() => interpolateBurden(Number.NaN, STRUCTURE_PROFILE.metrics.cyclomatic.knots)).toThrow();
        expect(() => aggregateBurden([{ burden: .5, exposure: -1 }])).toThrow();
    });
});
