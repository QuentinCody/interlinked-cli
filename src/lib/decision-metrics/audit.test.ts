import { expect, it } from "vitest";
import { auditCohort, operationalReport, type AuditCase } from "./audit.js";
import { CATALOG } from "./contracts.js";

function row(id: string, at: string, positive: boolean, probability: number | null): AuditCase {
    return {
        id,
        timestamp: at,
        group: id,
        repository: "fixture",
        family: "boundary",
        positive,
        probability,
        status: probability === null ? "unassessed" : "answered",
        size: [positive ? 2 : 1],
        structural: [positive ? 2 : 1, 1],
        reviewers: ["a", "b"],
        adjudicated: true,
    };
}

it("counts retrieval misses and failures in full-cohort recall", () => {
    const cases = [
        row("a", "2025-01-01", false, 0.1),
        row("b", "2025-01-02", true, 0.9),
        row("c", "2026-01-01", true, 0.9),
        row("d", "2026-01-02", true, null),
        row("e", "2026-01-03", false, 0.1),
    ];
    const result = auditCohort(cases, { cutoff: "2026-01-01", band: [0.2, 0.8] });
    expect(result.operational.fullCohortRecall).toBe(0.5);
    expect(result.operational.completion).toBeCloseTo(2 / 3);
    expect(result.acceptance.qualified).toBe(false);
    expect(result.probability.brier).toBeCloseTo(0.01);
    expect(() =>
        auditCohort([...cases, { ...cases[0]!, id: "leak", timestamp: "2026-01-01" }], {
            cutoff: "2026-01-01",
            band: [0.2, 0.8],
        }),
    ).toThrow(/group leakage/);
});

it("retains multiclass uncertainty and inverse-question band boundaries", () => {
    const atomicity: AuditCase = {
        ...row("a", "2026-01-01", false, 0.1),
        status: "abstained",
        contract: CATALOG.atomicity!,
        raw: {
            kind: "choice",
            probabilities: {
                same_goal: 0.45,
                supporting: 0.45,
                independent: 0.1,
                insufficient_evidence: 0,
            },
        },
    };
    expect(operationalReport([atomicity], [0.2, 0.8]).states.abstained).toBe(1);
    const naming: AuditCase = {
        ...row("b", "2026-01-01", true, 0.8),
        status: "abstained",
        contract: CATALOG.name_matches!,
        raw: { kind: "yes_no", probability: 0.2 },
    };
    expect(operationalReport([naming], [0.2, 0.8]).fullCohortRecall).toBe(0);
    expect(operationalReport([naming], [0.3, 0.8]).fullCohortRecall).toBe(1);
    const insufficient: AuditCase = {
        ...atomicity,
        probability: null,
        status: "insufficient_evidence",
        raw: {
            kind: "choice",
            probabilities: {
                same_goal: 0.1,
                supporting: 0.1,
                independent: 0.1,
                insufficient_evidence: 0.7,
            },
        },
    };
    expect(operationalReport([insufficient], [0.4, 0.6]).states.insufficient_evidence).toBe(1);
    expect(operationalReport([insufficient], [0.2, 0.8]).states.abstained).toBe(1);
});

it("selects an uncertainty band using training data only", () => {
    const training = [row("a", "2025-01-01", false, 0.35), row("b", "2025-01-02", true, 0.85)];
    const heldOut = [row("c", "2026-01-01", false, 0.1), row("d", "2026-01-02", true, 0.9)];
    const policy = { cutoff: "2026-01-01", band: [0.2, 0.8] as const };
    const first = auditCohort([...training, ...heldOut], policy);
    const shifted = auditCohort(
        [...training, ...heldOut.map((row) => ({ ...row, probability: 1 - row.probability! }))],
        policy,
    );
    expect(first.suggestedBand?.band).toEqual([0.4, 0.6]);
    expect(shifted.suggestedBand?.band).toEqual(first.suggestedBand?.band);
    expect(shifted.suggestedBand?.heldOut.falseBlockRate).toBe(1);
});

it("rejects pooled rubric versions even when the metric name stays the same", () => {
    const cases = [
        { ...row("a", "2025-01-01", false, 0.1), contract: CATALOG.name_matches! },
        {
            ...row("b", "2026-01-01", true, 0.9),
            contract: { ...CATALOG.name_matches!, question: "A changed naming rubric" },
        },
    ];
    expect(() => auditCohort(cases, { cutoff: "2026-01-01", band: [0.2, 0.8] })).toThrow(
        /contract version/,
    );
});
