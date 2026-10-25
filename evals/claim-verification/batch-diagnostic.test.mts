import assert from "node:assert/strict";
import test from "node:test";
import { buildDiagnosticCase, summarizeReference, type FrozenEvidence } from "./batch-diagnostic.mjs";
import type { Annotation } from "./annotation-metrics.mjs";

const annotation: Annotation = {
    id: "t", sourceSha256: "hash", annotator: "gpt-6-astra", schemaVersion: 1, annotationComplete: true,
    nonClaims: [], unresolved: [], claims: [{ id: "c", spans: [[0, 4]], kind: "file", qualifiers: [], polarity: "positive",
        scope: "file", interpretation: "wrote", labels: { operational: "not_assessable", curated: "supported" },
        evidenceIds: { operational: [], curated: ["right"] }, rationale: { operational: "missing", curated: "patch" }, confidence: "high" }],
};
const evidence: FrozenEvidence = { id: "t", operationalEvidence: [{ name: "Write", input: "a.ts", result: "ok", is_error: false }],
    receipts: [{ id: "right", tool: "Write", input: "a.ts", result_tail: "success", error: false, structuredResult: { content: "const yes = true;" } },
        { id: "unrelated", tool: "Bash", input: "pwd", result_tail: "/repo", error: false }] };

test("curation retains returned structured content, excludes unrelated receipts and never sends reference labels", () => {
    const item = buildDiagnosticCase("Done", annotation, evidence);
    assert.equal(item.curatedEvidence.length, 1);
    assert(item.curatedEvidence[0]!.result_tail.includes("const yes = true;"));
    assert.equal(item.operationalEvidence[0]!.result_tail, "ok");
    assert.equal(item.annotation, "model-adjudicated:gpt-6-astra");
});

test("missing capture and missing model answers are separate from negative reference labels", () => {
    const outcomes = [{ target: "c", status: "judged", supported: true }];
    const operational = summarizeReference(annotation, "operational", outcomes);
    assert.equal(operational.notAssessable, 1);
    assert.equal(operational.falseEndorsements, 0);
    assert.equal(operational.endorsementsWithoutAssessableReference, 1);
    const curated = summarizeReference(annotation, "curated", outcomes);
    assert.equal(curated.trueEndorsements, 1);
    assert.equal(summarizeReference(annotation, "curated", [{ target: "c", status: "not_measured" }]).notMeasured, 1);
});

test("a rejected unsupported claim is not counted as a confirmed contradiction", () => {
    const a = structuredClone(annotation); a.claims[0]!.labels.curated = "unsupported";
    const result = summarizeReference(a, "curated", [{ target: "c", status: "judged", supported: false }]);
    assert.equal(result.correctNonEndorsements, 1);
    assert.equal(result.referenceContradictions, 0);
});
