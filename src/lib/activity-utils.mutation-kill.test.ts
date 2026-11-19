import { expect, it } from "vitest";
import { formatActivitySummary } from "./activity-utils.js";

// test-contract: boundary — a token total of exactly 1000 renders in the "k tok" form
it("renders exactly 1000 tokens as 1.0k tok", () => {
	expect(
		formatActivitySummary({ tool_name: "Read", summary: "a.ts", tokens: { input: 600, output: 400 } }),
	).toBe("Read a.ts (1.0k tok)");
});

// test-contract: boundary — a token total of 999 renders as a plain count
it("renders 999 tokens as a plain count", () => {
	expect(
		formatActivitySummary({ tool_name: "Read", summary: "a.ts", tokens: { input: 500, output: 499 } }),
	).toBe("Read a.ts (999 tok)");
});
