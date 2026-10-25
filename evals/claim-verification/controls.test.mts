import test from "node:test";
import assert from "node:assert/strict";
import { historicalControls, eligibleEvidence } from "./controls.mjs";

test("absence and summaries are certified; arbitrary altered or retained-tail claims are not", () => {
    const rows = historicalControls("id", "The tests passed.", [{ tool: "Bash", input: "npm test", result_tail: "Tests passed.", error: false, provenance: "tool_result" }]);
    assert.deepEqual(rows.map(r => r.certified), [true, true, false, false]);
    assert.equal(rows[0]!.evidence.length, 0);
    assert.equal(rows[1]!.evidence[0]!.provenance, "assistant_summary");
    assert.equal(rows[2]!.expectedSupport, null);
});
test("provenance is enforced before retrieval, without trusting an assistant-supplied tool name", () => {
    const input = [{ tool: "Bash", input: "", result_tail: "Tests passed", error: false, provenance: "assistant_summary" },
        { tool: "Bash", input: "npm test", result_tail: "Tests failed", error: true, provenance: "tool_result" }];
    assert.deepEqual(eligibleEvidence(input), [input[1]]);
    assert.equal(eligibleEvidence([{ ...input[1]!, provenance: "unknown" }]).length, 0);
});
