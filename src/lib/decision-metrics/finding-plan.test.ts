import { expect, it } from "vitest";
import { prepareFindingBundle } from "./finding-evidence.js";
import { createFindingPlan, parseFindingPlan } from "./finding-plan.js";
import { FINDING_MODEL, FINDING_QUESTIONS } from "./finding-assessment.js";
import { createFindingQuestionProfile } from "./finding-question-profile.js";

const bundle = () => prepareFindingBundle(process.cwd(), { cases: ["selected", "omitted"].map(id => ({ id, family: "parser_result", origin: "direct", claim: "Review parser", sources: [{ id: "source", file: "src/lib/decision-metrics/finding-contracts.ts", purpose: "Complete contract" }], missing: [] })) });
const provider = { backend: "typesafe" as const, model: FINDING_MODEL, modelIdentity: FINDING_MODEL, url: "https://api.typesafe.ai/v1", command: "thinkthen", adapterIdentity: "typesafe-systemone-http-v1", timeoutMs: 1000, maxRequestBytes: 200000 };

it("freezes only selected requests with exact state/questions and explicitly estimated costs", () => {
	const plan = createFindingPlan(bundle(), { provider, selected: ["selected"] });
	expect(plan.requests).toHaveLength(1);
	expect(plan.omitted).toEqual(["omitted"]);
	const request = plan.requests[0]!;
	expect(request.semantic.questions).toEqual(FINDING_QUESTIONS);
	expect(request.wire.bodyJson).toBe(JSON.stringify(request.semantic));
	expect(request.cost.exactInputTokens).toBeNull();
	expect(request.cost.quoteUsd).toBeNull();
	expect(request.cost.estimateMethod).toBe("utf8-bytes-divided-by-four-v1");
	expect(request.cost.estimatedUsd).toBeGreaterThan(0);
	expect(plan.alternatives).toEqual(expect.arrayContaining([
		expect.objectContaining({ kind: "fewer_cases", coverageDifference: expect.stringContaining("Omitted cases") }),
		expect.objectContaining({ kind: "explicit_source_spans", estimatedUsd: null }),
	]));
	expect(parseFindingPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
});

it("rejects unknown selections, changed identities and oversized requests without truncation", () => {
	expect(() => createFindingPlan(bundle(), { provider, selected: ["absent"] })).toThrow("Unknown selected case");
	const plan = createFindingPlan(bundle(), { provider });
	expect(() => parseFindingPlan({ ...plan, provider: { ...provider, modelIdentity: "changed" } })).toThrow();
	const bounded = createFindingPlan(bundle(), { provider: { ...provider, maxRequestBytes: 1 } });
	expect(bounded.requests[0]?.reason).toBe("request_exceeds_byte_budget");
	expect(bounded.requests[0]?.semantic.state).toEqual(plan.requests[0]?.semantic.state);
});

it("distinguishes unknown cloud cost and local service charges from a provider quote", () => {
	const remote = createFindingPlan(bundle(), { provider: { ...provider, backend: "openrouter", model: "pinned", modelIdentity: "pinned" } });
	expect(remote.requests[0]?.cost.estimatedUsd).toBeNull();
	expect(remote.requests[0]?.wire.kind).toBe("adapter_semantic_request");
	expect(remote.requests[0]?.wire.bodyJson).toBeNull();
	const unpriced = createFindingPlan(bundle(), { provider: { ...provider, model: "jev-99.0.0", modelIdentity: "jev-99.0.0" } });
	expect(unpriced.requests[0]?.cost.estimatedUsd).toBeNull();
	const local = createFindingPlan(bundle(), { provider: { ...provider, backend: "ollama", model: "local", modelIdentity: "local@digest", url: "http://127.0.0.1:11434/v1" } });
	expect(local.requests[0]?.cost.estimatedUsd).toBe(0);
});

it("retains plan/1 compatibility and binds alternate profile semantics independently of metadata", () => {
	const evidence = bundle();
	const legacy = createFindingPlan(evidence, { provider });
	expect(legacy.schema).toBe("interlinked.finding-plan/1");
	const profile = createFindingQuestionProfile("baseline", FINDING_QUESTIONS);
	const baseline = createFindingPlan(evidence, { provider, profile });
	const renamed = createFindingPlan(evidence, { provider, profile: createFindingQuestionProfile("renamed", FINDING_QUESTIONS) });
	expect(baseline.schema).toBe("interlinked.finding-plan/2");
	expect(baseline.id).not.toBe(renamed.id);
	expect(baseline.requests[0]?.requestId).toBe(renamed.requests[0]?.requestId);
	const questions = structuredClone(FINDING_QUESTIONS);
	questions.disposition!.instructions = "First establish the factual premise against supplied source, then assess the applicable invariant.";
	const alternate = createFindingPlan(evidence, { provider, profile: createFindingQuestionProfile("premise-first", questions) });
	expect(alternate.requests[0]?.requestId).not.toBe(baseline.requests[0]?.requestId);
	expect(alternate.requests[0]?.wire.bodyJson).toContain("First establish the factual premise");
	expect(parseFindingPlan(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
	expect(parseFindingPlan(JSON.parse(JSON.stringify(alternate)))).toEqual(alternate);
});
