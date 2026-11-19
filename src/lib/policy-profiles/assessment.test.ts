import { describe, expect, it } from "vitest";
import { assessMetricPolicies } from "./assessment.js";
import type { InventoryFile, MetricReading } from "../metrics/measurement-types.js";

const files: InventoryFile[] = ["src/a.ts", "src/b.ts"].map(path => ({ path, role: "product", language: "typescript", content: "", sha256: path }));
function reading(state: MetricReading["state"] = "measured", value: number | null = 12): MetricReading {
	return { id: "difficulty", state, value, numerator: null, denominator: null, score: 30, measuredEntities: 2, eligibleEntities: 2, evidenceIds: ["source"], limitations: [] };
}

describe("retained measurement policy assessment", () => {
	it("does not compare a hook line target against the AST terminal-line convention", () => {
		const metric = { ...reading(), id: "file.lines", value: 725 };
		const [result] = assessMetricPolicies([metric], { "file.lines": { mode: "warn", threshold: 725 } }, files);
		expect(result?.measurementState).toBe("unsupported");
		expect(result?.measurementContract).toBe('content.split("\\n").length');
		expect(result?.exceedsTarget).toBeNull();
		expect(result?.warning).toBe(false);
		expect(metric.value).toBe(725);
		expect(assessMetricPolicies([metric], {}, files)[0]?.measurementContract).toBe("Physical lines excluding the terminal empty segment");
	});
	it("keeps canonical function tokens separate from the AST reading", () => {
		const tokenReading = { ...reading(), id: "tokens", value: 120 };
		const result = assessMetricPolicies([tokenReading], { "function-tokens": { mode: "warn", threshold: 10 } }, files,
			{ canonicalThresholds: { "function-tokens": 500 } });
		expect(result.find(row => row.id === "tokens")?.reportingTarget).toBeNull();
		expect(result.find(row => row.id === "tokens")?.status).toBe("no-target");
		expect(result.find(row => row.id === "function-tokens")).toMatchObject({ measurementState: "unsupported", exceedsTarget: null, warning: false });
	});
	it.each(["report", "warn", "off"] as const)("applies %s without changing retained readings", mode => {
		const metric = reading(), before = JSON.stringify(metric);
		const [result] = assessMetricPolicies([metric], { difficulty: { mode, threshold: 10 } }, files);
		expect(result?.mode).toBe(mode);
		expect(result?.exceedsTarget).toBe(mode === "off" ? null : true);
		expect(result?.warning).toBe(mode === "warn");
		expect(JSON.stringify(metric)).toBe(before);
	});
	it.each(["missing", "stale", "inconclusive", "unsupported", "not-applicable"] as const)("retains %s evidence without a comparison verdict", state => {
		const [result] = assessMetricPolicies([reading(state)], { difficulty: { mode: "warn", threshold: 10 } }, files);
		expect(result?.measurementState).toBe(state);
		expect(result?.exceedsTarget).toBeNull();
		expect(result?.warning).toBe(false);
	});
	it("keeps absent targets and exact equality distinct", () => {
		expect(assessMetricPolicies([reading()], {}, files)[0]?.status).toBe("no-target");
		expect(assessMetricPolicies([reading()], { difficulty: { threshold: 12 } }, files)[0]?.exceedsTarget).toBe(false);
	});
	it("keeps not-applicable separate from unavailable evidence", () => {
		const [result] = assessMetricPolicies([reading("not-applicable", null)], { difficulty: { mode: "warn", threshold: 1 } }, files);
		expect(result?.status).toBe("not-applicable");
		expect(result?.exceedsTarget).toBeNull();
		expect(result?.warning).toBe(false);
	});
	it("does not relabel an aggregate as a subset measurement", () => {
		const [result] = assessMetricPolicies([reading()], { difficulty: { mode: "warn", threshold: 1, scope: { paths: ["src/a.ts"] } } }, files);
		expect(result?.status).toBe("scope-unmeasured");
		expect(result?.exceedsTarget).toBeNull();
		expect(result?.selectedFiles).toBe(1);
	});
	it("can compare a selector that retains the measured population", () => {
		const [result] = assessMetricPolicies([reading()], { difficulty: { threshold: 1, scope: { paths: ["src/**"], roles: ["product"] } } }, files);
		expect(result?.exceedsTarget).toBe(true);
	});
	it("downgrades requested blocking to explicit advisory report behavior", () => {
		const [result] = assessMetricPolicies([reading()], { difficulty: { mode: "block", threshold: 1 } }, files);
		expect(result?.mode).toBe("warn");
		expect(result?.requestedMode).toBe("block");
		expect(result?.issues.join(" ")).toContain("no project-report enforcement");
	});
});
