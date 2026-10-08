import { expect, it } from "vitest";
import { candidateConsumers, historyDocuments } from "./corpus.js";
import type { EvidenceRecord } from "./types.js";

const record: EvidenceRecord = {
    id: "contract",
    repository: "repo",
    revision: "a",
    timestamp: "2026-01-01",
    unit: "hunk",
    file: "types.ts",
    line: 1,
    evidence: { hunk: "+type Mode = 'old' | 'new'" },
    provenance: { extractor: "test", sourceHash: "a", metricsVersion: "test" },
};

it("retains undiscovered consumers as unassessed population members", () => {
    const consumers = [
        {
            ...record,
            id: "importer",
            unit: "function" as const,
            file: "use.ts",
            evidence: { body: "use(mode)", dependencies: ["types.ts"] },
        },
        {
            ...record,
            id: "unrelated",
            unit: "function" as const,
            file: "other.ts",
            evidence: { body: "nothing" },
        },
    ];
    const rows = candidateConsumers([record], consumers);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ eligible: true, evidence: { candidateSources: ["import"] } });
    expect(rows[1]?.eligible).toBe(false);
    expect(rows[1]?.reason).toContain("not retrieved");
});

it("requires fix provenance for historical bug-neighbor retrieval", () => {
    expect(() => historyDocuments([record])).toThrow(/fixCommit/);
    expect(
        historyDocuments([
            { ...record, evidence: { body: "fixed", fixCommit: "abc", labelSource: "reviewed" } },
        ])[0],
    ).toMatchObject({ fixCommit: "abc", labelSource: "reviewed" });
});

it("includes same-file consumers and excludes future snapshots without dropping them from the cohort", () => {
    const change = { ...record, evidence: { signature: "Mode", body: "type Mode = 'new'" } };
    const consumer = {
        ...record,
        id: "consumer",
        evidence: { body: "function use(mode: Mode) {}" },
    };
    expect(candidateConsumers([change], [consumer])[0]?.eligible).toBe(true);
    const future = { ...consumer, timestamp: "2027-01-01" };
    expect(candidateConsumers([change], [future])[0]).toMatchObject({
        eligible: false,
        reason: "future consumer snapshot excluded",
    });
});
