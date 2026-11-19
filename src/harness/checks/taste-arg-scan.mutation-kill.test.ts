// Mutation-kill tests for taste-arg-scan.ts — kill-proof census row 13
// (docs/reviews/kill-proof-census-harness.md): `[` opens a nested group.
import { describe, expect, it } from "vitest";
import { countBooleanArgsFrom } from "./taste-arg-scan.js";

describe("countBooleanArgsFrom — array literals nest", () => {
	// test-contract: public-api — commas inside an array-literal argument do not split top-level arguments
	it("counts only the top-level boolean when the first argument is an array", () => {
		expect(countBooleanArgsFrom("f([1, 2], true)", 2)).toBe(1);
	});
	// test-contract: public-api — a boolean element inside an array argument is not a top-level boolean argument
	it("does not count a boolean inside an array argument", () => {
		expect(countBooleanArgsFrom("f([true, false], 3)", 2)).toBe(0);
	});
});
