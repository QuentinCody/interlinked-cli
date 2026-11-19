import { describe, expect, it } from "vitest";
import { seedReadsFromSession } from "./rehydrate.js";
import { createState } from "./state.js";

// Census fault: the `!file` guard was dropped, so "" became a seeded read (docs/reviews/kill-proof-census-e2e-structure.md #32).
describe("seedReadsFromSession — an empty path is not a read", () => {
	// test-contract: invariant — an empty path in the hydrated read set seeds nothing and does not raise readCount
	it("skips empty paths", () => {
		const state = createState("s1");
		seedReadsFromSession(state, ["", "/r/a.ts"]);
		expect([...state.fileReadSteps.keys()]).toEqual(["/r/a.ts"]);
		expect(state.readCount).toBe(1);
	});
	// test-contract: invariant — a read set holding only an empty path leaves the state cold (no orientation)
	it("leaves the state unoriented when the only path is empty", () => {
		const state = createState("s1");
		seedReadsFromSession(state, [""]);
		expect(state.fileReadSteps.size).toBe(0);
		expect(state.readCount).toBe(0);
	});
});
