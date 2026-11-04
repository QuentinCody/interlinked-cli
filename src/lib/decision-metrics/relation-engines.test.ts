import { afterEach, expect, test, vi } from "vitest";
import { fixtureRelationPlan } from "./relation-fixtures.js";
import { relationBackend } from "./relation-engines.js";
import { haikuAccounting, haikuCanary, runIsolatedHaiku, validateHaikuIsolation } from "./relation-haiku.js";
import type { EngineSpec } from "../../harness/semantic-graph/relation-types.js";

vi.mock("./relation-haiku.js", async importOriginal => ({ ...await importOriginal<object>(), haikuCanary: vi.fn(), runIsolatedHaiku: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
const engine: EngineSpec = { id: "H", backend: "haiku", command: "fake", endpoint: null, model: "fake", identity: "fake", effort: "low", maxCalls: 1, maxUsd: .05, timeoutMs: 1000, band: [.2,.8] };
const envelope = { argv: [], cliIdentity: "fake", events: [{ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "fake" }, { type: "result", result: '{"kind":"choice","probabilities":{"compatible":1,"contradictory":0,"insufficient_evidence":0}}', is_error: false, total_cost_usd: .04 }], exitCode: 0, timedOut: false, truncated: false };
test("canary consumes the remaining call and dollar budgets before any H assessment", async () => {
    vi.mocked(haikuCanary).mockResolvedValue({ passed: true, envelope, reason: "fixture" });
    const packet = fixtureRelationPlan([engine]).plan.jobs[0]!.packets[0]!;
    const result = await relationBackend("unused")(engine, packet, "unused");
    expect(result.calls).toBe(1); expect(result.costUsd).toBe(.04); expect(result.raw).toBeNull();
    expect(runIsolatedHaiku).not.toHaveBeenCalled();
    vi.mocked(runIsolatedHaiku).mockResolvedValue(envelope);
    await relationBackend("unused")({ ...engine, maxCalls: 2 }, packet, "unused");
    expect(vi.mocked(runIsolatedHaiku).mock.calls[0]![0].maxUsd).toBeCloseTo(.01);
});
test("J retains known usage and response when probability parsing fails", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "fixture-only");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { decision: { type: "choice", choice: "compatible", confidence: .9, probabilities: { compatible: 1 } } }, usage: { input_tokens: 123, output_tokens: 2 } }), { status: 200 })));
    const j: EngineSpec = { ...engine, id: "J", backend: "typesafe", model: "jev-test", identity: "jev-test" };
    const packet = fixtureRelationPlan([j]).plan.jobs[0]!.packets[0]!;
    const result = await relationBackend("unused")(j, packet, "unused");
    expect(result.raw).toBeNull(); expect(result.failure).not.toBeNull();
    expect(result.inputTokens).toBe(123); expect(result.costUsd).toBeGreaterThan(0); expect(result.response).toHaveProperty("result");
});

test("unknown canary spend stops H and assessment rejection preserves two attempts", async () => {
    const unpriced = structuredClone(envelope); delete (unpriced.events[1] as Record<string, unknown>).total_cost_usd;
    const packet = fixtureRelationPlan([engine]).plan.jobs[0]!.packets[0]!;
    vi.mocked(haikuCanary).mockResolvedValue({ passed: true, envelope: unpriced, reason: "fixture" });
    const unknown = await relationBackend("unused")({ ...engine, maxCalls: 2 }, packet, "unused");
    expect(unknown.costUsd).toBeNull(); expect(runIsolatedHaiku).not.toHaveBeenCalled();
    vi.mocked(haikuCanary).mockResolvedValue({ passed: true, envelope, reason: "fixture" });
    vi.mocked(runIsolatedHaiku).mockRejectedValue(new Error("transport failure"));
    const failed = await relationBackend("unused")({ ...engine, maxCalls: 2 }, packet, "unused");
    expect(failed.calls).toBe(2); expect(failed.costUsd).toBeNull(); expect(failed.response).toHaveProperty("knownPreflightCostUsd", .04);
});

test("malformed H accounting stays unavailable without coercion or negative spend", async () => {
    const malformed = structuredClone(envelope);
    Object.assign(malformed.events[1]!, { total_cost_usd: -1, usage: { input_tokens: 4, cache_read_input_tokens: "bad" } });
    expect(validateHaikuIsolation(malformed)).toMatchObject({ cost: null, tokens: null });
    for (const cost of [-1, Infinity, NaN, "0.01"]) {
        Object.assign(malformed.events[1]!, { total_cost_usd: cost });
        expect(haikuAccounting(malformed).cost).toBeNull();
    }
    Object.assign(malformed.events[1]!, { total_cost_usd: .01 });
    for (const usage of [{ input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: 1, cache_read_input_tokens: null }, { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1 }]) {
        Object.assign(malformed.events[1]!, { usage });
        expect(haikuAccounting(malformed).tokens).toBeNull();
    }
    Object.assign(malformed.events[1]!, { usage: { input_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } });
    expect(haikuAccounting(malformed)).toEqual({ cost: .01, tokens: 9 });
    // The error fallback must apply the same accounting validation.
    Object.assign(malformed.events[1]!, { total_cost_usd: -1, result: "not JSON" });
    vi.mocked(haikuCanary).mockResolvedValue({ passed: true, envelope, reason: "fixture" });
    vi.mocked(runIsolatedHaiku).mockResolvedValue(malformed);
    const packet = fixtureRelationPlan([engine]).plan.jobs[0]!.packets[0]!;
    const failed = await relationBackend("unused")({ ...engine, maxCalls: 2 }, packet, "unused");
    expect(failed.costUsd).toBeNull(); expect(failed.raw).toBeNull(); expect(failed.inputTokens).toBe(9);
});
