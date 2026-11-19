import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FINDING_MODEL } from "./finding-assessment.js";
import { prepareFindingBundle } from "./finding-evidence.js";
import { createFindingPlan, type FindingProviderSpec } from "./finding-plan.js";
import { assessFindingPlan, parseFindingPlanRun } from "./finding-plan-assessment.js";
import type { FindingProvider, FindingProviderObservation } from "./finding-provider.js";
import { digest } from "./store.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(join(tmpdir(), "finding-plan-")); roots.push(value); return value; };
const spec: FindingProviderSpec = { backend: "typesafe", model: FINDING_MODEL, modelIdentity: FINDING_MODEL, url: "https://api.typesafe.ai/v1", command: "thinkthen", adapterIdentity: "typesafe-systemone-http-v1", timeoutMs: 1000, maxRequestBytes: 200000 };
const plan = () => createFindingPlan(prepareFindingBundle(process.cwd(), { cases: ["a", "b"].map(id => ({ id, family: "parser_result", origin: "direct", claim: "Review parser", sources: [{ id: "source", file: "src/lib/decision-metrics/finding-contracts.ts", purpose: "source" }], missing: [] })) }), { provider: spec });
const requestHash = digest(plan().requests[0]!.wire.bodyJson!);
const observation = (): FindingProviderObservation => ({ answers: [{ metric: "disposition", raw: { kind: "choice", probabilities: { premise_wrong: 0, not_applicable: 0, explicit_exception: 0, violation: 1, insufficient_evidence: 0 } }, servedModel: FINDING_MODEL, adapterVersion: spec.adapterIdentity, requestHash }, { metric: "priority", raw: { kind: "choice", probabilities: { low: 0, material: 1, critical: 0, unknown: 0 } }, servedModel: FINDING_MODEL, adapterVersion: spec.adapterIdentity, requestHash }], servedModel: FINDING_MODEL, response: { retained: true }, calls: 1, costUsd: 0.001, inputTokens: 100, outputTokens: 0, failure: null, probabilitySource: "backend_distribution", wireReceipts: [] });

it("requires frozen approval or an explicit estimate allowance before any dispatch", async () => {
	const frozen = plan(), dispatch = vi.fn().mockResolvedValue(observation());
	await expect(assessFindingPlan(frozen, { root: root(), provider: { unavailable: null, dispatch } })).rejects.toThrow("approve-plan");
	expect(dispatch).not.toHaveBeenCalled();
	await expect(assessFindingPlan(frozen, { root: root(), approvedPlanId: "different", provider: { unavailable: null, dispatch } })).rejects.toThrow("approval");
	expect(dispatch).not.toHaveBeenCalled();
});

it("reserves before dispatch, validates saved results, and reuses the same plan without charging again", async () => {
	const frozen = plan(), directory = root();
	const dispatch = vi.fn(async request => {
		const reservation = join(directory, ".interlinked", "finding-review", frozen.id, request.requestId, "reservation.json");
		expect(existsSync(reservation)).toBe(true);
		expect(JSON.parse(readFileSync(reservation, "utf8"))).toHaveProperty("estimatedUsd", request.cost.estimatedUsd);
		return observation();
	});
	const provider: FindingProvider = { unavailable: null, dispatch };
	const result = await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, provider });
	expect(result.records.map(row => row.status)).toEqual(["answered", "answered"]);
	expect(parseFindingPlanRun(JSON.parse(JSON.stringify(result)))).toEqual(result);
	const reused = await assessFindingPlan(frozen, { root: directory, provider });
	expect(dispatch).toHaveBeenCalledTimes(2);
	expect(reused.records.every(row => row.cached)).toBe(true);
	expect(reused.spend.knownUsd).toBe(0);
	expect(() => parseFindingPlanRun({ ...result, plan: { ...frozen, provider: { ...spec, modelIdentity: "changed" } } })).toThrow();
});

