import assert from "node:assert/strict";
import test from "node:test";
import { baselineDecision } from "./final-judge-comparison.mjs";

test("replay preserves the old evaluator thresholds without applying the new graph threshold", () => {
    assert.equal(baselineDecision(0.5, 0.3), true);
    assert.equal(baselineDecision(0.49, 1), false);
    assert.equal(baselineDecision(1, 0.29), false);
});
