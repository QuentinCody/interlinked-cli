import { describe, expect, it } from "vitest";
import type { CheckRegistration } from "../check-registry/types.js";
import { evidenceFor, sweepEvidence } from "./extract.js";
import type { DetectorIndex } from "./resolve.js";

function detectExample(): [] { return []; }
const check: CheckRegistration = {
    id: "example", name: "Example", description: "Example", tier: 1,
    determinism: "fully_deterministic", severity: "error", pipeline: "agent_safety",
    phase: "pre_block", fix_instruction: "Fix example", resultsPropName: "example", fn: detectExample,
};
const index: DetectorIndex = {
    sourceByFn: new Map([["detectExample", "example.ts"]]),
    testsByFn: new Map([["detectExample", ["missing.test.ts"]]]), testSource: new Map(),
};

describe("incomplete and cohort evidence", () => {
    it("reports unavailable cached test source as unlabeled evidence", () => {
        const result = evidenceFor(index, check);
        expect(result.test_file).toBe("missing.test.ts");
        expect(result.cases).toEqual([]);
        expect(result.gaps).toEqual(["no_labeled_cases"]);
        expect(result.positive_count).toBe(0);
        expect(result.negative_count).toBe(0);
    });

    it("adds corpus enforcement to the default case obligation for selected checks", () => {
        const result = sweepEvidence({ registry: [check], index, advisoryIds: new Set(), corpusCohort: new Set(["example"]) });
        expect(result.verdicts[0]?.shortfalls).toEqual([
            "needs ≥3 labeled MUST-FIRE case(s), found 0",
            "needs ≥3 labeled MUST-NOT-FIRE case(s), found 0",
            "no current complete corpus evidence — rescan the declared eligible scope and review every hit",
        ]);
        expect(result.verdicts[0]?.satisfied).toBe(false);
        expect(result.evidence[0]?.corpus_satisfied).toBe(false);
    });
});
