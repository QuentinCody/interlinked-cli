import { describe, expect, it } from "vitest";
import { parseStability } from "./policy-stability.js";

describe("parseStability — mutation-directed", () => {
	// test-contract: boundary — the documented maximum of five qualification runs is accepted, six is refused
	it("accepts exactly 5 qualification runs and refuses 6", () => {
		expect(() => parseStability({ qualificationRuns: 5 }, "stability")).not.toThrow();
		expect(parseStability({ qualificationRuns: 5 }, "stability").qualificationRuns).toBe(5);
		expect(() => parseStability({ qualificationRuns: 6 }, "stability")).toThrow(/from 1 to 5/);
	});
});
