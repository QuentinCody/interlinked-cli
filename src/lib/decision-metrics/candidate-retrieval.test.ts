import { expect, it } from "vitest";
import { discoverCandidates } from "./candidate-retrieval.js";
import { parseConfig } from "./config.js";
import type { EvidenceRecord } from "./types.js";

it("retrieves by meaning candidates while retaining unrelated candidates as unassessed", async () => {
    const row: EvidenceRecord = {
        id: "contract",
        repository: "repo",
        revision: "r",
        timestamp: "2026-01-01",
        unit: "function",
        file: "contract.ts",
        line: 1,
        evidence: { body: "retry cancellation limit" },
        provenance: { extractor: "test", sourceHash: "s", metricsVersion: "m" },
    };
    const consumers = [
        {
            ...row,
            id: "consumer",
            file: "consumer.ts",
            evidence: { body: "retry cancellation budget" },
        },
        { ...row, id: "other", file: "other.ts", evidence: { body: "encode colors" } },
    ];
    const candidates = await discoverCandidates(
        "/tmp",
        [row],
        consumers,
        parseConfig({ version: 1 }),
        "lexical",
    );
    expect(candidates.map((row) => row.eligible)).toEqual([true, false]);
    expect(candidates[0]?.evidence.candidateSources).toContain("retrieval");
});
