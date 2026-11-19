import { describe, expect, it } from "vitest";
import { minimalPolicy } from "./__tests__/policy-fixture.js";
import { acceptExpectation, expectationRevision, proposeExpectation, type ExpectationDraft } from "./expectations.js";
import { parseE2ePolicy, type E2ePolicy } from "./policy.js";

function draft(): ExpectationDraft {
    return {
        id: "cancel-keeps-audit", projectId: "orders", scenarioIds: ["order-persists"], statement: "cancelling an unshipped order keeps its audit record",
        origin: "user-requirement", sources: [], assumptions: [], questions: [], examples: { positive: [], negative: [] }, contractIds: ["orders.create"],
    };
}
function policy(): E2ePolicy { return parseE2ePolicy(JSON.stringify(minimalPolicy())); }

// Census fault: `current()` lost the `actual !== row.revision` check (review R6) and
// survived the companion test (docs/reviews/kill-proof-census-e2e-structure.md).
describe("acceptExpectation — a record edited without re-proposal", () => {
    // test-contract: bug — a stored revision is a claim; when the record's content no longer hashes to it, no decision may bind the edited text, even one quoting the recomputed revision
    it("refuses to accept a proposed record whose statement was edited in place, even against the recomputed revision", () => {
        const proposed = proposeExpectation(policy(), draft(), 10);
        proposed.expectations[0]!.statement = "cancelling ANY order keeps its audit record";
        const recomputed = expectationRevision(proposed.expectations[0]!);
        expect(recomputed).not.toBe(proposed.expectations[0]!.revision);
        expect(() => acceptExpectation(proposed, { expectationId: "cancel-keeps-audit", revision: recomputed, rationale: "looks right" }, 20)).toThrow(/edited without re-proposal/);
        expect(proposed.expectations[0]!.lifecycle).toBe("proposed");
    });
});
