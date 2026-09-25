// Unit E1: the scenario `stability` block (plan §9.5 / §14) — three
// independent qualification runs by default, an explicit seed and an optional
// fixed ISO clock; everything else is refused.
import { describe, expect, it } from "vitest";
import { parseStability } from "./policy-stability.js";

describe("parseStability — positive (must parse)", () => {
    it("P1: an empty block adopts the default of three runs; explicit runs, seed and clock are kept", () => {
        expect(parseStability({}, "s")).toEqual({ qualificationRuns: 3 });
        expect(parseStability({ qualificationRuns: 1, seed: "seed-1", clock: "2026-01-01T00:00:00Z" }, "s")).toEqual({ qualificationRuns: 1, seed: "seed-1", clock: "2026-01-01T00:00:00Z" });
    });
});
describe("parseStability — negative (must refuse)", () => {
    it("N1: runs outside 1–5, a non-integer, a malformed seed, a non-ISO clock and an unknown key are refused with the field named", () => {
        expect(() => parseStability({ qualificationRuns: 0 }, "s")).toThrow(/s\.qualificationRuns must be an integer from 1 to 5/);
        expect(() => parseStability({ qualificationRuns: 6 }, "s")).toThrow(/qualificationRuns/);
        expect(() => parseStability({ qualificationRuns: 2.5 }, "s")).toThrow(/qualificationRuns/);
        expect(() => parseStability({ seed: "bad seed!" }, "s")).toThrow(/s\.seed must match/);
        expect(() => parseStability({ clock: "yesterday" }, "s")).toThrow(/s\.clock must be an ISO-8601 instant/);
        expect(() => parseStability({ retries: 2 }, "s")).toThrow(/unknown key "retries"/);
        expect(() => parseStability("3", "s")).toThrow(/must be an object/);
    });
});
