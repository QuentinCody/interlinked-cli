import assert from "node:assert/strict";
import test from "node:test";
import { provenanceCases, extractionCases, instructionCases, documentationCases } from "./graph-lab-fixtures.mjs";
import { assessTestProvenance } from "./provenance-graph.mjs";

test("provenance controls include support, stale inputs, capture gaps and poisoned provenance", () => {
    const cases = provenanceCases();
    assert.ok(cases.some(c => c.expected));
    assert.ok(cases.some(c => !c.expected));
    for (const c of cases) {
        const target = c.receipts.find(r => r.id === c.target)!;
        const actual = assessTestProvenance(target.graph, "claim", target.current);
        assert.equal(actual.status === "supported", c.expected, c.id);
    }
});
test("extraction references point to complete source clauses and retain their qualifiers", () => {
    for (const c of extractionCases()) {
        assert.equal(c.annotation.claims.length, 3);
        for (const claim of c.annotation.claims) for (const [s, e] of claim.spans) assert.ok(c.source.slice(s, e).length > 5);
        assert.equal(c.annotation.claims.reduce((n, x) => n + x.qualifiers.length, 0), 1);
    }
});
test("instruction and module controls contain explicit abstention cases", () => {
    assert.ok(instructionCases().some(c => c.expected === "none"));
    assert.ok(documentationCases().some(c => c.expected === "unknown"));
    assert.ok(documentationCases().some(c => c.expected === "unreachable"));
});
