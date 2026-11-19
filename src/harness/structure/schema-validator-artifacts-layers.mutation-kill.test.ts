import { describe, expect, it } from "vitest";
import { validateLayerRuleEntry } from "./schema-validator-artifacts-layers.js";
import type { ValidationError } from "./schema-validator-helpers.js";

function validate(reason: string): ValidationError[] {
	const errors: ValidationError[] = [];
	validateLayerRuleEntry({ from: "ui", cannot_import: ["db"], reason }, "$.rules[0]", new Set(["ui", "db"]), errors);
	return errors;
}

// Census fault: `> 160` became `>= 160` (docs/reviews/kill-proof-census-e2e-structure.md #25).
describe("validateLayerRuleEntry — the reason length limit is 160 characters inclusive", () => {
	// test-contract: boundary — a reason of exactly 160 characters is accepted (the spec says "stay under 160", the validator warns only past 160)
	it("accepts a 160-character reason", () => {
		expect(validate("x".repeat(160))).toEqual([]);
	});
	// test-contract: boundary — a reason of 161 characters is flagged at the reason path
	it("flags a 161-character reason", () => {
		expect(validate("x".repeat(161))).toEqual([{ path: "$.rules[0].reason", message: "Should be under 160 characters" }]);
	});
});
