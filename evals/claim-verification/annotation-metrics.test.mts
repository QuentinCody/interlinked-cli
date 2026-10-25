import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { extractionMetrics, locatedLegacy, validateAnnotation, type Annotation } from "./annotation-metrics.mjs";
import { legacyCandidates, spanCandidates } from "./extractors.mjs";

const source = "Do not change the API.\nRetry three times.\nExcept for auth failures.";
const annotation: Annotation = {
    id: "turn", sourceSha256: createHash("sha256").update(source).digest("hex"), annotator: "gpt-6-astra",
    schemaVersion: 1, annotationComplete: true, nonClaims: [], unresolved: [],
    claims: [{ id: "c1", spans: [[23, 41]], kind: "behavior", polarity: "positive", scope: "retry",
        interpretation: "three retries except authentication failures", qualifiers: [{ spans: [[42, 67]], relation: "exception" }],
        labels: { operational: "not_assessable", curated: "supported" }, evidenceIds: { operational: [], curated: ["r1"] },
        rationale: { operational: "Missing output", curated: "Returned evidence" }, confidence: "high" }],
};

test("annotation validation rejects stale sources, out-of-range spans and fabricated receipt identities", () => {
    const valid = structuredClone(annotation);
    valid.claims[0]!.spans = [[22, 40]];
    valid.claims[0]!.qualifiers[0]!.spans = [[41, source.length]];
    assert.doesNotThrow(() => validateAnnotation(valid, source, new Set(["r1"]), 0));
    assert.throws(() => validateAnnotation(valid, source + "!", new Set(["r1"]), 0), /hash/);
    const bad = structuredClone(valid); bad.claims[0]!.spans = [[0, source.length + 1]];
    assert.throws(() => validateAnnotation(bad, source, new Set(["r1"]), 0), /span/);
    assert.throws(() => validateAnnotation(valid, source, new Set(), 0), /receipt/);
    const wrongSnapshot = structuredClone(valid);
    wrongSnapshot.claims[0]!.evidenceIds.operational = ["r1"];
    assert.throws(() => validateAnnotation(wrongSnapshot, source, new Set(["r1"]), 1), /operational/);
});

test("legacy provenance preserves the production text and cannot jump to a repeated occurrence", () => {
    const text = "😀 **This complete factual sentence has enough words.**\n```ts\nignored code\n```\nThis complete factual sentence has enough words.\n| removed | row |";
    const located = locatedLegacy(text);
    assert.deepEqual(located.map(c => c.text), legacyCandidates(text).map(c => c.text));
    assert(located.every(c => c.spans.every(([s, e]) => s >= 0 && e <= text.length && e > s)));
    assert(located[1]!.spans[0]![0] > located[0]!.spans.at(-1)![1]);
    assert(!located.some(c => c.spans.some(([s, e]) => text.slice(s, e).includes("ignored code"))));
});

test("complete claim retention requires its qualifier in the same candidate", () => {
    const a = structuredClone(annotation); a.claims[0]!.spans = [[22, 40]]; a.claims[0]!.qualifiers[0]!.spans = [[41, source.length]];
    const candidates = spanCandidates(source).map(c => ({ text: c.text, spans: [c.span!] }));
    const result = extractionMetrics(source, a, candidates);
    assert.equal(result.coreRetained, 1);
    assert.equal(result.completeRetained, 0);
    assert.equal(result.qualifiersRetained, 1);
    assert.equal(result.qualifiersAttached, 0);
    assert.equal(result.claims, 1);
    assert(result.precisionChars < result.candidateChars);
});

test("qualifier attachment and polarity use annotated source spans, not guessed meaning", () => {
    const text = "Do not change the API.";
    const a = structuredClone(annotation); a.claims[0]!.spans = [[7, text.length]];
    a.claims[0]!.qualifiers = [{ spans: [[0, 6]], relation: "negation" }];
    const whole = extractionMetrics(text, a, [{ text, spans: [[0, text.length]] }]);
    const lost = extractionMetrics(text, a, [{ text: text.slice(7), spans: [[7, text.length]] }]);
    assert.equal(whole.polarityPreserved, 1); assert.equal(lost.polarityPreserved, 0);
    assert.equal(whole.scopeEligible, 0);
});
