import test from "node:test";
import assert from "node:assert/strict";
import { priority, withExploration } from "./mutation-ranking.mjs";

test("equivalence is logged without affecting priority", () => {
    const original = priority({ violates: 0.8, realistic: 0.5, checked: 0.3, equivalent: 0 });
    assert.ok(Math.abs(original - 0.69) < 1e-12);
    assert.equal(priority({ violates: 0.8, realistic: 0.5, checked: 0.3, equivalent: 1 }), original);
});

test("exploration retains the identical pool exactly once", () => {
    const ranked = Array.from({ length: 30 }, (_, i) => String(i));
    const random = [...ranked].reverse();
    const result = withExploration(ranked, random);
    assert.deepEqual(new Set(result), new Set(ranked));
    assert.equal(result.length, ranked.length);
    assert.equal(result[9], "29");
});
