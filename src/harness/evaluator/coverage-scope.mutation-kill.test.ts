import { describe, expect, it } from "vitest";
import { coverageScopeId } from "./coverage-scope.js";

describe("coverage-scope mutation-kill", () => {
	// test-contract: invariant — different test lists whose concatenation is equal still get different scope ids
	it("separates test names so equal concatenations do not share a scope id", () => {
		expect(coverageScopeId(["ab", "c"])).not.toBe(coverageScopeId(["a", "bc"]));
	});
});
