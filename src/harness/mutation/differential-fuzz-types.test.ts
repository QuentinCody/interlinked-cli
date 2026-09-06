// differential-fuzz-types.test.ts — this module is almost entirely type
// declarations (interfaces, a discriminated union) with exactly one
// executable statement: the DEFAULT_FUZZ_RUNS constant. There is nothing
// else to exercise at runtime; the interfaces are proven by the modules that
// construct them (differential-fuzz-run.ts, differential-fuzz-deps.ts, etc.)
// under their own companions.
import { describe, expect, it } from "vitest";
import { DEFAULT_FUZZ_RUNS } from "./differential-fuzz-types.js";

describe("differential-fuzz-types — DEFAULT_FUZZ_RUNS", () => {
	it("P1: DEFAULT_FUZZ_RUNS is the documented default of 300 fast-check runs", () => {
		expect(DEFAULT_FUZZ_RUNS).toBe(300);
	});

	it("N1: DEFAULT_FUZZ_RUNS is a positive integer, not a placeholder zero or fraction", () => {
		expect(Number.isInteger(DEFAULT_FUZZ_RUNS)).toBe(true);
		expect(DEFAULT_FUZZ_RUNS).toBeGreaterThan(0);
	});
});
