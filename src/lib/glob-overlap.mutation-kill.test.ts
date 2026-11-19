import { describe, expect, it } from "vitest";
import { patternsOverlap } from "./glob-overlap.js";

describe("patternsOverlap — census kill", () => {
	// test-contract: invariant — a "*" in the first pattern matches an empty remainder in the second segment
	it("a* overlaps a literal a (wildcard may match nothing)", () => {
		expect(patternsOverlap("src/a*", "src/a")).toBe(true);
	});
});
