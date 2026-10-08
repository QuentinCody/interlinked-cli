import { expect, it } from "vitest";
import { atomicityRecords, claimRecords, resolveObligations } from "./relational-analysis.js";
import type { EvidenceRecord, Measurement } from "./types.js";

const base: EvidenceRecord = {
    id: "a",
    repository: "fixture",
    revision: "a",
    timestamp: "2026-01-01",
    unit: "hunk",
    file: "a.ts",
    line: 1,
    evidence: { hunk: "+new behavior", message: "Add behavior" },
    provenance: { extractor: "test", sourceHash: "a", metricsVersion: "test" },
};

it("accounts for every pair and preserves literal claims", () => {
    expect(atomicityRecords([base, { ...base, id: "b" }, { ...base, id: "c" }])).toHaveLength(3);
    expect(claimRecords([base], ["Add behavior"])[0]?.evidence.claim).toBe("Add behavior");
    expect(() => claimRecords([base], ["Invented claim"])).toThrow(/literal/);
});

it("feeds the first-pass judgment to the satisfaction pass", async () => {
    const candidate = {
        ...base,
        unit: "pair" as const,
        evidence: { change: "new enum", consumer: "switch", verification: [] },
    };
    let secondSaw: unknown;
    const measure = async (records: EvidenceRecord[], metric: string): Promise<Measurement[]> => {
        if (metric === "satisfaction") secondSaw = records[0]?.evidence.obligation;
        return records.map(
            (record) =>
                ({
                    record,
                    unitId: record.id,
                    status: "answered",
                    value: metric === "obligation" ? "update" : "missing",
                    raw: null,
                }) as Measurement,
        ); // SAFETY: test double exercises only consumed fields of the measurement contract.
    };
    const result = await resolveObligations([candidate], measure);
    expect(secondSaw).toMatchObject({ status: "answered", value: "update" });
    expect(result.rows[0]?.status).toBe("missing");
    expect(result.unresolved).toBe(1);
});
