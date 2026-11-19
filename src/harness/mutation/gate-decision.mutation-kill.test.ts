import { describe, expect, it } from "vitest";
import { decideAndPersist } from "./gate-decision.js";
import type { MutationGateOutcome } from "./types.js";

const cleanWithManifest: Extract<MutationGateOutcome, { kind: "measured" }> = {
	kind: "measured",
	decision: "allow",
	receipt: {
		overlayHash: "h",
		generation: 0,
		sites: [],
		engine: "stryker",
		engineVersion: "0",
		measuredAt: "t",
		outcome: "measured_clean",
	},
	newSurvivors: [],
	uncoveredSites: [],
	changedSiteCount: 0,
	siteCountThreshold: 50,
	suiteRed: false,
	redWitnessFailed: false,
	refreshedManifest: {
		version: 1 as const,
		generation: 1,
		authoritativeAt: "t",
		engine: "stryker",
		engineVersion: "0",
		dependencyGraphVersion: "g",
		environmentHash: "e",
		files: {},
	},
};

describe("gate-decision mutation-kill", () => {
	// test-contract: bug — a measured-clean allow whose persist throws keeps the "persistence failed partway" warning on the wire decision
	it("surfaces the persistence-failed warning on the returned decision", () => {
		const d = decideAndPersist(
			cleanWithManifest,
			() => {
				throw new Error("disk full");
			},
			"block",
		);
		expect(d.decision).toBe("allow");
		const warnings = d.warnings ?? [];
		expect(warnings.some((w) => w.includes("persistence failed partway") && w.includes("disk full"))).toBe(true);
	});

	// test-contract: boundary — a successful persist adds no persistence warning
	it("adds no persistence warning when persist succeeds", () => {
		const d = decideAndPersist(cleanWithManifest, () => undefined, "block");
		expect((d.warnings ?? []).some((w) => w.includes("persistence failed partway"))).toBe(false);
	});
});
