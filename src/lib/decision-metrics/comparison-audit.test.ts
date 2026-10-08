import { expect, it } from "vitest";
import { auditComparison } from "./comparison-audit.js";
import type { AuditCase } from "./audit.js";

it("compares probability statistics on common observations while retaining retrieval misses in full-cohort recall", () => {
    const rows: AuditCase[] = [false, true, false, true].map((positive, i) => ({
        id: String(i),
        timestamp: i < 2 ? "2025-01-01" : "2026-01-01",
        group: String(i),
        repository: "repo",
        family: "feature",
        positive,
        probability: positive ? 0.9 : 0.1,
        status: "answered",
        size: [i],
        structural: [i],
        reviewers: ["a", "b"],
        adjudicated: true,
    }));
    const retrieval: AuditCase[] = rows.map((row, i) =>
        i === 3 ? { ...row, probability: null, status: "unassessed" } : row,
    );
    const report = auditComparison(rows, retrieval, { cutoff: "2025-06-01", band: [0.2, 0.8] });
    expect(report.paired).toMatchObject({ eligible: 2, bothAssessed: 1 });
    expect(report.retrieval.operational.fullCohortRecall).toBe(0);
    expect(report.direct.operational.fullCohortRecall).toBe(1);
    expect(() =>
        auditComparison(rows, [{ ...retrieval[0]!, positive: true }, ...retrieval.slice(1)], {
            cutoff: "2025-06-01",
            band: [0.2, 0.8],
        }),
    ).toThrow(/identical/);
});
