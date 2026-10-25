import assert from "node:assert/strict";
import test from "node:test";
import { auditTranscript } from "./evidence-audit.mjs";

test("matches saved turn numbering and separates missing results from truncated projections", () => {
    const records = [
        { type: "user", message: { role: "user", content: "Run checks." } },
        { type: "assistant", message: { content: [
            { type: "tool_use", id: "c1", name: "Bash", input: { command: "x".repeat(350) } },
            { type: "tool_use", id: "c2", name: "Bash", input: { command: "npm test" } },
        ] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "z".repeat(500) }] } },
        { type: "user", message: { role: "user", content: "Next task." } },
    ];
    const turns = auditTranscript(records.map(record => JSON.stringify(record)).join("\n"));
    const turn = turns.get(1);
    assert.equal(turn?.calls, 2);
    assert.equal(turn?.completedResults, 1);
    assert.equal(turn?.missingResults, 1);
    assert.equal(turn?.inputCharsOmittedBy300Limit, 50);
    assert.equal(turn?.resultCharsOmittedBy400Limit, 100);
});

test("more than 25 calls are counted while duplicate result observations are not double charged", () => {
    const records = [{ type: "user", message: { role: "user", content: "Start" } },
        { type: "assistant", message: { content: Array.from({ length: 27 }, (_, i) => ({ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: "npm test" } })) } },
        ...Array.from({ length: 2 }, () => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c0", content: "ok" }] } })),
    ];
    const turn = auditTranscript(records.map(record => JSON.stringify(record)).join("\n")).get(1);
    assert.equal(turn?.calls, 27);
    assert.equal(turn?.callsOmittedBy25Limit, 2);
    assert.equal(turn?.completedResults, 1);
});
