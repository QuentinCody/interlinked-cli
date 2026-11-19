// Mutation-kill tests for test-commented-assertion.ts — kill-proof census row 03
// (docs/reviews/kill-proof-census-harness.md): the per-file report cap.
import { describe, expect, it } from "vitest";
import { checkCommentedOutAssertion as check } from "./test-commented-assertion.js";

describe("commented assertions — report cap", () => {
	// test-contract: boundary — a file with more than ten commented assertions reports exactly the first ten, in line order
	it("caps the findings at ten and keeps the first ten lines", () => {
		const body = Array.from({ length: 12 }, (_, i) => ` // expect(value${i}).toBe(${i});`).join("\n");
		const code = `it("claim", () => {\n${body}\n});`;
		expect(check(code, "api.test.ts").map((finding) => finding.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});
	// test-contract: boundary — exactly ten commented assertions are all reported
	it("reports all ten when there are exactly ten", () => {
		const body = Array.from({ length: 10 }, (_, i) => ` // expect(value${i}).toBe(${i});`).join("\n");
		const code = `it("claim", () => {\n${body}\n});`;
		expect(check(code, "api.test.ts")).toHaveLength(10);
	});
});
