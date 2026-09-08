import { describe, expect, it } from "vitest";
import type { MutantRecord, MutationGateOutcome, MutationReceipt, StableId } from "./types.js";
import { mutationOutcomeToDecision } from "./verdict.js";

const receipt: MutationReceipt = {
	overlayHash: "h",
	generation: 1,
	sites: [],
	engine: "stryker",
	engineVersion: "1",
	measuredAt: "t",
	outcome: "measured_clean",
};

/** Build a measured outcome; site-count defaults keep oversize OFF unless overridden. */
function measured(f: {
	decision: "allow" | "block";
	newSurvivors?: MutantRecord[];
	uncoveredSites?: StableId[];
	changedSiteCount?: number;
	siteCountThreshold?: number;
	suiteRed?: boolean;
	redWitnessFailed?: boolean;
}): MutationGateOutcome {
	return {
		kind: "measured",
		decision: f.decision,
		receipt,
		newSurvivors: f.newSurvivors ?? [],
		uncoveredSites: f.uncoveredSites ?? [],
		changedSiteCount: f.changedSiteCount ?? 1,
		siteCountThreshold: f.siteCountThreshold ?? 50,
		suiteRed: f.suiteRed ?? false,
		redWitnessFailed: f.redWitnessFailed ?? false,
	};
}

function survivor(mutator: string): MutantRecord {
	return {
		mutantId: "m",
		siteId: "s",
		mutator,
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
		status: "survived",
		firstSeen: "t",
	};
}

describe("mutationOutcomeToDecision", () => {
	it("maps unavailable to allow + a not-measured warning, never a clean pass", () => {
		const d = mutationOutcomeToDecision({
			kind: "unavailable",
			reason: "cloud down",
			warning: "[mutation:not-measured] cloud down",
		});
		expect(d.decision).toBe("allow");
		expect(d.warnings).toEqual(["[mutation:not-measured] cloud down"]);
		expect(d.reason).toBeUndefined();
	});

	// Review 2026-08-28 item 1: adoption is an allow — the gate must not block a
	// bootstrap — but its warning MUST survive onto the wire, so the agent (and
	// any report) sees "adopted", never a silent pass that reads as clean.
	it("maps baseline_adoption_ready to allow WITH the adoption warning on the wire", () => {
		const d = mutationOutcomeToDecision({
			kind: "baseline_adoption_ready",
			receipt: { ...receipt, outcome: "baseline_adopted" },
			refreshedManifest: {
				version: 1,
				generation: 1,
				authoritativeAt: "t",
				engine: "stryker",
				engineVersion: "1",
				dependencyGraphVersion: "g",
				environmentHash: "e",
				files: {},
			},
			warning: "[interlinked:mutation] baseline adopted for src/x.ts — NOT certified clean",
		});
		expect(d.decision).toBe("allow");
		expect(d.warnings?.[0]).toContain("baseline adopted");
		expect(d.warnings?.[0]).toContain("NOT certified clean");
	});

	// Review 2026-08-28 item 3: adoption must not swallow the RED-witness — a
	// new test that never failed on base is still worth flagging on a first
	// sighting, arguably MORE so (the adopted floor rests on that test).
	it("emits BOTH the adoption warning and the RED-witness warning on a first sighting", () => {
		const d = mutationOutcomeToDecision({
			kind: "baseline_adoption_ready",
			receipt: { ...receipt, outcome: "baseline_adopted" },
			refreshedManifest: {
				version: 1,
				generation: 1,
				authoritativeAt: "t",
				engine: "stryker",
				engineVersion: "1",
				dependencyGraphVersion: "g",
				environmentHash: "e",
				files: {},
			},
			warning: "[interlinked:mutation] baseline adopted for src/x.ts — NOT certified clean",
			redWitnessFailed: true,
		});
		expect(d.decision).toBe("allow");
		expect(d.warnings).toHaveLength(2);
		expect(d.warnings?.[0]).toContain("baseline adopted");
		expect(d.warnings?.[1]).toContain("RED-witness");
	});

	it("maps a measured-clean allow to a plain allow", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "allow" }));
		expect(d.decision).toBe("allow");
		expect(d.reason).toBeUndefined();
		expect(d.warnings).toBeUndefined();
	});

	it("maps a survivor block to a block carrying the work-list, no uncovered text", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "block", newSurvivors: [survivor("EqualityOperator")] }));
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("1 new surviving mutant(s)");
		expect(d.reason).toContain("EqualityOperator >→>=");
		expect(d.reason).not.toContain("uncovered");
		expect(d.rule_id).toBe("per-edit-mutation");
		expect(d.severity).toBe("medium");
	});

	it("maps an uncovered-only block without a survivor list", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "block", uncoveredSites: ["a", "b"] }));
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("2 uncovered changed mutation site(s)");
		expect(d.reason).not.toContain("Survivors:");
	});

	it("maps an oversize block to the 'split this patch' message, suppressing the survivor list", () => {
		// Oversize takes precedence: even with a survivor present, the actionable is "split".
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", newSurvivors: [survivor("EqualityOperator")], changedSiteCount: 51, siteCountThreshold: 50 }),
		);
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("51 mutation sites");
		expect(d.reason).toContain("50-site small-scope limit");
		expect(d.reason).not.toContain("Survivors:");
	});

	it("maps a red suite to the top-priority red/green block, over oversize and survivors", () => {
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", suiteRed: true, newSurvivors: [survivor("Eq")], changedSiteCount: 99, siteCountThreshold: 50 }),
		);
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("RED on this edit");
		expect(d.reason).not.toContain("mutation sites"); // not the oversize message
		expect(d.reason).not.toContain("Survivors:");
	});

	it("maps a failed RED-witness to allow + a non-blocking warning", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "allow", redWitnessFailed: true }));
		expect(d.decision).toBe("allow");
		expect(d.reason).toBeUndefined();
		expect(d.warnings?.[0]).toContain("RED-witness unmet");
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 11 survivors of 64. This module writes the sentence the
// agent reads when it is blocked — wrong wording here wastes a human's time
// diagnosing the wrong thing, and no test was checking the words.
// ---------------------------------------------------------------------------

