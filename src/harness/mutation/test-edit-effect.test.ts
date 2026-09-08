import { describe, expect, it } from "vitest";
import type { AdaptedMutant } from "./stryker-adapter.js";
import { baselineSurvivorCount, isSurvivingStatus, testEditEffect, testEditEffectWarning } from "./test-edit-effect.js";
import type { MutantStatus, MutationManifest } from "./types.js";

function manifestWith(file: string, statuses: MutantStatus[]): MutationManifest {
	return {
		version: 1,
		generation: 1,
		authoritativeAt: "2026-08-07T00:00:00.000Z",
		engine: "stryker",
		engineVersion: "x",
		dependencyGraphVersion: "1",
		environmentHash: "h",
		files: {
			[file]: {
				sym: {
					symbolId: "sym",
					qualifiedName: "f",
					symbolHash: "sh",
					instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
					mutants: Object.fromEntries(
						statuses.map((status, i) => [
							`m${i}`,
							{ mutantId: `m${i}`, siteId: `s${i}`, mutator: "X", originalLexeme: "a", replacement: "b", ordinalWithinSymbol: i, status, firstSeen: "2026-08-07T00:00:00.000Z" },
						]),
					),
				},
			},
		},
	};
}

function mutants(statuses: MutantStatus[]): AdaptedMutant[] {
	return statuses.map((status, startOffset) => ({
		status,
		raw: {
			file: "src/a.ts",
			mutator: "EqualityOperator",
			originalLexeme: "===",
			replacement: "!==",
			startOffset,
		},
	}));
}

describe("isSurvivingStatus — what counts as UNJUSTIFIED", () => {
	it("P1: counts survived", () => {
		expect(isSurvivingStatus("survived")).toBe(true);
	});

	it("P2: counts uncovered — a mutant nothing runs is not one anything caught", () => {
		expect(isSurvivingStatus("uncovered")).toBe(true);
	});

	it("N1: does not count killed or timeout — both mean the suite noticed", () => {
		expect(isSurvivingStatus("killed")).toBe(false);
		expect(isSurvivingStatus("timeout")).toBe(false);
	});

	it("N2: does not count equivalent — that is exactly what JUSTIFIED means", () => {
		expect(isSurvivingStatus("equivalent")).toBe(false);
	});

	it("N3: does not count indeterminate — an unresolved run is not a survivor", () => {
		expect(isSurvivingStatus("indeterminate")).toBe(false);
	});
});

describe("baselineSurvivorCount", () => {
	it("counts only the unjustified statuses", () => {
		const m = manifestWith("src/a.ts", ["survived", "uncovered", "killed", "equivalent", "indeterminate"]);
		expect(baselineSurvivorCount(m, "src/a.ts")).toBe(2);
	});

	it("returns null — not 0 — for a file with no baseline", () => {
		// Null and zero must stay distinct: reporting "0 → 12" on a first
		// measurement would charge the edit with every pre-existing survivor.
		expect(baselineSurvivorCount(manifestWith("src/a.ts", []), "src/other.ts")).toBeNull();
	});

	it("returns 0 for a measured file with no survivors", () => {
		expect(baselineSurvivorCount(manifestWith("src/a.ts", ["killed"]), "src/a.ts")).toBe(0);
	});
});

describe("testEditEffectWarning", () => {
	const base = { file: "src/a.ts", testFile: "src/a.test.ts" };

	it("reports how many mutants the test killed", () => {
		const msg = testEditEffectWarning({ ...base, before: 10, after: 4 });
		expect(msg).toContain("killed 6 mutant(s)");
		expect(msg).toContain("10 → 4");
	});

	it("says plainly when the test killed nothing", () => {
		const msg = testEditEffectWarning({ ...base, before: 7, after: 7 });
		expect(msg).toContain("killed NO mutants");
		expect(msg).toContain("Assert on the value the code computes");
	});

	it("flags a RISE as a signal about the suite, not the new test", () => {
		const msg = testEditEffectWarning({ ...base, before: 3, after: 5 });
		expect(msg).toContain("ROSE 3 → 5");
		expect(msg).toContain("skipped, renamed, or newly-flaky");
	});

	it("stays silent on a first sighting, where no comparison was made", () => {
		expect(testEditEffectWarning({ ...base, before: null, after: 9 })).toBeNull();
	});
});

describe("testEditEffect — fires only for a test-only change set", () => {
	const manifest = manifestWith("src/a.ts", ["survived", "survived", "survived"]);

	it("P1: reports the delta when only a test changed", () => {
		const msg = testEditEffect(["src/a.test.ts"], "src/a.ts", manifest, mutants(["survived", "killed", "killed"]));
		expect(msg).toContain("killed 2 mutant(s)");
	});

	it("P2: reports the no-op case when only a test changed and nothing died", () => {
		const msg = testEditEffect(
			["src/a.test.ts"],
			"src/a.ts",
			manifest,
			mutants(["survived", "survived", "survived"]),
		);
		expect(msg).toContain("killed NO mutants");
	});

	it("N1: stays silent when the SOURCE changed — the mutant population changed with it", () => {
		// Comparing survivor counts across two different mutant sets is not a
		// comparison; evaluate.ts's new-survivor diff is the right instrument.
		expect(testEditEffect(["src/a.ts"], "src/a.ts", manifest, mutants(["survived"]))).toBeNull();
	});

	it("N2: stays silent for a mixed source+test change set", () => {
		expect(testEditEffect(["src/a.ts", "src/a.test.ts"], "src/a.ts", manifest, mutants(["survived"]))).toBeNull();
	});

	it("N3: stays silent for an empty change set", () => {
		expect(testEditEffect([], "src/a.ts", manifest, mutants(["survived"]))).toBeNull();
	});

	it("N4: stays silent when the target has no baseline to compare against", () => {
		expect(testEditEffect(["src/z.test.ts"], "src/z.ts", manifest, mutants(["survived"]))).toBeNull();
	});
});
