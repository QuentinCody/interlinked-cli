import { nonNull } from "../../lib/non-null.js";
// Tests for derived case floors. (The mutation floor was removed 2026-11-05;
// recall.ts names the trusted score file that would turn it back on.)

import { describe, expect, it } from "vitest";
import { OBLIGATION_TIERS } from "./obligations.js";
import * as recall from "./recall.js";
import { DERIVED_FLOOR_CAP, derivedCaseFloor, detectorCyclomatic } from "./recall.js";

const BRANCHY = `
export function detectThing(content: string, filePath: string): number[] {
	const out: number[] = [];
	if (!content) return out;
	if (filePath.endsWith(".d.ts")) return out;
	for (const line of content.split("\\n")) {
		if (line.includes("eval(")) out.push(1);
		else if (line.includes("Function(")) out.push(2);
	}
	return out;
}

export function detectSimple(content: string): number[] {
	return content.length > 0 ? [1] : [];
}
`;

describe("detectorCyclomatic — positive (must measure)", () => {
	it("P1: measures a branchy detector above 1", () => {
		const c = detectorCyclomatic(BRANCHY, "src/checks/thing.ts", "detectThing");
		expect(c).not.toBeNull();
		expect(nonNull(c)).toBeGreaterThan(3);
	});

	it("P2: measures a near-linear detector low", () => {
		const c = detectorCyclomatic(BRANCHY, "src/checks/thing.ts", "detectSimple");
		expect(c).not.toBeNull();
		expect(nonNull(c)).toBeLessThan(4);
	});

	it("P3: distinguishes two functions in one file", () => {
		const a = nonNull(detectorCyclomatic(BRANCHY, "src/checks/thing.ts", "detectThing"));
		const b = nonNull(detectorCyclomatic(BRANCHY, "src/checks/thing.ts", "detectSimple"));
		expect(a).toBeGreaterThan(b);
	});
});

describe("detectorCyclomatic — negative (must report UNKNOWN, not zero)", () => {
	it("N1: returns null for a function that is not present", () => {
		expect(detectorCyclomatic(BRANCHY, "src/checks/thing.ts", "noSuchDetector")).toBeNull();
	});

	it("N2: returns null for an empty source", () => {
		expect(detectorCyclomatic("", "src/checks/thing.ts", "detectThing")).toBeNull();
	});
});

describe("derivedCaseFloor", () => {
	it("P1: raises the floor for a branchy detector", () => {
		expect(derivedCaseFloor(9, OBLIGATION_TIERS.post_advisory)).toBe(9);
	});

	it("P2: caps the derived floor so it stays actionable", () => {
		expect(derivedCaseFloor(40, OBLIGATION_TIERS.post_advisory)).toBe(DERIVED_FLOOR_CAP);
	});

	it("N1: never falls below the tier floor for a one-branch detector", () => {
		// A single-branch pre_block detector still earns pre_block scrutiny.
		const tierFloor = OBLIGATION_TIERS.pre_block.min_positive + OBLIGATION_TIERS.pre_block.min_negative;
		expect(derivedCaseFloor(1, OBLIGATION_TIERS.pre_block)).toBe(tierFloor);
	});

	it("N2: an UNKNOWN measurement falls back to the tier floor, not to 1", () => {
		const tierFloor = OBLIGATION_TIERS.post_advisory.min_positive + OBLIGATION_TIERS.post_advisory.min_negative;
		expect(derivedCaseFloor(null, OBLIGATION_TIERS.post_advisory)).toBe(tierFloor);
	});

	it("N3: takes the stricter of tier and structure", () => {
		expect(derivedCaseFloor(3, OBLIGATION_TIERS.pre_block)).toBe(6);
		expect(derivedCaseFloor(10, OBLIGATION_TIERS.pre_block)).toBe(10);
	});
});

describe("mutation floor (removed 2026-11-05)", () => {
	it("N1: no tier demands a mutation score while no trusted score file exists", () => {
		for (const tier of Object.values(OBLIGATION_TIERS)) expect(Object.keys(tier)).not.toContain("requires_mutation");
	});

	it("N2: recall exports no mutation-score reader", () => {
		expect(Object.keys(recall).filter((name) => /mutation/i.test(name))).toEqual([]);
	});
});
