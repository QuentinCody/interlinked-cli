import assert from "node:assert/strict";
import test from "node:test";
import { createLoggedClient } from "./eval-client.mjs";

test("every model request preserves version, raw response and returned-token cost", async () => {
    const saved: unknown[] = [];
    const client = createLoggedClient({ apiKey: "test-only", save: (_name, value) => saved.push(value), fetchImpl: async (_url, init) => {
        assert.equal(JSON.parse(String(init.body)).model, "jev-1.13.0");
        assert(init.signal); assert.equal(new Headers(init.headers).get("TypeSafe-Danger-Zone-Long-Context"), "true");
        return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 1000, output_tokens: 4 }, answers: {} }));
    } });
    assert((await client.askDetailed({}, {})).ok);
    assert.equal(saved.length, 1);
    const row = saved[0] as { estimatedUsd: number; costUnknown: boolean; rawResponse: string };
    assert.equal(row.estimatedUsd, 0.000042); assert.equal(row.costUnknown, false); assert(row.rawResponse.includes("1000"));
});

test("an HTTP failure without usage never masquerades as a zero-cost call", async () => {
    const saved: unknown[] = [];
    const client = createLoggedClient({ apiKey: "test-only", save: (_name, value) => saved.push(value), fetchImpl: async () => new Response("busy", { status: 429 }) });
    assert.equal((await client.askDetailed({}, {})).ok, false);
    const row = saved[0] as { estimatedUsd: number | null; costUnknown: boolean };
    assert.equal(row.estimatedUsd, null); assert.equal(row.costUnknown, true);
});