it("retains uncertain charged outcomes and stops later paid requests without retrying", async () => {
	const frozen = plan();
	const directory = root();
	const dispatch = vi.fn().mockRejectedValue(new Error("timeout"));
	const result = await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, provider: { unavailable: null, dispatch } });
	expect(dispatch).toHaveBeenCalledTimes(1);
	expect(result.records[0]).toMatchObject({ status: "failed", reason: "timeout" });
	expect(result.records[1]).toMatchObject({ status: "unassessed", reason: "unknown_prior_cost" });
	expect(result.spend.unknownCost).toBe(true);
	expect(result.spend.reservedEstimatedUsd).toBeGreaterThan(0);
	const resumed = await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, provider: { unavailable: null, dispatch } });
	expect(dispatch).toHaveBeenCalledTimes(1);
	expect(resumed.spend.unknownCost).toBe(true);
	expect(resumed.spend.reservedEstimatedUsd).toBeGreaterThan(0);
});

it("checks estimate allowance before the first request and retains budget exclusions", async () => {
	const frozen = plan(), dispatch = vi.fn().mockResolvedValue(observation());
	const result = await assessFindingPlan(frozen, { root: root(), estimateAllowanceUsd: 0, provider: { unavailable: null, dispatch } });
	expect(dispatch).not.toHaveBeenCalled();
	expect(result.records.every(row => row.reason === "estimate_allowance")).toBe(true);
});

it("honors an explicit max-usd stop alongside a larger estimate allowance", async () => {
	const frozen = plan(), dispatch = vi.fn().mockResolvedValue(observation());
	const result = await assessFindingPlan(frozen, { root: root(), estimateAllowanceUsd: 1, maxUsd: 0, provider: { unavailable: null, dispatch } });
	expect(dispatch).not.toHaveBeenCalled();
	expect(result.records.every(row => row.reason === "estimate_allowance")).toBe(true);
});

it("admits no unknown-price paid request under a zero monetary allowance", async () => {
	const frozen = createFindingPlan(plan().bundle, { provider: { ...spec, backend: "openrouter" } });
	const dispatch = vi.fn().mockResolvedValue(observation());
	const result = await assessFindingPlan(frozen, { root: root(), approvedPlanId: frozen.id, maxUsd: 0, provider: { unavailable: null, dispatch } });
	expect(dispatch).not.toHaveBeenCalled();
	expect(result.records.every(row => row.reason === "estimate_allowance")).toBe(true);
});

it.each(["adapter", "request"])("retains a mismatched %s binding as a failed observation", async kind => {
	const frozen = plan(), result = observation();
	if (kind === "adapter") result.answers[0]!.adapterVersion = "different";
	else result.answers[0]!.requestHash = "different";
	const run = await assessFindingPlan(frozen, { root: root(), approvedPlanId: frozen.id, provider: { unavailable: null, dispatch: vi.fn().mockResolvedValue(result) } });
	expect(run.records.every(row => row.status === "failed")).toBe(true);
});

it("reuses matching judgments across plans whose dispatch budgets changed", async () => {
	const frozen = plan(), provider = { unavailable: null, dispatch: vi.fn().mockResolvedValue(observation()) };
	const previous = await assessFindingPlan(frozen, { root: root(), approvedPlanId: frozen.id, provider });
	const revised = createFindingPlan(frozen.bundle, { provider: { ...spec, timeoutMs: 2000 } });
	const result = await assessFindingPlan(revised, { root: root(), reuse: previous, provider });
	expect(provider.dispatch).toHaveBeenCalledTimes(2);
	expect(result.records.every(row => row.cached)).toBe(true);
	expect(result.spend.calls).toBe(0);
});

it("accounts for a previous later-case charge before admitting an earlier excluded case", async () => {
	const frozen = plan();
	const directory = root(), provider = { unavailable: null, dispatch: vi.fn().mockResolvedValue(observation()) };
	const initialAllowance = frozen.requests[0]!.cost.estimatedUsd!;
	await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, estimateAllowanceUsd: initialAllowance, maxCalls: 1, provider });
	const result = await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, estimateAllowanceUsd: initialAllowance, maxCalls: 2, provider });
	expect(provider.dispatch).toHaveBeenCalledTimes(1);
	expect(result.records[1]?.reason).toBe("estimate_allowance");
});

