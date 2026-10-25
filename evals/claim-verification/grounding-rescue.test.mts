import assert from "node:assert/strict";
import test from "node:test";
import { shouldRescue, rescueQuestion, rescueDecision } from "./grounding-rescue.mjs";
import type { GroundingCase } from "./grounding.mjs";

test("rescue acts only on measured baseline-positive citation-negative disagreements", () => {
    assert.equal(shouldRescue(true, false), true);
    assert.equal(shouldRescue(false, false), false);
    assert.equal(shouldRescue(true, null), false);
    assert.equal(shouldRescue(null, false), false);
    assert.equal(shouldRescue(true, true), false);
});

test("rescue includes complete returned evidence but no expected label", () => {
    const item: GroundingCase = { id: "probe", claim: "A file was written.", expectedSupport: true, origin: "authored-development",
        evidence: [{ tool: "Bash", input: "write file", result_tail: "file receipt", error: false }] };
    const question = JSON.stringify(rescueQuestion(item));
    assert(question.includes("file receipt"));
    assert(!question.includes("expectedSupport"));
    assert(!question.includes("authored-development"));
});

test("missing and non-finite scores remain unmeasured, not rejections", () => {
    assert.equal(rescueDecision(undefined), null);
    assert.equal(rescueDecision({ type: "noul", noul: Number.NaN }), null);
    assert.equal(rescueDecision({ type: "noul", noul: 0.89 }), false);
    assert.equal(rescueDecision({ type: "noul", noul: 0.91 }), true);
    assert.equal(rescueDecision({ type: "noul", noul: 0.87 }, 0.8), true);
    assert.throws(() => rescueDecision({ type: "noul", noul: 0.9 }, Number.NaN));
});
