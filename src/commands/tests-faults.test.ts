import { describe, expect, it } from "vitest";
import type { ClauseEvidence } from "../harness/check-evidence/clauses.js";
import type { FaultRunReport } from "../harness/requirement-faults/run.js";
import { renderClauseEvidence, renderFaultRun } from "./tests-faults.js";

describe("renderClauseEvidence", () => {
    const evidence: ClauseEvidence = { module: "test-catch", total: 3, measured: 2, pinned: 1, clauses: [
        { k: 1, direction: "fires", text: "catch-only assertions", faults: 2, killed: 2, fraction: 1 },
        { k: 2, direction: "quiet", text: "a recognized toThrow assertion", faults: 2, killed: 1, fraction: 0.5 },
        { k: 3, direction: "quiet", text: "skipped tests", faults: 0, killed: 0, fraction: null },
    ] };
    it("P1: per module, pinned / measured / total, then every clause that is not pinned", () => {
        expect(renderClauseEvidence([evidence], "2026-10-21T00:00:00.000Z")).toBe([
            "detector clauses (fault run 2026-10-21T00:00:00.000Z): 1 of 3 pinned, 2 measured",
            "  test-catch: 1/3 pinned, 2 measured",
            "    k2 DOES NOT FIRE \"a recognized toThrow assertion\": kill fraction 0.50",
            "    k3 DOES NOT FIRE \"skipped tests\": no recorded fault",
        ].join("\n"));
    });
    it("N1: without a fault run every clause is unmeasured, never pinned", () => {
        expect(renderClauseEvidence([{ ...evidence, measured: 0, pinned: 0, clauses: evidence.clauses.map(row => ({ ...row, faults: 0, killed: 0, fraction: null })) }], null).split("\n")[0])
            .toBe("detector clauses (no fault run recorded): 0 of 3 pinned, 0 measured");
    });
});

const REPORT: FaultRunReport = {
    faults: [
        { fault: "R1#m1", requirement: "R1", status: "killed", killedBy: ["a.test.ts › x"], inconclusive: [] },
        { fault: "R1#m2", requirement: "R1", status: "survived", killedBy: [], inconclusive: [] },
        { fault: "R2#m1", requirement: "R2", status: "killed", killedBy: ["a.test.ts › y"], inconclusive: [] },
        { fault: "R3#m1", requirement: "R3", status: "invalid", killedBy: [], inconclusive: [], reason: "anchor occurs 0 times in a.ts (exactly one is required)" },
    ],
    requirements: [
        { requirement: "R1", killed: 1, survived: 1, inconclusive: 0, invalid: 0, fraction: 0.5 },
        { requirement: "R2", killed: 1, survived: 0, inconclusive: 0, invalid: 0, fraction: 1 },
        { requirement: "R3", killed: 0, survived: 0, inconclusive: 0, invalid: 1, fraction: null },
    ],
};

describe("renderFaultRun — positive", () => {
    it("P1: totals, requirements by kill fraction, every survivor named, every invalid fault with its reason", () => {
        expect(renderFaultRun(REPORT)).toBe([
            "requirement faults: 4 run — 2 killed, 1 survived, 0 inconclusive, 1 invalid",
            "  requirements: 3 — 1 fully pinned (fraction 1), 1 partly pinned, 0 unpinned, 1 without a conclusive fault",
            "  survived: R1#m2 (requirement R1, fraction 0.50)",
            "  invalid: R3#m1 — anchor occurs 0 times in a.ts (exactly one is required)",
        ].join("\n"));
    });
});

describe("renderFaultRun — inconclusive faults", () => {
    it("P2: an inconclusive fault names its first test and why it was not a kill, and counts the rest", () => {
        const report: FaultRunReport = { faults: [{ fault: "R4#m1", requirement: "R4", status: "inconclusive", killedBy: [], inconclusive: ["a.test.ts › x", "a.test.ts › y"],
            inconclusiveReasons: { "a.test.ts › x": "Error: sum unavailable", "a.test.ts › y": "no result" } }],
            requirements: [{ requirement: "R4", killed: 0, survived: 0, inconclusive: 1, invalid: 0, fraction: null }] };
        expect(renderFaultRun(report).split("\n").slice(2)).toEqual(["  inconclusive: R4#m1 — a.test.ts › x: Error: sum unavailable (+1 more)"]);
    });

    it("N2: a report saved before reasons were recorded prints the test without inventing a reason", () => {
        const report: FaultRunReport = { faults: [{ fault: "R4#m1", requirement: "R4", status: "inconclusive", killedBy: [], inconclusive: ["a.test.ts › x"] }],
            requirements: [{ requirement: "R4", killed: 0, survived: 0, inconclusive: 1, invalid: 0, fraction: null }] };
        expect(renderFaultRun(report).split("\n").slice(2)).toEqual(["  inconclusive: R4#m1 — a.test.ts › x: no reason recorded"]);
    });
});

describe("renderFaultRun — negative", () => {
    it("N1: an empty run says so instead of printing zero ratios", () => {
        expect(renderFaultRun({ faults: [], requirements: [] })).toBe("requirement faults: no fault selected");
    });
});
