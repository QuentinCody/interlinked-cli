import { describe, expect, it } from "vitest";
import { parseClauses } from "./clauses.js";

describe("parseClauses — list tidy", () => {
	// test-contract: public-api — a leading "and" from a serial list is removed from the last quiet clause.
	it("drops the leading 'and' from the last DOES NOT FIRE item", () => {
		const source = "// FIRES WHEN: x.\n// DOES NOT FIRE: alpha, beta, and gamma.\n// CALIBRATION: y";
		expect(parseClauses(source).map((c) => c.text)).toEqual(["x", "alpha", "beta", "gamma"]);
	});
});
