import { expect, it } from "vitest";
import { parseScoreSnapshot } from "./score-snapshot.js";

function snapshotWithScore(score: number) {
    return { schemaVersion: 2, profile: { id: "profile", hash: "hash" }, registryHash: "registry",
        languages: ["javascript"], rankingEligible: false, slopScore: null, observedScore: 0, sourceHash: "source",
        metrics: [{ id: "coverage.lines", state: "measured", value: 0, score }], evidence: [] };
}

// test-contract: boundary — a metric score below 0 is outside the 0–100 scale and must be refused
it("rejects a negative metric score", () => {
    expect(() => parseScoreSnapshot(snapshotWithScore(-1))).toThrow("Metric score outside 0–100");
});

// test-contract: boundary — 0 is the lowest valid score and is accepted
it("accepts a metric score of exactly 0", () => {
    expect(parseScoreSnapshot(snapshotWithScore(0)).metrics[0]?.score).toBe(0);
});
