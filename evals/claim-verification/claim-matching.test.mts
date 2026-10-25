import assert from "node:assert/strict";
import test from "node:test";
import { maximumWeightMatching, matchedExtractionMetrics } from "./claim-matching.mjs";
import type { Annotation } from "./annotation-metrics.mjs";

function annotation(spans: Array<[number, number]>): Annotation {
    return { id: "example", sourceSha256: "fixture", annotator: "construction", schemaVersion: 1, annotationComplete: true,
        nonClaims: [], unresolved: [], claims: spans.map((span, i) => ({ id: `c${i}`, spans: [span], kind: "fact", polarity: "positive", scope: "local",
            interpretation: "fixture", qualifiers: [], labels: { operational: "unsupported", curated: "unsupported" },
            evidenceIds: { operational: [], curated: [] }, rationale: { operational: "fixture", curated: "fixture" }, confidence: "construction" })) };
}

test("assignment maximizes total overlap rather than taking the largest edge greedily", () => {
    assert.deepEqual(maximumWeightMatching([[0.9, 0.8], [0.85, 0]], 0.5).map(x => [x.reference, x.candidate]), [[0, 1], [1, 0]]);
    assert.deepEqual(maximumWeightMatching([[], []]), []);
    assert.deepEqual(maximumWeightMatching([[0.49]]), []);
    assert.throws(() => maximumWeightMatching([[1], [0, 1]]), /rectangular/);
});

test("assignment agrees with exhaustive optima for small rectangular graphs", () => {
    function exhaustive(weights: number[][], row = 0, used = new Set<number>()): number {
        if (row === weights.length) return 0;
        let best = exhaustive(weights, row + 1, used);
        for (const [column, weight] of weights[row]!.entries()) if (!used.has(column) && weight >= 0.5) {
            best = Math.max(best, weight + exhaustive(weights, row + 1, new Set([...used, column])));
        }
        return best;
    }
    for (let seed = 1; seed <= 25; seed++) {
        const weights = Array.from({ length: 1 + seed % 4 }, (_, i) => Array.from({ length: 1 + seed % 5 }, (_, j) => ((seed * 13 + i * 7 + j * 3) % 11) / 10));
        const actual = maximumWeightMatching(weights).reduce((sum, edge) => sum + edge.weight, 0);
        assert.ok(Math.abs(actual - exhaustive(weights)) < 1e-9);
    }
});

test("one whole-message candidate cannot earn recall for both claims", () => {
    const source = "Alpha. Bravo.";
    const result = matchedExtractionMetrics(source, annotation([[0, 6], [7, 13]]), [{ text: source, spans: [[0, source.length]] }]);
    assert.equal(result.matchedClaims, 1);
    assert.equal(result.completeRetained, 1);
    assert.equal(result.unmatchedReferences, 1);
    assert.equal(result.pairPrecisionChars, 6);
    assert.equal(result.candidateChars, 12);
});

test("duplicates count as unmatched predictions and empty spans cannot match", () => {
    const a = annotation([[0, 6]]), c = { text: "Alpha.", spans: [[0, 6] as [number, number]] };
    const result = matchedExtractionMetrics("Alpha.", a, [c, c, { text: "", spans: [] }]);
    assert.equal(result.completeRetained, 1);
    assert.equal(result.unmatchedCandidates, 2);
});

test("matching includes nonlocal qualifiers and does not credit missing negation", () => {
    const source = "Do not change the API.";
    const a = annotation([[7, source.length]]);
    a.claims[0]!.qualifiers = [{ spans: [[0, 6]], relation: "negation" }];
    const missing = matchedExtractionMetrics(source, a, [{ text: source.slice(7), spans: [[7, source.length]] }]);
    assert.equal(missing.matchedClaims, 1);
    assert.equal(missing.completeRetained, 0);
    assert.equal(missing.polarityPreserved, 0);
    const full = matchedExtractionMetrics(source, a, [{ text: source, spans: [[0, 6], [7, source.length]] }]);
    assert.equal(full.completeRetained, 1);
    assert.equal(full.qualifiersAttached, 1);
    assert.throws(() => matchedExtractionMetrics(source, a, [{ text: source, spans: [[0, 999]] }]), /span/);
});
