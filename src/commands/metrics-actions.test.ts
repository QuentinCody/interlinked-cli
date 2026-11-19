import { describe, expect, it } from "vitest";
import { metricActions, renderMetricActions } from "./metrics-actions.js";

describe("metrics action projection", () => {
	it("keeps all oversized functions independently of hotspot limits and separates missing evidence", () => {
		const actions = metricActions({
			functions: Array.from({ length: 30 }, (_, i) => ({ file: "index.ts", name: `f${i}`, line: i + 1, cyclomatic: 26, coveragePct: null, crap: null })),
			files: [{ file: "index.ts", functions: 30, linePct: null, maxCyclomatic: 26, maxCrap: null, companion: false, overGate: 0, sourceSha256: "snapshot" }],
			caps: { cyclomatic: 25, crap: 30, cyclomaticReview: 15, minCoveragePct: 60 },
		});
		expect(actions.actions.filter(row => row.classification === "measurement")).toHaveLength(30);
		expect(actions.actions.filter(row => row.classification === "evidence_gap")).toHaveLength(2);
		expect(actions.actions.every(row => row.enforcement === "report")).toBe(true);
		expect(actions.actions.every(row => row.freshness === "snapshot_bound")).toBe(true);
		expect(actions.modelCalls).toBe(0);
	});

	it("does not invent CRAP scores or treat a test companion as proof of behavioral coverage", () => {
		const result = metricActions({ functions: [], files: [{ file: "index.js", functions: 0, linePct: null, maxCyclomatic: 0, maxCrap: null, companion: true, overGate: 0 }], caps: { cyclomatic: 25, crap: 30, cyclomaticReview: 15, minCoveragePct: 60 } });
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({ classification: "evidence_gap", freshness: "unknown" });
		expect(result.actions[0]?.evidence[0]?.check).toBe("coverage");
		expect(renderMetricActions(result, false).join("\n")).toContain("1 local action");
		expect(renderMetricActions(result, true).join("\n")).toContain("Generate coverage");
	});

	it("turns unsupported or unreadable scope into explicit investigation actions", () => {
		const result = metricActions({ functions: [], files: [], caps: { cyclomatic: 25, crap: 30, cyclomaticReview: 15, minCoveragePct: 60 }, notMeasured: [{ file: "Main.java", reason: "No complexity adapter for java" }] });
		expect(result.actions[0]?.classification).toBe("evidence_gap");
		expect(renderMetricActions(result, true).join("\n")).toContain("No complexity adapter for java");
	});
});
