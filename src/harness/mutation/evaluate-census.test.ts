// Pins the pure census-fact helpers extracted from evaluate.ts (2026-09-01,
// line cap). Each derives one fact from the measured census; the verdict
// stays in evaluate.ts.

import { describe, expect, it } from "vitest";
import {
	continuityEvidenceGap,
	distinctChangedSites,
	inconclusiveCount,
	statusRegressions,
	uncoveredInChanged,
	zip,
} from "./evaluate-census.js";
import type { MeasuredMutant } from "./manifest-diff.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutantIdentity, MutantStatus } from "./types.js";

function identity(mutantId: string, symbolId = "sym-1", siteId = `${mutantId}-site`): MutantIdentity {
	return {
		mutantId,
		siteId,
		symbolId,
		qualifiedName: "f",
		mutator: "Eq",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
	};
}

function measured(mutantId: string, status: MutantStatus, symbolId = "sym-1"): MeasuredMutant {
	return { identity: identity(mutantId, symbolId), status };
}

function adapted(status: MutantStatus): AdaptedMutant {
	return { raw: { file: "src/x.ts", mutator: "Eq", originalLexeme: ">", replacement: ">=", startOffset: 0 }, status };
}

const NO_SETS = { changed: new Set<string>(), accepted: new Set<string>(), quarantined: new Set<string>() };

describe("census facts — positive (must fire)", () => {
	it("P1: zip pairs identities with adapter rows by index and truncates to the shorter side", () => {
		const out = zip([identity("a"), identity("b")], [adapted("killed")]);
		expect(out).toEqual([{ identity: identity("a"), status: "killed" }]);
	});

	it("P2: uncoveredInChanged reports distinct uncovered sites inside changed symbols", () => {
		const out = uncoveredInChanged([measured("a", "uncovered"), measured("b", "uncovered")], new Set(["sym-1"]));
		expect(out.sort()).toEqual(["a-site", "b-site"]);
	});

	it("P3: distinctChangedSites counts every derived site whose symbol changed", () => {
		expect(distinctChangedSites([identity("a"), identity("b"), identity("c", "sym-2")], new Set(["sym-1"]))).toBe(2);
	});

	it("P4: statusRegressions flags killed→survived and killed→uncovered in unchanged symbols", () => {
		const out = statusRegressions({
			measured: [measured("a", "survived"), measured("b", "uncovered")],
			sets: NO_SETS,
			prior: new Map([
				["a", "killed"],
				["b", "killed"],
			]),
			firstSeen: "t1",
		});
		expect(out.map((r) => r.mutantId)).toEqual(["a", "b"]);
	});

	it("P5: inconclusiveCount counts timeout and indeterminate file-wide", () => {
		expect(inconclusiveCount([measured("a", "timeout"), measured("b", "indeterminate"), measured("c", "killed")])).toBe(2);
	});

	it("P6: continuityEvidenceGap names the missing prior mutants", () => {
		expect(continuityEvidenceGap(["m1", "m2"])).toMatch(/2 prior mutant\(s\).*m1, m2/);
	});
});

describe("census facts — negative (must not fire)", () => {
	it("N1: uncoveredInChanged ignores uncovered mutants outside the changed region", () => {
		expect(uncoveredInChanged([measured("a", "uncovered")], new Set(["sym-9"]))).toEqual([]);
	});

	it("N2: statusRegressions skips changed and quarantined symbols, accepted survivors, and always-uncovered mutants", () => {
		const out = statusRegressions({
			measured: [
				measured("changed", "survived", "sym-c"),
				measured("quarantined", "survived", "sym-q"),
				measured("accepted", "survived"),
				measured("always", "uncovered"),
			],
			sets: { changed: new Set(["sym-c"]), accepted: new Set(["accepted"]), quarantined: new Set(["sym-q"]) },
			prior: new Map([["always", "uncovered"]]),
			firstSeen: "t1",
		});
		expect(out).toEqual([]);
	});

	it("N3: a conclusive census has no inconclusive count and no continuity gap", () => {
		expect(inconclusiveCount([measured("a", "killed")])).toBe(0);
		expect(continuityEvidenceGap([])).toBeNull();
	});
});
