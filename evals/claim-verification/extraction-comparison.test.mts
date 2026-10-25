import assert from "node:assert/strict";
import test from "node:test";
import { summarizeExtraction } from "./extraction-comparison.mjs";

test("metrics use pooled numerators and keep empty qualifier denominators unmeasured", () => {
    const summary = summarizeExtraction([{ claims: 2, completeRetained: 1, coreRetained: 2, candidateChars: 10, precisionChars: 8,
        qualifiers: 0, qualifiersRetained: 0, qualifiersAttached: 0, qualifiersMisattached: 0,
        polarityEligible: 0, polarityPreserved: 0, scopeEligible: 0, scopePreserved: 0 },
    { claims: 1, completeRetained: 1, coreRetained: 1, candidateChars: 30, precisionChars: 12,
        qualifiers: 0, qualifiersRetained: 0, qualifiersAttached: 0, qualifiersMisattached: 0,
        polarityEligible: 0, polarityPreserved: 0, scopeEligible: 0, scopePreserved: 0 }]);
    assert.equal(summary.rates.completeClaimRecall, 2 / 3);
    assert.equal(summary.rates.spanCharacterPrecision, 0.5);
    assert.equal(summary.rates.qualifierRecall, null);
});
