// Mutation-directed companion for evaluate-evidence.ts (kill-proof census
// 2026-11-05). Fault: `!Number.isSafeInteger(count) ||` dropped from the
// executed-test gap, so a NaN, fractional or infinite executed-test count no
// longer produces an evidence gap and a malformed runner count can certify a
// run clean.
import { describe, expect, it } from "vitest";
import { executedTestEvidenceGap, v2RunEvidenceGaps } from "./evaluate-evidence.js";

const GREEN = { overlayGreen: true, redWitnessSatisfied: null };

describe("executedTestEvidenceGap — a non-integer count is not evidence", () => {
	// test-contract: invariant - NaN, a fraction and Infinity are not a positive integer count of executed tests, so each is an evidence gap
	it("reports NaN, fractional and infinite counts as gaps", () => {
		for (const [count, shown] of [[Number.NaN, "NaN"], [2.5, "2.5"], [Number.POSITIVE_INFINITY, "Infinity"]] as const) {
			const gap = executedTestEvidenceGap(count);
			expect(gap).not.toBeNull();
			expect(gap).toContain(`executed-test count was ${shown}`);
		}
	});

	// test-contract: bug - an otherwise complete green run whose executed-test count is NaN must not read as sufficient evidence
	it("keeps a green run with a NaN executed-test count from certifying clean", () => {
		const gaps = v2RunEvidenceGaps({ testRun: GREEN, executedTestCount: Number.NaN, engineExitCode: 0 });
		expect(gaps).toEqual([expect.stringMatching(/executed-test count was NaN/)]);
	});
});
