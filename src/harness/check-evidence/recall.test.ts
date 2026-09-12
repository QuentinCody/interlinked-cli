import { nonNull } from "../../lib/non-null.js";
// Tests for derived case floors and detector mutation scores.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OBLIGATION_TIERS } from "./obligations.js";
import {
	DERIVED_FLOOR_CAP,
	derivedCaseFloor,
	detectorCyclomatic,
	loadMutationScores,
	mutationFloorFor,
	parseMutationScores,
} from "./recall.js";

let root: string;

function write(rel: string, content: string): void {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cec-recall-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

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

describe("parseMutationScores", () => {
	it("reads per-file scores", () => {
		expect(parseMutationScores({ files: { "src/a.ts": { score: 0.75 } } })).toEqual({ "src/a.ts": 0.75 });
	});

	it("drops non-numeric scores", () => {
		expect(parseMutationScores({ files: { "src/a.ts": { score: "high" } } })).toEqual({});
	});

	it("ignores non-object file records beside valid mutation scores", () => {
		expect(parseMutationScores({ files: { bad: null, array: [], "src/a.ts": { score: 0.75 } } })).toEqual({ "src/a.ts": 0.75 });
	});

	it("drops non-finite scores", () => {
		expect(parseMutationScores({ files: { "src/a.ts": { score: Number.NaN } } })).toEqual({});
	});

	it("fails closed on a missing files map", () => {
		expect(parseMutationScores({ version: 1 })).toEqual({});
	});

	it("fails closed on non-object input", () => {
		expect(parseMutationScores(null)).toEqual({});
	});
});

describe("loadMutationScores", () => {
	it("returns an empty map when no baseline exists", () => {
		expect(loadMutationScores(root)).toEqual({});
	});

	it("loads scores from a committed baseline", () => {
		write(".interlinked/mutation-baseline.json", JSON.stringify({ files: { "src/a.ts": { score: 0.9 } } }));
		expect(loadMutationScores(root)).toEqual({ "src/a.ts": 0.9 });
	});

	it("fails closed on a malformed baseline", () => {
		write(".interlinked/mutation-baseline.json", "{ broken");
		expect(loadMutationScores(root)).toEqual({});
	});
});

describe("mutationFloorFor", () => {
	it("demands a score from tiers that require mutation", () => {
		expect(mutationFloorFor(OBLIGATION_TIERS.pre_block)).toBeGreaterThan(0);
		expect(mutationFloorFor(OBLIGATION_TIERS.pre_warn)).toBeGreaterThan(0);
	});

	it("demands none from tiers that do not", () => {
		expect(mutationFloorFor(OBLIGATION_TIERS.post_default)).toBe(0);
		expect(mutationFloorFor(OBLIGATION_TIERS.post_advisory)).toBe(0);
	});
});
