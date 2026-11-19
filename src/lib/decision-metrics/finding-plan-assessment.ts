import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../json-types.js";
import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireString, wireUnknown } from "../value-validation.js";
import { parseAnswer } from "./answers.js";
import { findingDecisionQuestions, parseFindingPlan, type FindingPlan, type FindingPlannedRequest } from "./finding-plan.js";
import { findingProvider, type FindingProvider, type FindingProviderObservation } from "./finding-provider.js";
import { digest, privateDirectory, readJson, saveImmutable } from "./store.js";

export interface FindingPlanRecord {
	caseId: string;
	packetId: string;
	requestId: string;
	status: "answered" | "failed" | "unassessed";
	reason: string | null;
	cached: boolean;
	elapsedMs?: number;
	observation: FindingProviderObservation | null;
}
export interface FindingPlanSpend { calls: number; knownUsd: number; unknownCost: boolean; reservedEstimatedUsd: number; }
export interface FindingPlanRun {
	schema: "interlinked.finding-run/2";
	id: string;
	plan: FindingPlan;
	records: FindingPlanRecord[];
	spend: FindingPlanSpend;
}
interface AssessmentOptions { root: string; approvedPlanId?: string; estimateAllowanceUsd?: number; maxCalls?: number; maxUsd?: number; reuse?: FindingPlanRun; provider?: FindingProvider; }
interface Execution {
	plan: FindingPlan;
	provider: FindingProvider;
	folder: string;
	allowance: number;
	maxCalls: number;
	canDispatch: boolean;
	paid: boolean;
	priorCalls: number;
	priorUsd: number;
	spend: FindingPlanSpend;
}

const answerShape = wireObject({ metric: wireString, raw: wireUnknown, servedModel: wireNullable(wireString), adapterVersion: wireString, requestHash: wireNullable(wireString), failure: wireAbsentOptional(wireString), requestHashes: wireAbsentOptional(wireArray(wireString)), questionKey: wireAbsentOptional(wireString) });
const observationShape = wireObject({ answers: wireArray(answerShape), servedModel: wireNullable(wireString), response: wireUnknown, calls: wireNumber, costUsd: wireNullable(wireNumber), inputTokens: wireNullable(wireNumber), outputTokens: wireNullable(wireNumber), failure: wireNullable(wireString), probabilitySource: wireLiteral("backend_distribution", "adapter_reported_distribution", "unavailable"), wireReceipts: wireArray(wireUnknown) });
const recordShape = wireObject({ caseId: wireString, packetId: wireString, requestId: wireString, status: wireLiteral("answered", "failed", "unassessed"), reason: wireNullable(wireString), cached: wireBoolean, elapsedMs: wireAbsentOptional(wireNumber), observation: wireUnknown });
const spendShape = wireObject<FindingPlanSpend>({ calls: wireNumber, knownUsd: wireNumber, unknownCost: wireBoolean, reservedEstimatedUsd: wireNumber });

function parseObservation(value: unknown): FindingProviderObservation {
	if (!observationShape(value) || !Number.isSafeInteger(value.calls) || value.calls < 0) throw new Error("Invalid finding provider observation");
	if ([value.costUsd, value.inputTokens, value.outputTokens].some(n => n !== null && (!Number.isFinite(n) || n < 0))) throw new Error("Invalid finding usage");
	if ([value.inputTokens, value.outputTokens].some(n => n !== null && !Number.isSafeInteger(n))) throw new Error("Invalid finding token counts");
	const questions = findingDecisionQuestions();
	if (new Set(value.answers.map(answer => answer.metric)).size !== value.answers.length) throw new Error("Duplicate finding answer");
	const answers = value.answers.map(answer => {
		const question = questions.find(question => question.id === answer.metric);
		if (!question) throw new Error("Unexpected finding question");
		return { ...answer, raw: answer.raw === null ? null : parseAnswer(answer.raw, question) };
	});
	return { ...value, answers };
}

function answered(observation: FindingProviderObservation, plan: FindingPlan, request: FindingPlannedRequest): boolean {
	if (observation.failure !== null || observation.probabilitySource === "unavailable" || observation.servedModel !== plan.provider.model) return false;
	if (observation.answers.length !== findingDecisionQuestions(request.semantic.questions).length) return false;
	const expectedHash = request.wire.bodyJson === null ? null : digest(request.wire.bodyJson);
	return observation.answers.every(answer => answer.raw !== null && !answer.failure &&
		answer.servedModel === observation.servedModel && answer.adapterVersion === plan.provider.adapterIdentity &&
		(expectedHash === null || answer.requestHash === expectedHash));
}

