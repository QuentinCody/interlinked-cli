import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { findingAction } from "./metrics-findings.js";
import { prepareFindingBundle } from "../lib/decision-metrics/finding-evidence.js";
import { saveImmutable } from "../lib/decision-metrics/store.js";
import { assessFindings, FINDING_QUESTIONS } from "../lib/decision-metrics/finding-assessment.js";
import { createFindingPlan } from "../lib/decision-metrics/finding-plan.js";
import { assessFindingPlan } from "../lib/decision-metrics/finding-plan-assessment.js";
import { createFindingQuestionProfile } from "../lib/decision-metrics/finding-question-profile.js";
import { Command } from "commander";
import { registerFindingCommands } from "../registrars/metrics-findings.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("dry-run performs no inference or writes and assessment saves unavailable cases", async () => {
	const root = mkdtempSync(join(tmpdir(), "finding-cli-")); roots.push(root);
	const input = join(root, "bundle.json"), output = join(root, "run.json");
	saveImmutable(input, prepareFindingBundle(process.cwd(), { cases: [{ id: "missing", family: "resource_ownership", origin: "direct", claim: "Review ownership", sources: [], missing: ["source unavailable"] }] }));
	vi.spyOn(console, "log").mockImplementation(() => {});
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(await findingAction("assess", input, { cwd: root, output, dryRun: true })).toBe(0);
	expect(() => readFileSync(output)).toThrow();
	expect(await findingAction("assess", input, { cwd: root, output })).toBe(2);
	expect(readFileSync(output, "utf8")).toContain("missing_evidence_or_policy");
	expect(fetch).not.toHaveBeenCalled();
});

it("creates a complete frozen plan locally and requires explicit allowance for a billable bundle assessment", async () => {
	const root = mkdtempSync(join(tmpdir(), "finding-plan-cli-")); roots.push(root);
	const input = join(root, "bundle.json"), planned = join(root, "plan.json"), run = join(root, "run.json");
	saveImmutable(input, prepareFindingBundle(process.cwd(), { cases: [{ id: "chosen", family: "parser_result", origin: "direct", claim: "Review parser", sources: [{ id: "source", file: "src/lib/decision-metrics/finding-contracts.ts", purpose: "source" }], missing: [] }] }));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubEnv("TYPESAFE_API_KEY", "fixture");
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(await findingAction("plan", input, { cwd: root, output: planned, select: "chosen" })).toBe(0);
	const artifact = JSON.parse(readFileSync(planned, "utf8"));
	expect(artifact).toHaveProperty("schema", "interlinked.finding-plan/1");
	expect(artifact.requests[0].wire.bodyJson).toBe(JSON.stringify(artifact.requests[0].semantic));
	expect(await findingAction("assess", input, { cwd: root, output: run })).toBe(1);
	expect(() => readFileSync(run)).toThrow();
	expect(await findingAction("assess", planned, { cwd: root, dryRun: true, output: run })).toBe(0);
	expect(fetch).not.toHaveBeenCalled();
});

it("reserves the requested output before dispatch and honors a concurrent output reservation", async () => {
	const root = mkdtempSync(join(tmpdir(), "finding-output-cli-")); roots.push(root);
	const input = join(root, "bundle.json"), planned = join(root, "plan.json"), output = join(root, "run.json");
	saveImmutable(input, prepareFindingBundle(process.cwd(), { cases: [{ id: "case", family: "parser_result", origin: "direct", claim: "Review parser", sources: [{ id: "source", file: "src/lib/decision-metrics/finding-contracts.ts", purpose: "source" }], missing: [] }] }));
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubEnv("TYPESAFE_API_KEY", "fixture");
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected dispatch"));
	expect(await findingAction("plan", input, { cwd: root, output: planned })).toBe(0);
	const plan = JSON.parse(readFileSync(planned, "utf8"));
	writeFileSync(`${output}.lock`, "{}");
	expect(await findingAction("assess", planned, { output, approvePlan: plan.id, cwd: root })).toBe(1);
	expect(fetch).not.toHaveBeenCalled();
	expect(() => readFileSync(output)).toThrow();
});

it("views a retained v1 run without a credential or inference", async () => {
	const root = mkdtempSync(join(tmpdir(), "finding-view-cli-")); roots.push(root);
	const input = join(root, "saved.json");
	const bundle = prepareFindingBundle(process.cwd(), { cases: [{ id: "missing", family: "parser_result", origin: "direct", claim: "Review parser", sources: [], missing: ["source"] }] });
	saveImmutable(input, await assessFindings(bundle, {}));
	vi.spyOn(console, "log").mockImplementation(() => {});
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(await findingAction("show", input, { cwd: root, json: true })).toBe(0);
	expect(fetch).not.toHaveBeenCalled();
});

