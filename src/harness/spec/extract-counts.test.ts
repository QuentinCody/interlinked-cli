import { describe, expect, it } from "vitest";
import { singularize } from "./extract-counts.js";

describe("singularize", () => {
	it("returns a word unchanged when it does not end in -s at all", () => {
		// "cat" hits none of the irregular / -ies / -sses / xes|ches|shes|zes /
		// plain -s branches, so it must fall through to the final
		// `return noun;` line. Inverting that fallback (e.g. stripping a
		// trailing character unconditionally) would return "ca", not "cat".
		expect(singularize("cat")).toBe("cat");
	});

	it("strips a bare trailing -s for a plain plural not matched by any special suffix rule", () => {
		expect(singularize("bets")).toBe("bet");
	});
});