function parseRecord(value: unknown, request: FindingPlannedRequest, plan: FindingPlan): FindingPlanRecord {
	if (!recordShape(value) || value.caseId !== request.caseId || value.packetId !== request.packetId || value.requestId !== request.requestId) throw new Error("Finding observation identity mismatch");
	if (value.elapsedMs !== undefined && (!Number.isFinite(value.elapsedMs) || value.elapsedMs < 0)) throw new Error("Invalid finding observation latency");
	const observation = value.observation === null ? null : parseObservation(value.observation);
	if (value.status === "answered" && (!observation || !answered(observation, plan, request) || value.reason !== null)) throw new Error("Invalid reusable finding observation");
	if (value.status !== "answered" && !value.reason) throw new Error("Unavailable findings require a reason");
	return { ...value, observation };
}

/** Validate the complete frozen plan and raw distributions before reusing a saved judgment. */
export function parseFindingPlanRun(value: unknown): FindingPlanRun {
	if (!isJsonObject(value) || value.schema !== "interlinked.finding-run/2" || !Array.isArray(value.records) || !spendShape(value.spend)) throw new Error("Invalid finding plan run");
	const { id, ...body } = value;
	if (digest(body) !== id) throw new Error("Finding plan run identity mismatch");
	const plan = parseFindingPlan(value.plan);
	if (value.records.length !== plan.requests.length) throw new Error("Incomplete finding plan run");
	const records = value.records.map((row: unknown, index: number) => parseRecord(row, plan.requests[index]!, plan));
	if (!Number.isSafeInteger(value.spend.calls) || ![value.spend.calls, value.spend.knownUsd, value.spend.reservedEstimatedUsd].every(n => Number.isFinite(n) && n >= 0)) throw new Error("Invalid finding spend");
	return { schema: "interlinked.finding-run/2", id: String(id), plan, records, spend: value.spend };
}

