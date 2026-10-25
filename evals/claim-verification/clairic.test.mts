import assert from "node:assert/strict";
import test from "node:test";
import { spanConventions, assessAnswer, probeClairic } from "./clairic.mjs";

test("non-BMP prefix distinguishes code points, UTF-16 and UTF-8 offsets", () => {
    const source = "🧬 x";
    assert.deepEqual(spanConventions(source, [3, 4], "x"), ["utf16"]);
    assert.deepEqual(spanConventions(source, [2, 3], "x"), ["codepoints"]);
    assert.deepEqual(spanConventions(source, [5, 6], "x"), ["utf8-bytes"]);
    assert.deepEqual(spanConventions(source, [-1, 0], "x"), []);
});

test("null never falls back to a high confidence guess; malformed and truncated remain distinct", () => {
    assert.deepEqual(assessAnswer("invoice", { type: "text", value: null, guess: "invoice", confidence: 1, span: [0, 7] }), { status: "no_answer" });
    assert.equal(assessAnswer("invoice", { type: "text", value: "invoice", span: [1, 8] }).status, "invalid_span");
    assert.equal(assessAnswer("invoice", { type: "text", value: "invoice", span: [0, 7] }).status, "extracted");
    assert.equal(assessAnswer("invoice", {}).status, "malformed");
});

test("missing credentials perform no request and are never reported as a successful probe", async () => {
    let calls = 0;
    const result = await probeClairic({ token: "", account: "" }, async () => { calls++; throw new Error("unexpected request"); });
    assert.equal(calls, 0);
    assert.equal(result.status, "skipped");
});

test("API envelope, usage, original state, reported state and partial result are retained", async () => {
    const result = await probeClairic({ token: "test-credential", account: "test-account" }, async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.options?.return_state_text, true);
        const answer = { model: "clairic", answers: {}, state_text: request.state, truncated: true,
            usage: { state_tokens: 10, schema_tokens: 20, passes: 2, input_tokens: 40, output_tokens: 0 } };
        return new Response(JSON.stringify({ success: true, result: answer }), { status: 200 });
    });
    assert.equal(result.status, "completed");
    assert(result.records.length >= 3);
    assert(result.records.every(record => record.status === "partial"));
    assert(result.records.every(record => record.billingMatches === true));
    assert(!JSON.stringify(result).includes("test-credential"));
});
