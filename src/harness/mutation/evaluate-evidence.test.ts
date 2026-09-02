// Pins the protocol-v2 evidence floor (extracted from evaluate.ts for the
// 500-line cap). The gaps here are the reasons a run can BLOCK on what it
// proved but can never CERTIFY clean — goal 28 §8.

import { describe, expect, it } from "vitest";
import { executedTestEvidenceGap, runEvidenceGaps, v2RunEvidenceGaps } from "./evaluate-evidence.js";

const GREEN = { overlayGreen: true, redWitnessSatisfied: null };

describe("v2RunEvidenceGaps — positive (must fire)", () => {
	it("P1: an absent test run, a missing test count, and a missing engine exit are three separate gaps", () => {
		const gaps = v2RunEvidenceGaps({});
		expect(gaps).toHaveLength(3);
		expect(gaps.join("\n")).toMatch(/no test-run evidence/);
		expect(gaps.join("\n")).toMatch(/no executed-test count/);
		expect(gaps.join("\n")).toMatch(/no engine-exit evidence/);
	});

	it("P2: dropped report rows are an incomplete census", () => {
		const gaps = v2RunEvidenceGaps({ testRun: GREEN, executedTestCount: 1, engineExitCode: 0, droppedMutants: 2 });
		expect(gaps).toEqual([expect.stringMatching(/incomplete census — 2 report row/)]);
	});

	it("P3: a non-zero engine exit and an unrecoverable (null) exit are distinct gaps", () => {
		const failed = v2RunEvidenceGaps({ testRun: GREEN, executedTestCount: 1, engineExitCode: 3 });
		const lost = v2RunEvidenceGaps({ testRun: GREEN, executedTestCount: 1, engineExitCode: null });
		expect(failed).toEqual([expect.stringMatching(/engine exited 3/)]);
		expect(lost).toEqual([expect.stringMatching(/engine exit unrecoverable/)]);
	});

	it("P4: zero executed tests is a gap even when the suite flag is green", () => {
		expect(executedTestEvidenceGap(0)).toMatch(/zero tests executed/);
		expect(v2RunEvidenceGaps({ testRun: GREEN, executedTestCount: 0, engineExitCode: 0 })).toHaveLength(1);
	});

	it("P5: caller-supplied gaps are carried through first", () => {
		const gaps = v2RunEvidenceGaps({ testRun: GREEN, executedTestCount: 1, engineExitCode: 0, evidenceGaps: ["partial shard"] });
		expect(gaps).toEqual(["partial shard"]);
	});
});

describe("v2RunEvidenceGaps — negative (must not fire)", () => {
	it("N1: complete evidence has no gaps", () => {
		expect(v2RunEvidenceGaps({ testRun: GREEN, executedTestCount: 1, engineExitCode: 0, droppedMutants: 0 })).toEqual([]);
	});

	it("N2: a positive executed-test count is not a gap", () => {
		expect(executedTestEvidenceGap(1)).toBeNull();
	});

	it("N3: runEvidenceGaps honors a caller that already waived the test-count gap", () => {
		expect(runEvidenceGaps({ testRun: GREEN, executedTestCount: 0, engineExitCode: 0 }, null)).toEqual([]);
	});
});
