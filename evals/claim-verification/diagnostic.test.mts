import assert from "node:assert/strict";
import test from "node:test";
import { makeCells, summarizeCell, sourcePassage, receiptAt, runCells, type DiagnosticCase } from "./diagnostic.mjs";
import { JevClient } from "../../src/harness/jev/client.js";

const example: DiagnosticCase = {
    id: "short", source: "Tests pass.", sourceIdentity: "authored-test", annotation: "agent-authored development target",
    targets: [{ id: "tests", spans: [[0, 11]], expectedSupport: true, rationale: "runner passed", evidenceIds: ["call1"] }],
    operationalEvidence: [], curatedEvidence: [{ tool: "Bash", input: "npm test", result_tail: "Tests 14 passed", error: false }],
};

test("four cells vary extraction and evidence independently, without leaking labels", () => {
    const cells = makeCells(example);
    assert.equal(cells.length, 4);
    assert.deepEqual(cells.map(cell => [cell.extractor, cell.evidence, cell.state.claims.length, cell.state.evidence.length]), [
        ["legacy", "operational", 0, 0], ["legacy", "curated", 0, 1], ["manual", "operational", 1, 0], ["manual", "curated", 1, 1],
    ]);
    assert(!JSON.stringify(cells.map(cell => cell.state)).includes("expectedSupport"));
    assert(!JSON.stringify(cells.map(cell => cell.state)).includes("rationale"));
    assert.equal(sourcePassage(example.source, [[0, 11]]), "Tests pass.");
    assert.throws(() => sourcePassage(example.source, [[-1, 11]]));
    assert.throws(() => sourcePassage(example.source, [[0, 100]]));
});

test("missing candidates and failed requests cannot masquerade as unsupported claims", () => {
    const cells = makeCells(example);
    assert.equal(summarizeCell(example, cells[0]!, null)[0]?.status, "extraction_failure");
    assert.equal(summarizeCell(example, cells[3]!, null)[0]?.status, "not_measured");
    const missing = { model: "test", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
    assert.equal(summarizeCell(example, cells[3]!, missing)[0]?.status, "not_measured");
    const valid = { ...missing, answers: { k0: { type: "noul" as const, noul: 0.9 }, e0: { type: "noul" as const, noul: 0.8 } } };
    assert.equal(summarizeCell(example, cells[3]!, valid)[0]?.correctSupport, true);
    assert.equal(summarizeCell(example, cells[3]!, { ...valid, answers: { ...valid.answers, e0: { type: "noul", noul: NaN } } })[0]?.status, "not_measured");
});

test("support labels belong to the supplied evidence snapshot, not the claim's known truth", () => {
    const item: DiagnosticCase = { ...example, targets: [{ ...example.targets[0]!, expectedByEvidence: { operational: false, curated: true } }] };
    const response = { model: "test", answers: { k0: { type: "noul" as const, noul: 0.9 }, e0: { type: "noul" as const, noul: 0.9 } }, usage: { input_tokens: 0, output_tokens: 0 } };
    const cells = makeCells(item);
    assert.equal(summarizeCell(item, cells[2]!, response)[0]?.correctSupport, false);
    assert.equal(summarizeCell(item, cells[3]!, response)[0]?.correctSupport, true);
});

test("native receipts must match the cited call ID and retain full output", () => {
    const source = [
        { message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "npm test" } }] } },
        { message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "result".repeat(100), is_error: false }] } },
    ].map(row => JSON.stringify(row)).join("\n");
    assert.equal(receiptAt(source, { id: "c1", line: 1, resultLine: 2 }).result_tail.length, 600);
    assert.throws(() => receiptAt(source, { id: "wrong", line: 1, resultLine: 2 }));
    assert.throws(() => receiptAt(source, { id: "c1", line: 1, resultLine: 99 }));
});

test("live runner submits frozen states, keeps raw responses and skips empty candidate cells", async () => {
    const requests: unknown[] = [];
    const client = new JevClient({ apiKey: "synthetic-test-key", fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ model: "test", answers: { k0: { type: "noul", noul: 0.9 }, e0: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 1 } }));
    } });
    const results = await runCells(example, client);
    assert.equal(requests.length, 2);
    assert.equal(results.length, 4);
    assert.equal(results[0]?.status, "no_candidates");
    assert(results[3]?.result?.ok);
    assert(!JSON.stringify(requests).includes("rationale"));
});
