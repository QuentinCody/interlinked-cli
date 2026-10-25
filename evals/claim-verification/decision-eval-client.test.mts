import assert from "node:assert/strict";
import test from "node:test";
import { validateAnswers, createDecisionClient } from "./decision-eval-client.mjs";

test("model output must cover the requested options and valid probabilities", () => {
    const questions = { q: { type: "choice" as const, instructions: "Pick", criteria: { a: "A", b: "B" } } };
    assert.throws(() => validateAnswers(questions, { q: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 } }), /options/);
    assert.throws(() => validateAnswers({ q: { type: "noul", instructions: "Yes?" } }, { q: { type: "noul", noul: 2 } }), /probability/);
    validateAnswers(questions, { q: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6 } });
});

test("client logs usage without credentials and refuses requests beyond its budget", async () => {
    const saved: unknown[] = [];
    const client = createDecisionClient({ model: "jev-1.13.0", token: "test-only-credential", remainingUsd: 0.15,
        save: (_name, value) => saved.push(value),
        fetchImpl: async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 1 } },
            usage: { input_tokens: 4_000_000, output_tokens: 0 } })) });
    await client.ask("first", {}, { q: { type: "noul", instructions: "Yes?" } });
    await assert.rejects(client.ask("second", {}, { q: { type: "noul", instructions: "Yes?" } }), /budget/);
    assert.equal(JSON.stringify(saved).includes("test-only-credential"), false);
    assert.ok(client.usage().estimatedUsd > 0.15);
});
