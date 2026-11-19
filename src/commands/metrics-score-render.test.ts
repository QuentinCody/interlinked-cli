// Composite score rendering over a real (tiny) report: the score lines, the evidence axes and the short form.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCompositeScoreReport } from "../lib/metrics/composite-report.js";
import { formatMetricScore, renderCompositeScore, renderCompositeShort } from "./metrics-score-render.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function report() {
	const root = mkdtempSync(join(tmpdir(), "metrics-render-"));
	roots.push(root);
	writeFileSync(join(root, "index.js"), "export function twice(x) { return x * 2; }\n");
	return collectCompositeScoreReport(root);
}

describe("formatMetricScore", () => {
	it("prints one decimal out of 100, or unavailable", () => {
		expect(formatMetricScore(12.345)).toBe("12.3/100");
		expect(formatMetricScore(null)).toBe("unavailable");
	});
});

describe("renderCompositeScore", () => {
	it("prints the slop line, every metric, the evidence axes and the profile", () => {
		const r = report();
		const text = renderCompositeScore(r);
		expect(text).toMatch(/^Slop score: /);
		for (const metric of r.metrics) expect(text).toContain(metric.id);
		expect(text).toContain("Evidence axes (lower is better; a grouping, not a second score):");
		expect(text).toMatch(/Stability .*coverage, mutation, test_integrity/);
		expect(text).toMatch(/Correctness .*correctness, contracts/);
		expect(text).toContain(`Profile: ${r.profile.id}`);
	});
});

describe("renderCompositeShort", () => {
	it("is one line that says no model calls ran", () => {
		const text = renderCompositeShort(report());
		expect(text.split("\n")).toHaveLength(1);
		expect(text).toMatch(/no model calls$/);
	});
});