it("prints one compact line for show --short through actual Commander and handler parsing", async () => {
	const root = mkdtempSync(join(tmpdir(), "finding-short-cli-")); roots.push(root);
	const input = join(root, "saved.json");
	const bundle = prepareFindingBundle(process.cwd(), { cases: [{ id: "missing", family: "parser_result", origin: "direct", claim: "Review parser", sources: [], missing: ["source"] }] });
	saveImmutable(input, await assessFindings(bundle, {}));
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const metrics = new Command("metrics").option("--json").option("--short");
	registerFindingCommands(metrics.command("decisions"));
	await metrics.parseAsync(["decisions", "findings", "show", input, "--short"], { from: "user" });
	expect(log).toHaveBeenCalledTimes(1);
	const summary = String(log.mock.calls[0]?.[0]);
	expect(summary).toContain("interlinked.finding-run/1");
	expect(summary).not.toContain("\n");
	expect(summary.length).toBeLessThan(200);
});

it("freezes an alternate question profile and previews plan/2 through the local CLI actions", async () => {
	const root = mkdtempSync(join(tmpdir(), "finding-profile-cli-")); roots.push(root);
	const draft = join(root, "draft.json"), profile = join(root, "profile.json"), input = join(root, "bundle.json"), output = join(root, "plan.json");
	const questions = structuredClone(FINDING_QUESTIONS);
	questions.disposition!.instructions = "Establish the premise and explicit exceptions before deciding whether supplied source violates the invariant.";
	saveImmutable(draft, { name: "premise-first", questions });
	saveImmutable(input, prepareFindingBundle(process.cwd(), { cases: [{ id: "case", family: "parser_result", origin: "direct", claim: "Review parser", sources: [], missing: ["source unavailable"] }] }));
	vi.spyOn(console, "log").mockImplementation(() => {});
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(await findingAction("questions", draft, { cwd: root, output: profile })).toBe(0);
	expect(await findingAction("plan", input, { cwd: root, questionProfile: profile, output })).toBe(0);
	const plan = JSON.parse(readFileSync(output, "utf8"));
	expect(plan.schema).toBe("interlinked.finding-plan/2");
	expect(plan.requests[0].semantic.questions.disposition.instructions).toBe(questions.disposition!.instructions);
	expect(await findingAction("show", output, { cwd: root, json: true })).toBe(0);
	expect(fetch).not.toHaveBeenCalled();
});

it("reviews a saved plan/2 run locally and preserves absent adapter confidence", async () => {
	const root = mkdtempSync(join(tmpdir(), "finding-review-cli-")); roots.push(root);
	const input = join(root, "run.json"), labels = join(root, "labels.json"), output = join(root, "review.json");
	const bundle = prepareFindingBundle(process.cwd(), { cases: [{ id: "case", family: "parser_result", origin: "direct", claim: "Review parser", sources: [{ id: "source", file: "src/lib/decision-metrics/finding-contracts.ts", purpose: "source" }], missing: [] }] });
	const plan = createFindingPlan(bundle, { provider: { backend: "openrouter", model: "fixture", modelIdentity: "fixture", command: "unused", adapterIdentity: "fixture", url: "https://example.com/v1", timeoutMs: 1000, maxRequestBytes: 200000 }, profile: createFindingQuestionProfile("review", FINDING_QUESTIONS) });
	const distributions: Record<string, Record<string, number>> = {
		disposition: { premise_wrong: 0, not_applicable: 0, explicit_exception: 0, violation: 1, insufficient_evidence: 0 },
		priority: { low: 0, material: 1, critical: 0, unknown: 0 },
	};
	const run = await assessFindingPlan(plan, { root, approvedPlanId: plan.id, provider: { unavailable: null, dispatch: async () => ({ answers: Object.entries(distributions).map(([metric, probabilities]) => ({ metric, raw: { kind: "choice" as const, probabilities }, servedModel: "fixture", adapterVersion: "fixture", requestHash: null })), servedModel: "fixture", calls: 1, costUsd: null, inputTokens: null, outputTokens: null, response: {}, failure: null, probabilitySource: "adapter_reported_distribution", wireReceipts: [] }) } });
	saveImmutable(input, run);
	saveImmutable(labels, { bundleId: bundle.id, reviewer: "source-backed fixture reviewer", labels: [{ caseId: "case", acceptable: ["violation"], rationale: "Fixture contract", evidenceIds: ["source"] }] });
	vi.spyOn(console, "log").mockImplementation(() => {});
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(await findingAction("review", input, { cwd: root, labels, output, json: true })).toBe(0);
	const result = JSON.parse(readFileSync(output, "utf8"));
	expect(result.rows[0]).toMatchObject({ comparison: "aligned", confidence: null });
	expect(result.questionProfileId).toBe(plan.schema === "interlinked.finding-plan/2" ? plan.profile.id : null);
	expect(fetch).not.toHaveBeenCalled();
});
