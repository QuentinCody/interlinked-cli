import { expect, it } from "vitest";
import { validateRun } from "./serialization.js";
import { validateAuditCase } from "./reports.js";

it("rejects invented passing records and numeric strings at the audit boundary", () => {
    expect(() =>
        validateRun({
            schemaVersion: 1,
            runId: "x",
            startedAt: "now",
            completedAt: "now",
            mode: "measure",
            measurements: [{ status: "answered" }],
        }),
    ).toThrow();
    const label = {
        id: "x",
        timestamp: "2026-01-01",
        group: "g",
        repository: "r",
        family: "fix",
        positive: true,
        probability: "0.9",
        status: "answered",
        size: [1],
        structural: [1],
        reviewers: [],
        adjudicated: false,
    };
    expect(() => validateAuditCase(label)).toThrow(/numeric/);
    expect(() => validateAuditCase({ ...label, probability: 0.9, status: "failed" })).toThrow(
        /unanswered/,
    );
});
