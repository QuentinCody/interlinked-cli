import { describe, expect, it } from "vitest";
import { renderJitRank } from "./metrics-jit.js";
import type { JitRank } from "../harness/jit-commit-rank.js";

const rank: JitRank = {
	target: "HEAD",
	score: 1.234,
	percentile: 72,
	population: 150,
	contributions: { size: 0.9, diffusion: 0.3, history: 0.2, experience: -0.4, purpose: 0.25 },
	inputs: {
		linesAdded: 40, linesDeleted: 4, filesTouched: 3, hunks: 5, subsystems: 2, directories: 3,
		changeEntropy: 1.2, priorChanges: 6, priorAuthors: 1, priorFixes: 2,
		authorCommitsLong: 30, authorCommitsRecent: 10,
		purpose: { isFix: true, isSecurityFix: false, isRevert: false },
	},
	version: 1,
};

describe("renderJitRank", () => {
	it("P1: the short line carries score, percentile and population", () => {
		expect(renderJitRank(rank).short()).toBe("jit HEAD: score 1.23 · p72 of 150 commits");
	});
	it("P2: the normal render lists every signed group and the input record", () => {
		const text = renderJitRank(rank).normal();
		expect(text).toContain("experience  -0.40");
		expect(text).toContain("purpose     +0.25");
		expect(text).toContain("fix");
		expect(text).toContain("40 added / 4 deleted");
	});
	it("N1: with no ruler the percentile prints as unranked, never as 0", () => {
		const r = renderJitRank({ ...rank, percentile: null, population: 0 });
		expect(r.short()).toBe("jit HEAD: score 1.23 · unranked (no history)");
		expect(r.json()).toMatchObject({ percentile: null, population: 0 });
	});
});
