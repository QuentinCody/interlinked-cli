import { describe, expect, it } from "vitest";
import {
	churnEntropy,
	classifyCommitPurpose,
	type JitCommitInputs,
	percentileOf,
	scoreJitCommit,
} from "./jit-commit-score.js";

const base: JitCommitInputs = {
	linesAdded: 0,
	linesDeleted: 0,
	filesTouched: 0,
	hunks: 0,
	subsystems: 1,
	directories: 1,
	changeEntropy: 0,
	priorChanges: 0,
	priorAuthors: 0,
	priorFixes: 0,
	authorCommitsLong: 0,
	authorCommitsRecent: 0,
	purpose: { isFix: false, isSecurityFix: false, isRevert: false },
};

describe("scoreJitCommit — positive (must fire)", () => {
	it("P1: a larger diff scores higher than a smaller one", () => {
		const small = scoreJitCommit({ ...base, linesAdded: 5 });
		const large = scoreJitCommit({ ...base, linesAdded: 500, filesTouched: 12, hunks: 30 });
		expect(large.score).toBeGreaterThan(small.score);
		expect(large.contributions.size).toBeGreaterThan(small.contributions.size);
	});

	it("P2: scattering across subsystems adds diffusion; a single directory adds none", () => {
		const focused = scoreJitCommit({ ...base, subsystems: 1, directories: 1 });
		const scattered = scoreJitCommit({ ...base, subsystems: 4, directories: 9, changeEntropy: 2.5 });
		expect(focused.contributions.diffusion).toBe(0);
		expect(scattered.contributions.diffusion).toBeGreaterThan(0);
	});

	it("P3: turbulent file history and a fix purpose both raise the score", () => {
		const quiet = scoreJitCommit(base);
		const turbulent = scoreJitCommit({ ...base, priorChanges: 40, priorAuthors: 5, priorFixes: 8 });
		const fix = scoreJitCommit({ ...base, purpose: { isFix: true, isSecurityFix: true, isRevert: false } });
		expect(turbulent.score).toBeGreaterThan(quiet.score);
		expect(fix.contributions.purpose).toBe(0.5);
	});

	it("P4: author experience subtracts and a revert dampens", () => {
		const novice = scoreJitCommit({ ...base, linesAdded: 100 });
		const veteran = scoreJitCommit({ ...base, linesAdded: 100, authorCommitsLong: 300, authorCommitsRecent: 40 });
		expect(veteran.contributions.experience).toBeLessThan(0);
		expect(veteran.score).toBeLessThan(novice.score);
		const revert = scoreJitCommit({ ...base, purpose: { isFix: false, isSecurityFix: false, isRevert: true } });
		expect(revert.contributions.purpose).toBeLessThan(0);
	});
});

describe("scoreJitCommit — negative (must not fire)", () => {
	it("N1: the empty commit scores exactly zero with a version tag", () => {
		const s = scoreJitCommit(base);
		expect(s.score).toBe(0);
		expect(s.version).toBe(1);
	});

	it("N2: the score never goes negative even when experience dominates", () => {
		const s = scoreJitCommit({ ...base, authorCommitsLong: 10_000 });
		expect(s.score).toBe(0);
		expect(s.contributions.experience).toBeLessThan(0);
	});

	it("N3: a non-finite input throws instead of scoring silently", () => {
		expect(() => scoreJitCommit({ ...base, linesAdded: Number.NaN })).toThrow(/linesAdded/);
	});
});

describe("churnEntropy", () => {
	it("P1: even spread over n files approaches log2(n)", () => {
		expect(churnEntropy([10, 10, 10, 10])).toBeCloseTo(2, 10);
	});
	it("N1: one file, or no churn, is zero", () => {
		expect(churnEntropy([42])).toBe(0);
		expect(churnEntropy([0, 0])).toBe(0);
		expect(churnEntropy([])).toBe(0);
	});
});

describe("classifyCommitPurpose", () => {
	it("P1: fix, security and revert subjects classify", () => {
		expect(classifyCommitPurpose("fix(gate): NaN guard")).toMatchObject({ isFix: true, isSecurityFix: false });
		expect(classifyCommitPurpose("harden against CVE-2026-1234 injection")).toMatchObject({ isFix: true, isSecurityFix: true });
		expect(classifyCommitPurpose('Revert "feat: thing"')).toMatchObject({ isRevert: true });
	});
	it("N1: a feature subject classifies as none of them", () => {
		expect(classifyCommitPurpose("feat(metrics): jit commit score")).toEqual({ isFix: false, isSecurityFix: false, isRevert: false });
	});
});

describe("percentileOf", () => {
	it("P1: ranks within the population by strict-below share", () => {
		expect(percentileOf(5, [1, 2, 3, 4, 6, 7, 8, 9, 10, 11])).toBe(40);
		expect(percentileOf(100, [1, 2, 3])).toBe(100);
	});
	it("N1: an empty population is no ruler", () => {
		expect(percentileOf(5, [])).toBeNull();
	});
});
