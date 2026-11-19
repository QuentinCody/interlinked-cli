import { afterEach, expect, it, vi } from "vitest";
import { prepareFindingBundle } from "./finding-evidence.js";
import { createFindingPlan, type FindingProviderSpec } from "./finding-plan.js";
import { findingProvider } from "./finding-provider.js";
import { FINDING_MODEL } from "./finding-assessment.js";
import { annotate } from "./thinkthen.js";
import { createFindingQuestionProfile } from "./finding-question-profile.js";
import { FINDING_QUESTIONS } from "./finding-assessment.js";

vi.mock("./thinkthen.js", () => ({ annotate: vi.fn() }));
vi.mock("./adapter-identity.js", () => ({ adapterIdentity: () => "fixture-adapter" }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const spec: FindingProviderSpec = { backend: "typesafe", model: FINDING_MODEL, modelIdentity: FINDING_MODEL, url: "https://api.typesafe.ai/v1", command: "thinkthen", adapterIdentity: "typesafe-systemone-http-v1", timeoutMs: 1000, maxRequestBytes: 200000 };
const plan = (provider = spec) => createFindingPlan(prepareFindingBundle(process.cwd(), { cases: [{ id: "case", family: "parser_result", origin: "direct", claim: "Review parser", sources: [{ id: "source", file: "src/lib/decision-metrics/finding-contracts.ts", purpose: "source" }], missing: [] }] }), { provider });

it("sends the frozen TypeSafe body and retains actual billable usage", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "fixture");
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ model: FINDING_MODEL, answers: { disposition: { type: "choice", choice: "violation", confidence: 1, probabilities: { premise_wrong: 0, not_applicable: 0, explicit_exception: 0, violation: 1, insufficient_evidence: 0 } }, priority: { type: "choice", choice: "material", confidence: 1, probabilities: { low: 0, material: 1, critical: 0, unknown: 0 } } }, usage: { input_tokens: 100, output_tokens: 12 } }));
	const frozen = plan(), provider = findingProvider(frozen.provider);
	expect(provider.unavailable).toBeNull();
	const result = await provider.dispatch(frozen.requests[0]!, "unused");
	expect(fetch.mock.calls[0]?.[1]?.body).toBe(frozen.requests[0]?.wire.bodyJson);
	expect(result).toMatchObject({ failure: null, calls: 1, inputTokens: 100, outputTokens: 12, probabilitySource: "backend_distribution" });
	expect(result.costUsd).toBeCloseTo(100 * 0.042 / 1000000);
});

it("preserves absent adapter probabilities and confidence without manufacturing a distribution", async () => {
	vi.mocked(annotate).mockResolvedValue([{ metric: "disposition", raw: null, servedModel: "pinned", adapterVersion: "fixture", requestHash: null, failure: "missing probabilities" }]);
	const frozen = plan({ ...spec, backend: "openrouter", model: "pinned", modelIdentity: "pinned", adapterIdentity: "fixture-adapter" });
	const result = await findingProvider(frozen.provider).dispatch(frozen.requests[0]!, "unused");
	expect(result.failure).toBeTruthy();
	expect(result.answers[0]?.raw).toBeNull();
	expect(result.costUsd).toBeNull();
	expect(annotate).toHaveBeenCalledWith(expect.objectContaining({ backend: "openrouter" }), expect.objectContaining({ evidence: { state: frozen.requests[0]?.semantic.state } }), expect.arrayContaining([expect.objectContaining({ id: "disposition" }), expect.objectContaining({ id: "priority" })]), expect.objectContaining({ plan: false }));
});

it("passes alternate profile wording and criteria through the existing adapter contract", async () => {
	vi.mocked(annotate).mockResolvedValue([]);
	const provider = { ...spec, backend: "openrouter" as const, model: "pinned", modelIdentity: "pinned", adapterIdentity: "fixture-adapter" };
	const questions = structuredClone(FINDING_QUESTIONS);
	questions.priority!.instructions = "Judge demonstrated behavioral impact only, conditional on an actual violation.";
	if (questions.priority!.type === "choice") questions.priority!.criteria.material = "A demonstrated failure with executable consequences.";
	const frozen = createFindingPlan(plan(provider).bundle, { provider, profile: createFindingQuestionProfile("impact", questions) });
	await findingProvider(frozen.provider).dispatch(frozen.requests[0]!, "unused");
	expect(annotate).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.arrayContaining([expect.objectContaining({ id: "priority", question: questions.priority!.instructions, options: expect.objectContaining({ material: "A demonstrated failure with executable consequences." }) })]), expect.anything());
});
