import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectCompositeScoreReport } from "./composite-report.js";
import { explainCompositeMetric } from "./composite-explain.js";
import { METRIC_CATALOG } from "./catalog-metrics.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("collects every metric, explains weights and preserves explicit evidence gaps", () => {
    const root = mkdtempSync(join(tmpdir(), "metrics-composite-")); roots.push(root);
    writeFileSync(join(root, "index.js"), "export function twice(x) { return x * 2; }\n");
    const report = collectCompositeScoreReport(root);
    expect(report.metrics.map(row => row.id).sort()).toEqual(METRIC_CATALOG.map(row => row.id).sort());
    expect(report.modelCalls).toBe(0);
    expect(report.rankingEligible).toBe(false);
    expect(report.rankingBlockers).toContain("mutation.survivors: missing");
    expect(explainCompositeMetric(report, "tokens").groups[0]?.weight).toBe(20);
    expect(explainCompositeMetric(report, "coverage.crap").groups).toEqual([]);
});

it("never presents unsupported product source as completely measured", () => {
    const root = mkdtempSync(join(tmpdir(), "metrics-unsupported-")); roots.push(root);
    writeFileSync(join(root, "index.js"), "export function value() { return 1; }\n");
    writeFileSync(join(root, "hidden.py"), "def hidden(): return 1\n");
    const report = collectCompositeScoreReport(root);
    expect(report.scope.notMeasured.some(row => row.path === "hidden.py")).toBe(true);
    expect(report.slopScore).toBeNull();
});
