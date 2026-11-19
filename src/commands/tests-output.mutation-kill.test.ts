import { expect, it } from "vitest";
import { formatPendingTestPaths } from "./tests-output.js";

// test-contract: boundary — a line of exactly 320 characters is shown whole, 321 is clipped
it("does not clip a 320-character line but clips a 321-character one", () => {
	const exact = "a".repeat(320);
	expect(formatPendingTestPaths([exact])).toBe(exact);
	const over = formatPendingTestPaths(["a".repeat(321)]).split("\n");
	expect(over[0]).toBe(`${"a".repeat(320)}…`);
	expect(over[1]).toMatch(/long entries shortened/);
});
