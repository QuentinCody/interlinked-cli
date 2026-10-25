// Direct companion for the extracted per-edit coverage decision helpers. The
// guard's own suite exercises these end-to-end; this file pins the pure
// decision surface in isolation (per-function vs per-line shape, baseline
// drop, red-bar message rendering).
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
	root = mkdtempSync(join(tmpdir(), "cov-decision-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function fnCov(over: Partial<PerFileCoverage["functions"][number]> = {}): PerFileCoverage["functions"][number] {
	return { name: "f", line: 1, endLine: 3, hits: 2, statement_pct: 100, ...over };
}

it("uses the provided per-line evidence when its counterpart set is absent", () => {
	const out: { now?: number } = {};
	const coveredOnly: PerFileCoverage = { filePath: "src/m.py", mtime: 0, functions: [], coveredLines: new Set([3]) };
	expect(decideFromCoverage(root, "src/m.py", coveredOnly, new Set([3]), out)).toBeNull();
	expect(out.now).toBe(1);
	const uncoveredOnly: PerFileCoverage = { filePath: "src/m.py", mtime: 0, functions: [], uncoveredLines: new Set([3]) };
	const decision = decideFromCoverage(root, "src/m.py", uncoveredOnly, new Set([3]), {});
	expect(decision?.decision).toBe("block");
	expect(decision?.reason).toContain("line 3");
});

describe("decideFromCoverage — per-function (istanbul) shape", () => {
	it("blocks on an uncovered added function, naming file and line", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ hits: 0, statement_pct: 0 })] };
		const out: { now?: number } = {};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([1]), out);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("src/m.ts line 1");
		expect(out.now).toBeUndefined(); // a block never hands back a fraction
	});

	it("allows a covered function and hands back the fraction WITHOUT persisting it", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov()] };
		const out: { now?: number } = {};
		expect(decideFromCoverage(root, "src/m.ts", cov, new Set([1]), out)).toBeNull();
		expect(out.now).toBe(1);
	});

	it("blocks a coverage DROP versus the persisted baseline", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1);
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			// covered overall but at 50% → below the 100% baseline
			functions: [fnCov({ statement_pct: 50 })],
		};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/drops src\/m\.ts coverage/);
	});

	it("tolerates a sub-epsilon wobble that holds at the baseline (the 100%→100% false-block fix)", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1);
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			// 99.7% — an affected-subset/measurement wobble that still rounds to 100%.
			functions: [fnCov({ statement_pct: 99.7 })],
		};
		const out: { now?: number } = {};
		expect(decideFromCoverage(root, "src/m.ts", cov, new Set([99]), out)).toBeNull();
	});

	it("still blocks a real drop beyond the noise tolerance", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1);
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			functions: [fnCov({ statement_pct: 99 })], // 1% drop > epsilon
		};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
	});

	it("BLOCKS fail-closed when a narrower scope measures below the FULL-suite high-water (red-team 2026-10-21 round 2)", () => {
		// 100% pinned by a full-suite run; today's narrower scope reaches 98.7%.
		// This was the 2026-07-24 bio re-anchor exemption; the red-team churn
		// sequence (churn to full, hold, narrow, regress) turned it into an
		// unbounded downward re-key, so a scoped value below the full-suite
		// high-water now needs a full-suite measurement and blocks without one.
		writeFileCoverageBaseline(root, "src/m.ts", 1, "full");
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			functions: [fnCov({ statement_pct: 98.7 })],
		};
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), out, "scoped:narrowBBBBBB");
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("full-suite high-water 100.0% to 98.7%");
		expect(d?.reason).toContain("interlinked coverage check");
		expect(d?.rule_id).toBe("per-edit-coverage");
		// A block hands back nothing: no fraction to persist, no re-anchor signal.
		expect(out).toStrictEqual({});
	});

	it("BLOCKS a drop against a scoped baseline measured under a DIFFERENT scoped test set (red-team 2026-10-21)", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1, "scoped:broadAAAAAA");
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			functions: [fnCov({ statement_pct: 66.7 })],
		};
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), out, "scoped:narrowBBBBBB");
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("scoped:broadAAAAAA → scoped:narrowBBBBBB");
		expect(d?.rule_id).toBe("per-edit-coverage");
		expect(out).toStrictEqual({});
	});

	it("re-anchors UPWARD across scoped test sets (a higher measurement is never a loosening)", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 0.5, "scoped:broadAAAAAA");
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 90 })] };
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		expect(decideFromCoverage(root, "src/m.ts", cov, new Set([99]), out, "scoped:narrowBBBBBB")).toBeNull();
		// 0.5, not 1: this fixture's prior is 0.5; the old 1 → 0.987 downward re-anchor now blocks (test above).
		expect(out.scopeChanged).toEqual({ priorFraction: 0.5 });
		expect(out.now).toBeCloseTo(0.9, 3);
	});

	it("still blocks a real drop when the scope MATCHES the baseline's scope", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1, "scoped:sameSCOPE01");
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 90 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {}, "scoped:sameSCOPE01");
		expect(d?.decision).toBe("block");
	});

	it("reads a legacy scope-less baseline as a full-suite high-water once a scope id is supplied", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1); // legacy bare number ≡ {f: 1, scope: full, hw: 1}
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 95 })] };
		const out: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), out, "scoped:anyNEWSCOPE");
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("full-suite high-water 100.0% to 95.0%");
		expect(d?.rule_id).toBe("per-edit-coverage");
		expect(out).toStrictEqual({});
		// An equal measurement under the new scope still re-anchors (upward/equal never needs the full route).
		const held: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 100 })] };
		const heldOut: { now?: number; scopeChanged?: { priorFraction: number } } = {};
		expect(decideFromCoverage(root, "src/m.ts", held, new Set([99]), heldOut, "scoped:anyNEWSCOPE")).toBeNull();
		expect(heldOut).toStrictEqual({ now: 1, scopeChanged: { priorFraction: 1 } });
	});

	it("names uncovered lines and unrounded percentages in a same-scope drop block", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1, "scoped:sameSCOPE01");
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			functions: [fnCov({ statement_pct: 100 })],
			coveredLines: new Set([1, 2]),
			uncoveredLines: new Set([431, 12, 500]),
		};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([1]), {}, "scoped:sameSCOPE01");
		expect(d?.decision).toBe("block");
		// per-line shape wins the fraction: 2 covered / 5 total = 40.0%
		expect(d?.reason).toContain("40.0%");
		expect(d?.reason).toContain("100.0%");
		expect(d?.reason).toContain("line 12, line 431, line 500");
		expect(d?.reason).not.toMatch(/\b40%\b/); // never the rounded form
	});

	it("blocks a file below the configured min_coverage floor", () => {
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, ".interlinked", "metric-caps.json"), JSON.stringify({ min_coverage: 90 }));
		resetMetricCapsCache();
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 80 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("below the");
		resetMetricCapsCache();
	});

	it("allows below 100% when no floor is set (floor defaults to 0 = off)", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 80 })] };
		expect(decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {})).toBeNull();
	});
});

