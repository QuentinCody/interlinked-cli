import { expect, it } from "vitest";
import { isExcluded } from "./manual-debt-markers-default-excluded-segments.js";

// test-contract: boundary — a custom exclusion matches whole path segments, not string prefixes
it("does not exclude a sibling path that only shares the prefix", () => {
	expect(isExcluded("srcfoo/a.ts", ["src"])).toBe(false);
	expect(isExcluded("src/a.ts", ["src"])).toBe(true);
	expect(isExcluded("src", ["src"])).toBe(true);
});
