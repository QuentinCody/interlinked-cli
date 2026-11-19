// Composite score rendering over a real (tiny) report: the score lines, the evidence axes and the short form.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCompositeScoreReport } from "../lib/metrics/composite-report.js";
import { renderCompositeScore, renderCompositeShort } from "./metrics-score-render.js";

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

describe("renderCompositeScore provenance", () => {
	it("prints the authored / generated / vendored line and names the file behind each maximum", () => {
		const root = mkdtempSync(join(tmpdir(), "metrics-render-prov-"));
		roots.push(root);
		mkdirSync(join(root, ".yarn/releases"), { recursive: true });
		writeFileSync(join(root, "index.js"), "export function twice(x) { return x * 2; }\n");
		writeFileSync(join(root, ".yarn/releases/yarn.cjs"), "function a(x) { if (x) { return 1; } return 2; }\n");
		writeFileSync(join(root, "made.js"), "export const first = 1;\n// @generated\nexport function made() { return 1; }\n");
		const text = renderCompositeScore(collectCompositeScoreReport(root));
		expect(text).toContain("authored 2 files (1 declare generated, still measured) · generated 0 · vendored 1");
		expect(text).toMatch(/cyclomatic .*max 1 at index\.js:1 twice/);
		expect(text).toContain("Declare generated, still measured (the file says so; the agent can write that header): 1");
		expect(text).toContain("  made.js (3 lines): line 2: @generated");
	});
});

describe("renderCompositeShort", () => {
	it("shows an unavailable slop score and rounds the observed burden to one decimal", () => {
		const text = renderCompositeShort({ ...report(), slopScore: null, observedScore: 12.345 });
		expect(text).toMatch(/^slop unavailable; observed 12\.3\/100;/);
	});

	it("is one line that says no model calls ran", () => {
		const text = renderCompositeShort(report());
		expect(text.split("\n")).toHaveLength(1);
		expect(text).toMatch(/no model calls$/);
	});
});
