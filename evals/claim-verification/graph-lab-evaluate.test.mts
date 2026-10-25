import assert from "node:assert/strict";
import test from "node:test";
import { supportMetrics, attachQualifiers } from "./graph-lab-evaluate.mjs";

test("support metrics keep positive recall and false endorsement denominators separate", () => {
    const metrics = supportMetrics([{ expected: true, predicted: true }, { expected: true, predicted: false }, { expected: false, predicted: true }]);
    assert.equal(metrics.recall, 0.5);
    assert.equal(metrics.falseEndorsementRate, 1);
});
test("qualifier assembly uses selected source spans and leaves low-confidence links unattached", () => {
    const candidates = [{ text: "Passed.", spans: [[0, 7] as [number, number]] }, { text: "Only unit.", spans: [[8, 18] as [number, number]] }];
    assert.equal(attachQualifiers(candidates, [0], [1], { "1:0": 0.9 }, 0.8)[0]!.spans.length, 2);
    assert.equal(attachQualifiers(candidates, [0], [1], { "1:0": 0.7 }, 0.8)[0]!.spans.length, 1);
});
