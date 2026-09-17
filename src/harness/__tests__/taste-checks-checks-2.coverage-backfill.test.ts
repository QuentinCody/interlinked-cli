// Coverage backfill for src/harness/taste-checks-checks-2.ts sites left
// uncovered after the 2026-09 checks: tryHasCatch's conservative
// never-closed-block default, checkNonDeterministicTest's @perf opt-out
// early return, and checkEmptyCatch's 10-match cap. See sibling
// taste-checks.integration.test.ts for the primary behavior suite this
// file does not duplicate.
import { describe, expect, it } from "vitest";
import { checkConditionalInTest, checkEmptyCatch, checkNonDeterministicTest } from "../taste-checks-checks-2.js";

describe("checkConditionalInTest — unclosed try block", () => {
	it("flags a try whose braces never balance before the file ends (tryHasCatch's conservative default)", () => {
		// tryHasCatch walks forward looking for the try block's matching close
		// brace; when the file ends first (malformed/truncated content) it
		// stays conservative and reports "has catch" rather than guessing —
		// which means the outer try IS treated as branching and gets flagged.
		const content = `
			it("thing", () => {
				try {
					doSomething();
		`;
		expect(checkConditionalInTest(content, "/x/foo.test.ts").length).toBe(1);
	});
});

describe("checkNonDeterministicTest — @perf opt-out", () => {
	it("skips a file carrying a @perf marker comment even though it uses Date.now()", () => {
		const content = `
			// @perf this file intentionally measures wall-clock time
			it("benchmarks", () => {
				const start = Date.now();
				expect(start).toBeGreaterThan(0);
			});
		`;
		expect(checkNonDeterministicTest(content, "/x/foo.test.ts")).toEqual([]);
	});

	it("skips a file carrying an @allow-non-deterministic marker comment", () => {
		const content = `
			// @allow-non-deterministic
			it("benchmarks", () => {
				const start = performance.now();
				expect(start).toBeGreaterThan(0);
			});
		`;
		expect(checkNonDeterministicTest(content, "/x/foo.test.ts")).toEqual([]);
	});
});

describe("checkEmptyCatch — result cap", () => {
	it("stops collecting once 10 empty catch blocks have been reported", () => {
		const blocks = Array.from({ length: 12 }, (_, i) => `try { risky${i}(); } catch (e) {}`).join("\n");
		const matches = checkEmptyCatch(blocks, "/src/foo.ts");
		expect(matches.length).toBe(10);
	});
});
