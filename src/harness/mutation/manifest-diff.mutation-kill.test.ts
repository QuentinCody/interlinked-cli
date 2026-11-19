import { describe, expect, it } from "vitest";
import { computeNewSurvivors } from "./manifest-diff.js";
import type { MeasuredMutant } from "./manifest-diff.js";

const measuredSurvivor: MeasuredMutant = {
	identity: {
		mutantId: "m-1",
		siteId: "site-1",
		symbolId: "sym-q",
		qualifiedName: "f",
		mutator: "Eq",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
	},
	status: "survived",
};

describe("manifest-diff mutation-kill", () => {
	// test-contract: invariant — a survivor in a quarantined symbol is WARN territory and is never returned as a blocking new survivor
	it("excludes a changed, unaccepted survivor whose symbol is quarantined", () => {
		const sets = {
			changed: new Set(["sym-q"]),
			accepted: new Set<string>(),
			quarantined: new Set(["sym-q"]),
		};
		expect(computeNewSurvivors([measuredSurvivor], sets, "t")).toEqual([]);
	});
});
