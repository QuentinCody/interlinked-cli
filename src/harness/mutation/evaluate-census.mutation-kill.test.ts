import { describe, expect, it } from "vitest";
import { uncoveredInChanged } from "./evaluate-census.js";
import type { MeasuredMutant } from "./manifest-diff.js";
import type { MutantStatus } from "./types.js";

function m(status: MutantStatus, siteId: string, symbolId = "sym-1"): MeasuredMutant {
	return {
		identity: {
			mutantId: `${siteId}-m`,
			siteId,
			symbolId,
			qualifiedName: "f",
			mutator: "Eq",
			originalLexeme: ">",
			replacement: ">=",
			ordinalWithinSymbol: 0,
		},
		status,
	};
}

describe("evaluate-census mutation-kill", () => {
	// test-contract: public-api — uncoveredInChanged reports only uncovered sites in changed symbols, never killed or survived ones
	it("reports only uncovered sites, not killed or survived sites in a changed symbol", () => {
		const measured = [m("killed", "s-killed"), m("survived", "s-survived"), m("uncovered", "s-uncovered")];
		expect(uncoveredInChanged(measured, new Set(["sym-1"]))).toEqual(["s-uncovered"]);
	});
});
