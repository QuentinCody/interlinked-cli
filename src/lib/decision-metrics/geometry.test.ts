import { expect, it } from "vitest";
import { measureGeometry } from "./geometry.js";
import type { EvidenceRecord } from "./types.js";

it("reports zero churn for identical vectors and unit distance for orthogonal vectors without calling them probabilities", () => {
    const base: EvidenceRecord = {
        id: "a",
        repository: "r",
        revision: "c",
        timestamp: "2026-01-01",
        unit: "function",
        file: "a.ts",
        line: 1,
        evidence: {
            embedding: [1, 0],
            embeddingModelIdentity: "fixture@v1",
            previousEmbedding: [1, 0],
            previousEmbeddingModelIdentity: "fixture@v1",
        },
        provenance: { extractor: "test", sourceHash: "s", metricsVersion: "test" },
    };
    const second = { ...base, id: "b", evidence: { ...base.evidence, embedding: [0, 1] } };
    const result = measureGeometry([base, second]);
    expect(result.calibrated).toBe(false);
    expect(result.records[0]?.evidence.metrics).toMatchObject({
        embeddingGeometry: { semanticChurn: 0, outlierMeanDistance: 1 },
    });
    expect(result.records[1]?.evidence.metrics).toMatchObject({
        embeddingGeometry: { semanticChurn: 1 },
    });
    expect(() =>
        measureGeometry([
            { ...base, evidence: { ...base.evidence, previousEmbeddingModelIdentity: "other" } },
        ]),
    ).toThrow(/same pinned/);
});