it("keeps a crashed pending reservation uncertain and stops every later paid request", async () => {
	const frozen = plan(), directory = root(), request = frozen.requests[0]!;
	const folder = join(directory, ".interlinked", "finding-review", frozen.id, request.requestId);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "reservation.json"), JSON.stringify({ requestId: request.requestId, estimatedUsd: request.cost.estimatedUsd }));
	const dispatch = vi.fn().mockResolvedValue(observation());
	const result = await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, provider: { unavailable: null, dispatch } });
	expect(dispatch).not.toHaveBeenCalled();
	expect(result.spend.unknownCost).toBe(true);
	expect(result.records[1]?.reason).toBe("unknown_prior_cost");
});

it("allows one concurrent execution of a plan while retaining the other invocation as unavailable", async () => {
	const frozen = plan(), directory = root();
	let release: (value: FindingProviderObservation) => void = vi.fn();
	let started: () => void = vi.fn();
	const pending = new Promise<FindingProviderObservation>(resolve => { release = resolve; });
	const entered = new Promise<void>(resolve => { started = resolve; });
	const dispatch = vi.fn(async () => { started(); return pending; });
	const first = assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, provider: { unavailable: null, dispatch } });
	await entered;
	const second = await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, provider: { unavailable: null, dispatch } });
	expect(dispatch).toHaveBeenCalledTimes(1);
	expect(second.records.every(record => record.status === "unassessed")).toBe(true);
	release(observation());
	expect((await first).records.every(record => record.status === "answered")).toBe(true);
	expect(dispatch).toHaveBeenCalledTimes(2);
});

it("retains dispatch latency, preserves it on reuse and reads old records with unknown latency", async () => {
	const frozen = plan(), directory = root();
	const dispatch = vi.fn().mockResolvedValue(observation());
	const clock = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(147).mockReturnValueOnce(200).mockReturnValueOnce(255);
	const run = await assessFindingPlan(frozen, { root: directory, approvedPlanId: frozen.id, provider: { unavailable: null, dispatch } });
	expect(run.records.map(row => row.elapsedMs)).toEqual([47, 55]);
	const reused = await assessFindingPlan(frozen, { root: directory, provider: { unavailable: null, dispatch } });
	expect(reused.records.map(row => row.elapsedMs)).toEqual([47, 55]);
	expect(clock).toHaveBeenCalledTimes(4);
	const { id: _id, ...body } = run;
	const oldBody = { ...body, records: body.records.map(({ elapsedMs: _elapsed, ...row }) => row) };
	const old = { id: digest(oldBody), ...oldBody };
	expect(parseFindingPlanRun(old).records.every(row => !Object.hasOwn(row, "elapsedMs"))).toBe(true);
	for (const elapsedMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
		const invalidBody = { ...oldBody, records: [{ ...old.records[0], elapsedMs }, old.records[1]] };
		expect(() => parseFindingPlanRun({ id: digest(invalidBody), ...invalidBody })).toThrow();
	}
});

it("retains elapsed time for failed dispatches", async () => {
	const frozen = plan();
	vi.spyOn(performance, "now").mockReturnValueOnce(5).mockReturnValueOnce(29);
	const run = await assessFindingPlan(frozen, { root: root(), approvedPlanId: frozen.id, provider: { unavailable: null, dispatch: vi.fn().mockRejectedValue(new Error("timeout")) } });
	expect(run.records[0]).toMatchObject({ status: "failed", elapsedMs: 24 });
	expect(run.plan.id).toBe(frozen.id);
	expect(run.plan.requests.map(row => row.requestId)).toEqual(frozen.requests.map(row => row.requestId));
});
