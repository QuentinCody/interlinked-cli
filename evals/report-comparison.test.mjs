import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapMeanInterval, pairedDifferences } from "./report-comparison.mjs";
test("paired interval is deterministic and preserves a constant difference", () => {
    assert.deepEqual(bootstrapMeanInterval([-2, -2, -2]), [-2, -2]);
    assert.deepEqual(bootstrapMeanInterval([]), null);
    assert.deepEqual(bootstrapMeanInterval([-1, 2, 3]), bootstrapMeanInterval([-1, 2, 3]));
});

test("pairs repetitions within their own experiment directory", () => {
    const cells = [
        { evidence_directory: "first", arm: "baseline", seconds: 10 },
        { evidence_directory: "second", arm: "baseline", seconds: 100 },
        { evidence_directory: "first", arm: "candidate", seconds: 12 },
        { evidence_directory: "second", arm: "candidate", seconds: 101 },
        { evidence_directory: "unpaired", arm: "baseline", seconds: 500 },
    ].map(cell => ({ ...cell, task: "repair", rep: 1, success: true }));
    assert.deepEqual(pairedDifferences(cells, cell => cell.seconds), [2, 1]);
});
