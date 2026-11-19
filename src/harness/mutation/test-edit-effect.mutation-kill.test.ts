import { describe, expect, it } from "vitest";
import type { AdaptedMutant } from "./stryker-adapter.js";
import { testEditEffect } from "./test-edit-effect.js";
import type { MutationManifest } from "./types.js";

const manifest: MutationManifest = {
	version: 1,
	generation: 1,
	authoritativeAt: "2026-08-07T00:00:00.000Z",
	engine: "stryker",
	engineVersion: "x",
	dependencyGraphVersion: "1",
	environmentHash: "h",
	files: {
		"src/a.ts": {
			sym: {
				symbolId: "sym",
				qualifiedName: "f",
				symbolHash: "sh",
				instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
				mutants: {
					m0: {
						mutantId: "m0",
						siteId: "s0",
						mutator: "X",
						originalLexeme: "a",
						replacement: "b",
						ordinalWithinSymbol: 0,
						status: "survived",
						firstSeen: "2026-08-07T00:00:00.000Z",
					},
				},
			},
		},
	},
};

const uncoveredMutant: AdaptedMutant = {
	status: "uncovered",
	raw: { file: "src/a.ts", mutator: "EqualityOperator", originalLexeme: "===", replacement: "!==", startOffset: 0 },
};

describe("test-edit-effect mutation-kill", () => {
	// test-contract: public-api — an uncovered mutant in the measured run still counts as a surviving mutant after the test edit
	it("counts an uncovered measured mutant as surviving, so the test killed nothing", () => {
		const w = testEditEffect(["src/a.test.ts"], "src/a.ts", manifest, [uncoveredMutant]);
		expect(w).toContain("killed NO mutants");
		expect(w).toContain("1 survivor(s) before and after");
	});
});
