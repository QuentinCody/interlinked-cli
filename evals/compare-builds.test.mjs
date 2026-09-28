import { test } from "node:test";
import assert from "node:assert/strict";
import { comparisonPlan, pairedSummary } from "./compare-builds.mjs";

test("five repetitions of six tasks yield 60 counterbalanced sessions", () => {
    const plan = comparisonPlan(["module", "rename", "repair", "probe", "read", "complexity"], 5);
    assert.equal(plan.length, 60);
    assert.deepEqual(plan.slice(0, 4).map(row => row.arm), ["baseline", "candidate", "candidate", "baseline"]);
});

test("infrastructure failures stay visible and cannot become successes", () => {
    const result = pairedSummary([
        { task: "a", rep: 1, arm: "baseline", success: true, seconds: 10 },
        { task: "a", rep: 1, arm: "candidate", success: false, seconds: 5, infrastructure_error: "missing receipt" },
    ]);
    assert.equal(result.baseline_successes, 1);
    assert.equal(result.candidate_successes, 0);
    assert.equal(result.infrastructure_failures, 1);
    assert.equal(result.paired_seconds.length, 0);
});
