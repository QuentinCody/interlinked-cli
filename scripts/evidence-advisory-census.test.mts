import { expect, it } from "vitest";
import { advisoryCalibration, LABELED } from "./evidence-advisory-census.mts";
it("keeps identical syntax with opposite legitimate intentions visible and does not promote a heuristic", () => {
    const report = advisoryCalibration(LABELED);
    expect(report).toMatchObject({ flagged: 12, true_positive: 6, false_positive: 6, precision: 0.5, qualified_for_pre_warn: false });
    expect(report.results.filter(row => row.category === "budget").map(row => row.label)).toEqual(["concern", "legitimate"]);
});
