import { describe, expect, it } from "vitest";
import { arrayForEachOffsets } from "./array-for-each.js";

// Census fault: `|| ts.isSatisfiesExpression(expression)` dropped survived the
// companion test (docs/reviews/kill-proof-census-harness.md).
describe("arrayForEachOffsets — satisfies wrappers", () => {
	// test-contract: public-api — a const array initialised through `satisfies` is still array evidence for forEach
	it("finds forEach on a const array declared with satisfies", () => {
		const source = "const values = [1, 2] satisfies number[];\nvalues.forEach((v) => use(v));";
		expect([...arrayForEachOffsets(source, "src/a.ts")]).toEqual([source.indexOf(".forEach")]);
	});

	// test-contract: public-api — an inline parenthesised satisfies receiver is unwrapped too
	it("finds forEach on an inline satisfies receiver", () => {
		const source = "([1, 2] satisfies number[]).forEach((v) => use(v));";
		expect(arrayForEachOffsets(source, "src/a.ts").size).toBe(1);
	});
});
