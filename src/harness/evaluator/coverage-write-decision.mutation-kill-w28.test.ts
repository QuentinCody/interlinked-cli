// Mutation-kill pass (wave 28) for coverage-write-decision.ts. All internal
// helpers (coveredFraction, coveredFractionByLine, uncoveredAddedLine,
// uncoveredAddedFunction, blockForUncovered*, sampleUncoveredLines,
// blockForDrop, blockForFloor, dropVerdict, perFileRegressionBlock) are
// unexported — exercised exclusively through the public decideFromCoverage
// entry point, matching the companion file's convention.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { writeFileCoverageBaseline } from "../coverage-obligation-ledger.js";
import { resetMetricCapsCache } from "../metric-caps.js";
import { blockForRedBar, decideFromCoverage, failingTestPhrase } from "./coverage-write-decision.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-decision-w28-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function fnCov(over: Partial<PerFileCoverage["functions"][number]> = {}): PerFileCoverage["functions"][number] {
	return { name: "f", line: 1, endLine: 3, hits: 2, statement_pct: 100, ...over };
}

function setFloor(pct: number): void {
	mkdirSync(join(root, ".interlinked"), { recursive: true });
	writeFileSync(join(root, ".interlinked", "metric-caps.json"), JSON.stringify({ min_coverage: pct }));
	resetMetricCapsCache();
}

// test-contract: boundary — coveredFraction's `functions.length === 0` guard (mutant ad60a1aad4fd921c)
it("coveredFraction reports fully-covered (1) for a file with zero functions", () => {
	const cov: PerFileCoverage = { filePath: "src/empty.ts", mtime: 0, functions: [] };
	const out: { now?: number } = {};
	expect(decideFromCoverage(root, "src/empty.ts", cov, new Set([1]), out)).toBeNull();
	expect(out.now).toBe(1);
	resetMetricCapsCache();
});

// test-contract: boundary — coveredFractionByLine's `total === 0` guard (mutant 652fea0db5e1788a)
it("coveredFractionByLine reports fully-covered (1) when covered+uncovered line sets are both empty", () => {
	const cov: PerFileCoverage = {
		filePath: "src/empty.py",
		mtime: 0,
		functions: [],
		coveredLines: new Set(),
		uncoveredLines: new Set(),
	};
	const out: { now?: number } = {};
	expect(decideFromCoverage(root, "src/empty.py", cov, new Set([1]), out)).toBeNull();
	expect(out.now).toBe(1);
});

describe("uncoveredAddedLine — reports the true minimum, not the last-iterated line", () => {
	// test-contract: boundary — uncoveredAddedLine's `lowest === null || ln < lowest` comparison (mutant bc8ef4336434a950)
	it("picks line 3 over insertion-order line 5/7, and carries the full per-line block shape", () => {
		const cov: PerFileCoverage = {
			filePath: "src/m.py",
			mtime: 0,
			functions: [],
			coveredLines: new Set(),
			uncoveredLines: new Set([5, 3, 7]), // insertion order NOT sorted
		};
		const d = decideFromCoverage(root, "src/m.py", cov, new Set([5, 3, 7]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("line 3");
		expect(d?.reason).not.toContain("line 5");
		expect(d?.reason).not.toContain("line 7");
		// test-contract: kills 73bae7e9ef6f8e90 / 46b5434cd911af0e / e415c65e4d86d7c8 / eeee57ba837a9b47
		expect(d?.reason).toContain("line, then retry.");
		expect(d?.rule_id).toBe("per-edit-coverage");
		expect(d?.severity).toBe("medium");
		expect(d?.category).toBe("coverage");
	});
});

describe("uncoveredAddedFunction — OR semantics + individual comparisons", () => {
	// test-contract: boundary — uncoveredAddedFunction's `fn.hits === 0` term and its OR with
	// statement_pct (mutants 184599b1cc2f7741, f3bd4b36760e7d3c)
	it("fires when hits is 0 even though statement_pct is nonzero, with the full block shape", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ hits: 0, statement_pct: 50 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([1]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("src/m.ts line 1");
		// test-contract: kills 3c6635220945f419 / c140f70e11c862d8 / c5d8a01725041f05
		expect(d?.reason).toContain("Add a test that exercises this code, then retry.");
		expect(d?.severity).toBe("medium");
		expect(d?.category).toBe("coverage");
	});

	// test-contract: boundary — uncoveredAddedFunction's `fn.statement_pct === 0` term (mutant 47826006dc578dd9)
	it("fires when statement_pct is 0 even though hits is nonzero", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ hits: 5, statement_pct: 0 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([1]), {});
		expect(d?.decision).toBe("block");
	});
});

// test-contract: public-api — failingTestPhrase's `failingTests.length === 0` guard (mutant 91ad9b010c465aed)
it("failingTestPhrase treats a defined-but-empty array the same as undefined", () => {
	expect(failingTestPhrase([])).toBe("one or more tests are failing");
});

