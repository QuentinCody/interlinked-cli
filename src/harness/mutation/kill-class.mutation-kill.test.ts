import { describe, expect, it } from "vitest";
import { classifyKill } from "./kill-class.js";

describe("classifyKill — snapshot mismatch", () => {
	// test-contract: bug — a vitest snapshot mismatch is an assertion kill, not unknown
	it("classifies a snapshot mismatch as assertion", () => {
		expect(classifyKill("Killed", "Snapshot `renders 1` mismatched")).toBe("assertion");
	});
});
