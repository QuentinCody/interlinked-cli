import { describe, expect, it } from "vitest";
import { getOutputMode } from "./output.js";

describe("getOutputMode — census kill", () => {
	// test-contract: invariant — short wins over full when both flags are set (documented precedence json > short > full)
	it("returns short when both short and full are set", () => {
		expect(getOutputMode({ short: true, full: true })).toBe("short");
	});
});