describe("decideFromCoverage — per-line (coverage.py) shape", () => {
	it("blocks on an uncovered ADDED line (line-precise)", () => {
		const cov: PerFileCoverage = {
			filePath: "src/m.py",
			mtime: 0,
			functions: [],
			coveredLines: new Set([1, 2]),
			uncoveredLines: new Set([3]),
		};
		const d = decideFromCoverage(root, "src/m.py", cov, new Set([3]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("line 3");
	});

	it("ignores a pre-existing uncovered line the edit did not touch", () => {
		const cov: PerFileCoverage = {
			filePath: "src/m.py",
			mtime: 0,
			functions: [],
			coveredLines: new Set([1, 2]),
			uncoveredLines: new Set([3]),
		};
		const out: { now?: number } = {};
		expect(decideFromCoverage(root, "src/m.py", cov, new Set([1]), out)).toBeNull();
		expect(out.now).toBeCloseTo(2 / 3);
	});
});

describe("red-bar message rendering", () => {
	it("failingTestPhrase lists up to three tests with an ellipsis", () => {
		expect(failingTestPhrase(undefined)).toBe("one or more tests are failing");
		expect(failingTestPhrase(["a"])).toBe("failing test(s): a");
		expect(failingTestPhrase(["a", "b", "c", "d"])).toBe("failing test(s): a, b, c, …");
	});

	it("blockForRedBar names the edited file and carries the gate rule id", () => {
		const d = blockForRedBar("src/m.ts", ["t1"]);
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("src/m.ts");
		expect(d.reason).toContain("t1");
		expect(d.rule_id).toBe("per-edit-coverage");
	});

	it("blockForRedBar attaches failing test FILES as structured evidence (debt-mode's cone seed)", () => {
		const d = blockForRedBar("src/m.ts", ["t1"], ["lib/counts.test.ts"]);
		expect(d.failing_test_files).toEqual(["lib/counts.test.ts"]);
	});

	it("blockForRedBar keeps the field absent when no files parsed (exactOptionalPropertyTypes)", () => {
		expect("failing_test_files" in blockForRedBar("src/m.ts", ["t1"])).toBe(false);
		expect("failing_test_files" in blockForRedBar("src/m.ts", ["t1"], [])).toBe(false);
	});
});
