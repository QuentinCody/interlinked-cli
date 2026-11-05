import { expect, it } from "vitest";
import { valueReading } from "./adapter-values.js";
import { METRIC_CATALOG } from "./catalog-metrics.js";
import { composeScore } from "./composite.js";
import type { MetricReading } from "./measurement-types.js";

function readings(score: number): MetricReading[] { return METRIC_CATALOG.map(metric => ({ ...valueReading(metric.id, 1, 1), score })); }

// test-contract: public-api — every metric measured and no blockers is a complete, rankable result
it("reports status complete when every metric is measured", () => {
    const result = composeScore(readings(40));
    expect(result.rankingEligible).toBe(true);
    expect(result.status).toBe("complete");
});

// test-contract: public-api — measured evidence with a missing metric is provisional, not complete
it("reports status provisional when one metric is missing", () => {
    const rows = readings(20).map(row => row.id === "mutation.survivors" ? { ...row, state: "missing" as const, score: null } : row);
    expect(composeScore(rows).status).toBe("provisional");
});
