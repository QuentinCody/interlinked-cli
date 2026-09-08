import { expect, it } from "vitest";
import { parseScoreSnapshot } from "./score-snapshot.js";

it("compares the policies used by the metric readings, excluding obsolete receipt history", () => {
    const snapshot = parseScoreSnapshot({ schemaVersion: 2, profile: { id: "profile", hash: "hash" }, registryHash: "registry",
        languages: ["javascript"], rankingEligible: false, slopScore: null, observedScore: 0, sourceHash: "source",
        metrics: [{ id: "coverage.lines", state: "measured", value: 0, score: 0, evidenceIds: ["current"] }],
        evidence: [{ id: "obsolete", kind: "coverage", operatorPolicy: "v0" }, { id: "current", kind: "coverage", operatorPolicy: "v1" }],
    });
    expect(snapshot.evidencePolicies).toEqual(["coverage:v1"]);
});
