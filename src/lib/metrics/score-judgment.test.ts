import { describe, expect, it } from "vitest";
import type { MetricReading } from "./measurement-types.js";
import { METRIC_JUDGES, REACH_ADVISORY_PERCENT, DISCONNECTED_ADVISORY_PERCENT, judgeWholeTreeMetrics } from "./score-judgment.js";

function reading(id: string, value: number | null, state: MetricReading["state"] = "measured", numerator = 1, denominator = 10): MetricReading {
	return { id, state, value, numerator, denominator, score: null, measuredEntities: denominator, eligibleEntities: denominator, evidenceIds: [], limitations: [] };
}

describe("judgeWholeTreeMetrics", () => {
	it("P1: a measured disconnected share at or over the limit is an advisory", () => {
		const result = judgeWholeTreeMetrics([reading("redundancy.disconnected", DISCONNECTED_ADVISORY_PERCENT)]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ metric: "redundancy.disconnected", level: "advisory", judge: "score_judgment" });
	});
	it("P2: a measured reach share at or over the limit is an advisory", () => {
		expect(judgeWholeTreeMetrics([reading("architecture.reach", REACH_ADVISORY_PERCENT)])[0]).toMatchObject({ metric: "architecture.reach", level: "advisory" });
	});
	it("P3: any failed declared contract is a warning", () => {
		const result = judgeWholeTreeMetrics([reading("contracts.findings", 25, "measured", 1, 4)]);
		expect(result[0]).toMatchObject({ metric: "contracts.findings", level: "warning" });
		expect(result[0]?.message).toContain("1 of 4");
	});
	it("N1: values under the limits are not judged as findings", () => {
		const result = judgeWholeTreeMetrics([reading("redundancy.disconnected", 1), reading("architecture.reach", 10), reading("contracts.findings", 0, "measured", 0, 4)]);
		expect(result).toEqual([]);
	});
	it("N2: an inconclusive reading is reported as not judged, with its reason, never as a finding", () => {
		const inconclusive = { ...reading("redundancy.disconnected", 93, "inconclusive"), limitations: ["12 imports could not be resolved; graph scope is incomplete."] };
		const result = judgeWholeTreeMetrics([inconclusive]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ metric: "redundancy.disconnected", level: "not-judged" });
		expect(result[0]?.message).toContain("could not be resolved");
	});
	it("N3: a reading with no contracts declared (not-applicable) produces nothing", () => {
		expect(judgeWholeTreeMetrics([reading("contracts.findings", null, "not-applicable", 0, 0)])).toEqual([]);
	});
	it("N4: the six unjudged metrics each name a judge", () => {
		expect(Object.keys(METRIC_JUDGES).sort()).toEqual(["architecture.reach", "contracts.findings", "difficulty", "file.top_level", "redundancy.dead_stores", "redundancy.disconnected"]);
	});
});
