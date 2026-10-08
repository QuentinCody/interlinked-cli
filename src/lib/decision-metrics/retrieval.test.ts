import { expect, it } from "vitest";
import { retrieve, cosine, embeddingGeometry } from "./retrieval.js";
import type { HistoryDocument } from "./retrieval.js";

it("excludes future fixes and reports retrieval scope separately", () => {
    const docs: HistoryDocument[] = [
        {
            id: "past",
            text: "retry delay backoff",
            timestamp: "2026-01-01",
            fixCommit: "a",
            sourceHash: "a",
            vector: [1, 0],
        },
        {
            id: "future",
            text: "retry delay backoff",
            timestamp: "2027-01-01",
            fixCommit: "b",
            sourceHash: "b",
            vector: [1, 0],
        },
    ];
    const result = retrieve(
        { text: "retry backoff", timestamp: "2026-05-01", vector: [1, 0] },
        docs,
        { method: "hybrid", top: 3 },
    );
    expect(result.results.map((row) => row.document.id)).toEqual(["past"]);
    expect(result).toMatchObject({ eligible: 1, excludedFuture: 1 });
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(() => cosine([0, 0], [1, 0])).toThrow();
});

it("reports geometry as distances, not probabilities", () => {
    expect(
        embeddingGeometry([
            [1, 0],
            [1, 0],
        ]),
    ).toMatchObject({ meanCosineDistance: 0, calibrated: false });
    expect(
        embeddingGeometry([
            [1, 0],
            [-1, 0],
        ]).meanCosineDistance,
    ).toBeNull();
});
