import assert from "node:assert/strict";
import test from "node:test";
import { replayReceipt } from "./graph-replay.mjs";

test("snapshot equality and a passing runner do not establish complete current-state evidence", () => {
    const saved = { before: { "a.test.ts": "a".repeat(64) }, after: { "a.test.ts": "a".repeat(64) }, sourceStable: true,
        receipt: { id: "saved", completion: "completed" as const, sourceIdentity: "revision", selection: ["a.test.ts"],
            runner: { success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 } } };
    const result = replayReceipt(saved, saved.before);
    assert.equal(result.assessment.status, "not_assessable");
    assert.deepEqual(result.knownChangedInputs, []);
    assert.equal(result.graph.edges.filter(e => e.kind === "used" && e.basis === "observed").length, 0);
    const changed = replayReceipt(saved, { "a.test.ts": "b".repeat(64) });
    assert.deepEqual(changed.knownChangedInputs, ["a.test.ts"]);
    assert.equal(changed.assessment.status, "not_assessable");
});
