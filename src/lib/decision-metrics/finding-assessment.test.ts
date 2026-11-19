import { describe, expect, it } from "vitest";
import { JevClient } from "../../harness/jev/client.js";
import { assessFindings, FINDING_MODEL, parseFindingRun } from "./finding-assessment.js";
import { prepareFindingBundle } from "./finding-evidence.js";

const bundle = () => prepareFindingBundle(process.cwd(), { cases: [{ id: "case", family: "parser_result", origin: "direct", claim: "Review parsing", sources: [{ id: "source", file: "src/lib/decision-metrics/finding-contracts.ts", purpose: "source" }], missing: [] }] });
const response = (choice = "violation", confidence = 0.6) => ({ model: FINDING_MODEL, answers: { disposition: { type: "choice", choice, confidence, probabilities: { premise_wrong: 0.1, not_applicable: 0.1, explicit_exception: 0.1, violation: 0.6, insufficient_evidence: 0.1 } }, priority: { type: "choice", choice: "material", confidence: 1, probabilities: { low: 0, material: 1, critical: 0, unknown: 0 } } }, usage: { input_tokens: 100, output_tokens: 50 } });

describe("opt-in finding assessment", () => {
	it("preserves the entire distribution and binds the request to frozen evidence", async () => {
		const client = new JevClient({ apiKey: "test", fetchImpl: async () => Response.json(response()) });
		const run = await assessFindings(bundle(), { client });
		expect(run.records[0]?.status).toBe("answered");
		expect(run.records[0]?.response?.answers.disposition).toMatchObject({ confidence: 0.6, probabilities: { violation: 0.6 } });
		expect(parseFindingRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
		expect(() => parseFindingRun({ ...run, model: "changed" })).toThrow();
	});
	it.each([response("premise_wrong"), response("violation", 2), { ...response(), model: "different" }])("retains malformed observations as failures", async raw => {
		const client = new JevClient({ apiKey: "test", fetchImpl: async () => Response.json(raw) });
		const run = await assessFindings(bundle(), { client });
		expect(run.records[0]?.status).toBe("failed");
		expect(run.records[0]?.response).not.toBeNull();
	});
	it("keeps missing credentials, exhausted budgets and service failures visible", async () => {
		expect((await assessFindings(bundle(), {})).records[0]?.reason).toBe("no_client");
		const client = new JevClient({ apiKey: "test", fetchImpl: async () => new Response("", { status: 503 }) });
		expect((await assessFindings(bundle(), { client, maxCalls: 0 })).records[0]?.reason).toBe("call_budget");
		expect((await assessFindings(bundle(), { client })).records[0]?.reason).toBe("http_503");
	});
	it("does not infer an absent adopted policy", async () => {
		const evidence = prepareFindingBundle(process.cwd(), { cases: [{ id: "case", family: "core_effect", origin: "direct", claim: "Review effect", sources: [], missing: [] }] });
		const run = await assessFindings(evidence, {});
		expect(run.records[0]?.reason).toBe("missing_evidence_or_policy");
	});
});
