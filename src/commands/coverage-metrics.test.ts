import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COVERAGE_METRICS } from "../harness/coverage-metric-names.js";
import type { CoverageSummary } from "../harness/coverage-ratchet.js";
import {
	type CoverageMetricsReport,
	coverageMetricsCommand,
	renderCoverageMetrics,
	summarizeCoverageMetrics,
} from "./coverage-metrics.js";

function entry(pcts: Partial<Record<(typeof COVERAGE_METRICS)[number], number>>): NonNullable<CoverageSummary[string]> {
	const out: NonNullable<CoverageSummary[string]> = {};
	for (const metric of COVERAGE_METRICS) {
		const pct = pcts[metric];
		if (pct !== undefined) out[metric] = { pct };
	}
	return out;
}

const SUMMARY: CoverageSummary = {
	total: entry({ lines: 1, statements: 1, functions: 1, branches: 1 }),
	"src/a.ts": entry({ lines: 100, statements: 100, functions: 100, branches: 100 }),
	"src/b.ts": entry({ lines: 100, statements: 100, functions: 50, branches: 80 }),
	"src/c.ts": entry({ lines: 95, statements: 95, functions: 100, branches: 60 }),
	"src/d.ts": entry({ lines: 100, statements: 100, functions: 100 }), // no branches (LCOV-like gap)
};

describe("summarizeCoverageMetrics — positive (must fire)", () => {
	it("P1: reports one row per metric with measured / at-100 / under-threshold counts, percentiles, and the lowest files", () => {
		const rows = summarizeCoverageMetrics(SUMMARY, { metrics: COVERAGE_METRICS, under: 90, top: 2 });
		expect(rows.map((r) => r.metric)).toEqual([...COVERAGE_METRICS]);
		const branches = rows.find((r) => r.metric === "branches");
		expect(branches).toMatchObject({ measured: 3, unmeasured: 1, at_100: 1, under_threshold: 2, p50: 80 });
		expect(branches?.lowest).toEqual([
			{ file: "src/c.ts", pct: 60 },
			{ file: "src/b.ts", pct: 80 },
		]);
		const functions = rows.find((r) => r.metric === "functions");
		expect(functions).toMatchObject({ measured: 4, at_100: 3, under_threshold: 1 });
		expect(functions?.lowest).toEqual([{ file: "src/b.ts", pct: 50 }, { file: "src/a.ts", pct: 100 }]);
	});

	it("P2: narrows to the requested metrics only", () => {
		const rows = summarizeCoverageMetrics(SUMMARY, { metrics: ["functions"], under: 90, top: 5 });
		expect(rows.map((r) => r.metric)).toEqual(["functions"]);
	});

	it("P3: renders a table row per metric and names the lowest files", () => {
		const report: CoverageMetricsReport = {
			report: "coverage/coverage-summary.json",
			files: 4,
			threshold: 90,
			partial: null,
			metrics: summarizeCoverageMetrics(SUMMARY, { metrics: COVERAGE_METRICS, under: 90, top: 1 }),
		};
		const text = renderCoverageMetrics(report);
		expect(text).toContain("branches");
		expect(text).toContain("src/c.ts");
		expect(text).toContain("under 90%");
	});
});

describe("summarizeCoverageMetrics — negative (must not fire)", () => {
	it("N1: a metric absent from every entry yields an empty, non-throwing row (LCOV carries no statements)", () => {
		const noStatements: CoverageSummary = {
			"src/a.ts": entry({ lines: 100, functions: 100, branches: 100 }),
		};
		const [row] = summarizeCoverageMetrics(noStatements, { metrics: ["statements"], under: 90, top: 3 });
		expect(row).toMatchObject({ metric: "statements", measured: 0, unmeasured: 1, at_100: 0, under_threshold: 0, lowest: [] });
	});

	it("N2: the synthetic `total` bucket is never counted as a file", () => {
		const [row] = summarizeCoverageMetrics(SUMMARY, { metrics: ["lines"], under: 90, top: 10 });
		expect(row?.measured).toBe(4);
		expect(row?.lowest.some((l) => l.file === "total")).toBe(false);
	});
});

describe("coverageMetricsCommand", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cov-metrics-"));
		mkdirSync(join(root, "coverage"), { recursive: true });
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, "coverage", "coverage-summary.json"), JSON.stringify(SUMMARY));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("P4: --json emits every metric row for the merged report", async () => {
		const out: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			out.push(args.map(String).join(" "));
		});
		await coverageMetricsCommand({ cwd: root, json: true, under: "90", top: "3" });
		const parsed: unknown = JSON.parse(out.join(""));
		expect(parsed).toMatchObject({ files: 4, threshold: 90, partial: null });
		// SAFETY: the shape was just pinned by toMatchObject on the same value; the cast only names it.
		const metrics = (parsed as CoverageMetricsReport).metrics;
		expect(metrics.map((m) => m.metric)).toEqual([...COVERAGE_METRICS]);
		expect(process.exitCode).toBeUndefined();
	});

	it("N3: an unknown --metric is refused with exit 1 and no report", async () => {
		const err: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			err.push(args.map(String).join(" "));
		});
		await coverageMetricsCommand({ cwd: root, metric: "mutants" });
		expect(err.join("")).toContain("mutants");
		expect(process.exitCode).toBe(1);
	});
});