function exclusiveClaim(path: string, value: unknown): boolean {
	try {
		writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}

function pending(request: FindingPlannedRequest, reason: string | null): FindingPlanRecord {
	return { caseId: request.caseId, packetId: request.packetId, requestId: request.requestId, status: "unassessed", reason, cached: false, observation: null };
}

function admissionReason(request: FindingPlannedRequest, execution: Execution): string | null {
	if (request.reason) return request.reason;
	if (execution.provider.unavailable) return execution.provider.unavailable;
	if (!execution.canDispatch) return "plan_execution_reserved";
	if (execution.paid && execution.spend.unknownCost) return "unknown_prior_cost";
	const calls = execution.plan.provider.backend === "typesafe" ? 1 : findingDecisionQuestions(request.semantic.questions).length;
	if (execution.priorCalls + execution.spend.calls + calls > execution.maxCalls) return "call_budget";
	if (execution.paid && request.cost.estimatedUsd === null && execution.priorUsd + execution.spend.knownUsd >= execution.allowance) return "estimate_allowance";
	const estimate = request.cost.estimatedUsd ?? 0;
	if (execution.priorUsd + execution.spend.knownUsd + execution.spend.reservedEstimatedUsd + estimate > execution.allowance) return "estimate_allowance";
	return null;
}

async function dispatchRequest(request: FindingPlannedRequest, execution: Execution): Promise<FindingPlanRecord> {
	const reason = admissionReason(request, execution);
	if (reason) return pending(request, reason);
	const folder = join(execution.folder, request.requestId);
	privateDirectory(folder);
	const reservation = { planId: execution.plan.id, requestId: request.requestId, estimatedUsd: request.cost.estimatedUsd, exactQuoteUsd: request.cost.quoteUsd, retries: 0, retryScope: execution.plan.retryScope, adapterRetryPolicy: execution.plan.adapterRetryPolicy };
	if (!exclusiveClaim(join(folder, "reservation.json"), reservation)) return pending(request, "pending_or_uncertain_request");
	execution.spend.reservedEstimatedUsd += request.cost.estimatedUsd ?? 0;
	const record = pending(request, null);
	const started = performance.now();
	try {
		record.observation = parseObservation(await execution.provider.dispatch(request, folder));
		record.status = answered(record.observation, execution.plan, request) ? "answered" : "failed";
		record.reason = record.status === "answered" ? null : record.observation.failure ?? "invalid_distribution_or_model";
	} catch (error) {
		record.status = "failed";
		record.reason = error instanceof Error ? error.message : "provider_dispatch_failed";
	}
	record.elapsedMs = Math.round(performance.now() - started);
	execution.spend.calls += record.observation?.calls ?? 1;
	if (record.observation?.costUsd !== null && record.observation?.costUsd !== undefined) {
		execution.spend.knownUsd += record.observation.costUsd;
		execution.spend.reservedEstimatedUsd -= request.cost.estimatedUsd ?? 0;
	} else if (execution.paid) execution.spend.unknownCost = true;
	saveImmutable(join(folder, "receipt.json"), record);
	return record;
}

function usdBudget(value: number, label: string): number {
	if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error(`${label} must be 0..10 USD`);
	return value;
}

function validateAllowance(plan: FindingPlan, options: AssessmentOptions, needsDispatch: boolean): number {
	if (options.approvedPlanId !== undefined && options.approvedPlanId !== plan.id) throw new Error("Frozen plan approval does not match this plan");
	const allowance = usdBudget(options.estimateAllowanceUsd ?? options.maxUsd ?? 0.25, "Estimate allowance");
	const maximum = options.maxUsd === undefined ? allowance : usdBudget(options.maxUsd, "maxUsd");
	if (needsDispatch && plan.provider.backend !== "ollama" && options.approvedPlanId !== plan.id && options.estimateAllowanceUsd === undefined) throw new Error(`Assess requires --approve-plan ${plan.id} or an explicit --estimate-allowance-usd. Preview the frozen plan before inference.`);
	if (needsDispatch && options.approvedPlanId !== plan.id && plan.requests.some(request => !request.reason && request.cost.estimatedUsd === null)) throw new Error("Unknown provider costs require explicit frozen plan approval");
	return Math.min(allowance, maximum);
}

function retainedRecords(plan: FindingPlan, folder: string, reuse?: FindingPlanRun): Map<string, FindingPlanRecord> {
	const records = new Map<string, FindingPlanRecord>();
	const prior = reuse ? parseFindingPlanRun(reuse) : null;
	for (const request of plan.requests) {
		const receipt = join(folder, request.requestId, "receipt.json");
		if (existsSync(receipt)) records.set(request.requestId, parseRecord(readJson(receipt), request, plan));
		else {
			const row = prior?.records.find(row => row.requestId === request.requestId && row.status === "answered");
			if (row) records.set(request.requestId, parseRecord(row, request, plan));
		}
	}
	return records;
}

/** Historical accounting is loaded before admitting any request, independent of case order. */
function loadPriorSpend(execution: Execution, retained: Map<string, FindingPlanRecord>): void {
	for (const request of execution.plan.requests) {
		const folder = join(execution.folder, request.requestId);
		if (existsSync(join(folder, "receipt.json"))) {
			const row = retained.get(request.requestId)!;
			execution.priorCalls += row.observation?.calls ?? 1;
			execution.priorUsd += row.observation?.costUsd ?? 0;
			if (execution.paid && (row.observation?.costUsd === null || !row.observation)) {
				execution.spend.unknownCost = true;
				execution.spend.reservedEstimatedUsd += request.cost.estimatedUsd ?? 0;
			}
		} else if (existsSync(join(folder, "reservation.json"))) {
			execution.priorCalls++;
			execution.spend.reservedEstimatedUsd += request.cost.estimatedUsd ?? 0;
			if (execution.paid) execution.spend.unknownCost = true;
		}
	}
}

async function executeRequests(execution: Execution, reuse?: FindingPlanRun): Promise<FindingPlanRun> {
	const retained = retainedRecords(execution.plan, execution.folder, reuse);
	loadPriorSpend(execution, retained);
	const records: FindingPlanRecord[] = [];
	for (const request of execution.plan.requests) {
		const row = retained.get(request.requestId);
		records.push(row ? { ...row, cached: row.status === "answered" } : await dispatchRequest(request, execution));
	}
	const body = { schema: "interlinked.finding-run/2" as const, plan: execution.plan, records, spend: execution.spend };
	return { id: digest(body), ...body };
}

/** Reserve each request durably before dispatch. Unknown paid outcomes stop later calls and are never retried. */
export async function assessFindingPlan(input: FindingPlan, options: AssessmentOptions): Promise<FindingPlanRun> {
	const plan = parseFindingPlan(input), folder = join(options.root, ".interlinked", "finding-review", plan.id);
	privateDirectory(folder);
	saveImmutable(join(folder, "plan.json"), plan);
	const retained = retainedRecords(plan, folder, options.reuse);
	const provider = options.provider ?? findingProvider(plan.provider);
	const needsDispatch = provider.unavailable === null && plan.requests.some(request => !request.reason && !retained.has(request.requestId));
	const allowance = validateAllowance(plan, options, needsDispatch);
	const maxCalls = options.maxCalls ?? 50;
	if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 200) throw new Error("maxCalls must be 0..200");
	const claimPath = join(folder, "execution.json");
	const claimed = needsDispatch && exclusiveClaim(claimPath, { planId: plan.id, pid: process.pid, allowance, maxCalls });
	const execution: Execution = { plan, provider, folder, allowance, maxCalls, canDispatch: claimed, paid: plan.provider.backend !== "ollama", priorCalls: 0, priorUsd: 0, spend: { calls: 0, knownUsd: 0, unknownCost: false, reservedEstimatedUsd: 0 } };
	try {
		return await executeRequests(execution, options.reuse);
	} finally {
		if (claimed) unlinkSync(claimPath);
	}
}