// test-contract: public-api — blockForRedBar's exported reason/severity/category literals
// (mutants 88047189fd811918, d015f383e02d867a, 647daadb07f045b2)
it("blockForRedBar carries the exact strict-TDD sentence, severity, and category", () => {
	const d = blockForRedBar("src/m.ts", ["t1"]);
	expect(d.reason).toContain("Strict TDD: an edit may not save a transiently-red state.");
	expect(d.severity).toBe("medium");
	expect(d.category).toBe("coverage");
});

describe("sampleUncoveredLines + blockForDrop — the drop message body", () => {
	// test-contract: public-api — sampleUncoveredLines' empty-return literal and blockForDrop's
	// full reason/rule_id/category/severity (mutants 9440231c9b73ad69, 998b3ad9ab46ea9a,
	// 17a78fcf84ee8970, fa10881e302526b5, f7c6c84ad9574219, cd758b34be0b8738, 09ad4dbaf3444a13,
	// 2a1265bf019536a4, 2224cb93597cee3d)
	it("omits the uncovered-lines parenthetical when the report carries no per-line data", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1);
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 50 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).not.toMatch(/uncovered now/);
		expect(d?.reason).toContain("The changed code itself passed the added-coverage check");
		expect(d?.reason).toContain("test(s), then retry.");
		expect(d?.rule_id).toBe("per-edit-coverage");
		expect(d?.category).toBe("coverage");
		expect(d?.severity).toBe("medium");
	});

	// test-contract: boundary — sampleUncoveredLines' `.slice(0, UNCOVERED_SAMPLE_MAX)` cap (mutant 7806dde232150718)
	it("caps the named uncovered-line sample at 3, even when 5 lines are uncovered", () => {
		writeFileCoverageBaseline(root, "src/m.py", 1);
		const cov: PerFileCoverage = {
			filePath: "src/m.py",
			mtime: 0,
			functions: [],
			coveredLines: new Set([100, 101]),
			uncoveredLines: new Set([10, 20, 30, 40, 50]),
		};
		// editedLines touches only a covered line, so the uncovered-added-line
		// check falls through to the drop check instead of blocking early.
		const d = decideFromCoverage(root, "src/m.py", cov, new Set([100]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("line 10, line 20, line 30");
		expect(d?.reason).not.toContain("line 40");
		expect(d?.reason).not.toContain("line 50");
	});
});

describe("blockForFloor — message body", () => {
	// test-contract: public-api — blockForFloor's `Math.round(now * 100)` arithmetic and full
	// reason/rule_id/category/severity (mutants 509bdcedaeb0f494, 0f0c192d4fe18102,
	// c1b322db32b026c8, 87272d62273382eb, bc57c97069a17e8e, 55e4db4e40e1ddb4)
	it("renders the actual rounded percent and the full suggestion text", () => {
		setFloor(90);
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 80 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("80%");
		expect(d?.reason).toContain("Add tests to reach it, or change the floor:");
		expect(d?.reason).toContain("`interlinked caps set coverage <pct>`.");
		expect(d?.rule_id).toBe("per-edit-coverage");
		expect(d?.category).toBe("coverage");
		expect(d?.severity).toBe("medium");
		resetMetricCapsCache();
	});
});

// test-contract: boundary — dropVerdict's `<` vs `<=` at the exact epsilon boundary (mutant a550884dc7775a29)
it("dropVerdict tolerates landing exactly at the drop-epsilon boundary (does not block)", () => {
	writeFileCoverageBaseline(root, "src/m.ts", 1);
	const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 100 })] };
	// dropEpsilon=0: now(1) < entry.fraction(1) - 0 = 1 is false -> allow.
	// The `<=` mutant makes 1 <= 1 true -> incorrectly blocks.
	const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {}, undefined, 0);
	expect(d).toBeNull();
});

describe("perFileRegressionBlock — drop-vs-floor sequencing and floor arithmetic", () => {
	// test-contract: invariant — perFileRegressionBlock must still run the floor check after a
	// no-drop baseline comparison, not short-circuit (mutant 93235c1b8df9a6ab: `if (drop) return drop`
	// -> `if (true) return drop`, returning null immediately and skipping the floor check)
	it("still evaluates the floor check when a baseline entry exists but produced no drop", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 0.5);
		setFloor(60);
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 50 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("below the");
		resetMetricCapsCache();
	});

	// test-contract: boundary — perFileRegressionBlock's floor-clause conjunction and arithmetic
	// (mutants ee9dc79f17238084 `&&`->`||`, c3c2a9d625d0dee2 `now < floor/100`->true,
	// 8df1e0c17d4ecd72 `floor / 100`->`floor * 100`) — all three would incorrectly block here.
	it("allows coverage well above a low floor (no baseline entry at all)", () => {
		setFloor(1);
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 50 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d).toBeNull();
		resetMetricCapsCache();
	});

	// test-contract: boundary — perFileRegressionBlock's `now < floor / 100` vs `<=` at the exact
	// floor boundary (mutant 933dccb8c74c0044)
	it("allows coverage that lands EXACTLY on the floor (boundary is inclusive of pass)", () => {
		setFloor(90);
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 90 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d).toBeNull();
		resetMetricCapsCache();
	});
});