// SAFETY: StableId is a branded string; these are opaque site handles the
// formatter only ever counts, never parses, so any distinct value is valid.
const siteId = (s: string): StableId => s;

describe("block reasons say which problem it is", () => {
	it("names the survivor count and lists the survivors", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "block", newSurvivors: [survivor("Eq")] }));
		expect(d.reason).toContain("1 new surviving mutant(s)");
		expect(d.reason).toContain("Survivors: Eq >→>=");
	});

	it("names uncovered sites when that is the problem", () => {
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", uncoveredSites: [siteId("a"), siteId("b")] }),
		);
		expect(d.reason).toContain("2 uncovered changed mutation site(s)");
	});

	it("joins both problems rather than reporting only the first", () => {
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", newSurvivors: [survivor("Eq")], uncoveredSites: [siteId("a")] }),
		);
		expect(d.reason).toContain("surviving mutant(s) + ");
		expect(d.reason).toContain("uncovered changed mutation site(s)");
	});

	it("omits the Survivors detail entirely when there are none", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "block", uncoveredSites: [siteId("a")] }));
		expect(d.reason).not.toContain("Survivors:");
	});

	it("tells the reader how to resolve it", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "block", newSurvivors: [survivor("Eq")] }));
		expect(d.reason).toContain("strengthening the test");
	});
});

describe("block-reason priority — the most fundamental failure wins", () => {
	it("reports a RED suite ahead of survivors, because survivors are meaningless then", () => {
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", suiteRed: true, newSurvivors: [survivor("Eq")] }),
		);
		expect(d.reason).toContain("RED on this edit");
		expect(d.reason).not.toContain("surviving mutant(s)");
	});

	it("reports oversize ahead of survivors — 'split the patch', not 'write a test'", () => {
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", changedSiteCount: 51, siteCountThreshold: 50, newSurvivors: [survivor("Eq")] }),
		);
		expect(d.reason).toContain("51 mutation sites");
		expect(d.reason).not.toContain("strengthening the test");
	});

	it("does NOT report oversize when the count merely equals the threshold", () => {
		// `>` not `>=`: at the ceiling is inside it.
		const d = mutationOutcomeToDecision(
			measured({ decision: "block", changedSiteCount: 50, siteCountThreshold: 50, newSurvivors: [survivor("Eq")] }),
		);
		expect(d.reason).toContain("surviving mutant(s)");
	});
});

describe("warnings on an allow", () => {
	it("surfaces an unmet RED-witness as a warning, never a block", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "allow", redWitnessFailed: true }));
		expect(d.decision).toBe("allow");
		expect(d.warnings?.join("\n")).toContain("RED-witness unmet");
	});

	it("says nothing on a clean allow", () => {
		const d = mutationOutcomeToDecision(measured({ decision: "allow" }));
		expect(d.warnings ?? []).toHaveLength(0);
	});
});
