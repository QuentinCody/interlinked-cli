import { dirname, resolve } from "node:path";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { FINDING_MODEL, parseFindingRun } from "../lib/decision-metrics/finding-assessment.js";
import { compareFindingDecision, findingLabelTemplate, parseFindingLabels, reviewFindings, type FindingLabels } from "../lib/decision-metrics/finding-adjudication.js";
import { FINDING_CONTRACTS, FINDING_DISPOSITIONS } from "../lib/decision-metrics/finding-contracts.js";
import { parseFindingBundle, prepareFindingBundle, type FindingPacket } from "../lib/decision-metrics/finding-evidence.js";
import { discoverFindings } from "../lib/decision-metrics/finding-discovery.js";
import { digest, privateDirectory, readJson, saveImmutable } from "../lib/decision-metrics/store.js";
import { createFindingPlan, parseFindingPlan, type FindingPlan, type FindingProviderSpec } from "../lib/decision-metrics/finding-plan.js";
import { assessFindingPlan, parseFindingPlanRun, type FindingPlanRecord, type FindingPlanRun } from "../lib/decision-metrics/finding-plan-assessment.js";
import { adapterIdentity } from "../lib/decision-metrics/adapter-identity.js";
import { DEFAULT_CONFIG, parseConfig, readDecisionConfig } from "../lib/decision-metrics/config.js";
import { localModelIdentity } from "../lib/decision-metrics/runtime.js";
import { isJsonObject } from "../lib/json-types.js";
import { wireLiteral } from "../lib/value-validation.js";
import { createFindingQuestionProfile, parseFindingQuestionProfile } from "../lib/decision-metrics/finding-question-profile.js";
import { getOutputMode, output } from "../lib/output.js";

export interface FindingsOptions {
	cwd?: string;
	output?: string;
	labels?: string;
	model?: string;
	maxCalls?: string;
	maxUsd?: string;
	timeoutMs?: string;
	dryRun?: boolean;
	json?: boolean;
	short?: boolean;
	full?: boolean;
	provider?: string;
	config?: string;
	url?: string;
	command?: string;
	modelIdentity?: string;
	maxRequestBytes?: string;
	select?: string;
	approvePlan?: string;
	estimateAllowanceUsd?: string;
	reuse?: string;
	questionProfile?: string;
}

interface FindingResult { data: unknown; status: number; summary: string; shortSummary?: string; }

function bounded(value: string | undefined, fallback: number, maximum: number, name: string): number {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isFinite(result) || result < 0 || result > maximum) throw new Error(`${name} must be 0..${maximum}`);
	return result;
}

async function findingResult(action: string, input: string | undefined, options: FindingsOptions): Promise<FindingResult> {
	const root = resolve(options.cwd ?? process.cwd());
	if (action === "catalog") return { data: FINDING_CONTRACTS, status: 0, summary: `${Object.keys(FINDING_CONTRACTS).length} advisory finding contracts` };
	if (!input) throw new Error(`${action} needs an input artifact`);
	const value = readJson(resolve(root, input));
	if (action === "questions") return questionProfileResult(value);
	if (["show", "labels", "review"].includes(action)) return savedFindingResult(action, value, options);
	if (action === "discover") {
		const data = discoverFindings(root, value, { resourcePolicy: "foreground-survey" });
		return { data, status: data.notMeasured.length ? 2 : 0, summary: `${data.cases.length} advisory candidates from ${data.files} files; ${data.unresolvedCalls} unresolved calls, ${data.notMeasured.length} unavailable measurements` };
	}
	if (action === "prepare") return { data: prepareFindingBundle(root, value), status: 0, summary: "Prepared frozen finding evidence locally" };
	if (action === "plan") return { data: await planArtifact(value, options), status: 0, summary: "Prepared frozen selected requests with semantic state, questions, criteria and labeled cost estimates" };
	if (action !== "assess") throw new Error(`Unknown findings action: ${action}`);
	return assessArtifact(value, options);
}

function savedFindingResult(action: string, value: unknown, options: FindingsOptions): FindingResult {
	if (action === "show") {
		const data = retainedArtifact(value);
		return { data, status: 0, summary: JSON.stringify(data, null, 2), shortSummary: savedArtifactSummary(data) };
	}
	if (action === "labels") {
		const plan = isFindingPlan(value) ? parseFindingPlan(value) : null;
		const data = findingLabelTemplate(plan?.bundle ?? parseFindingBundle(value));
		if (plan) data.labels = data.labels.filter(label => plan.selected.includes(label.caseId));
		return { data, status: 0, summary: "Prepared blind reviewer template" };
	}
	if (!options.labels) throw new Error("review requires --labels");
	const labels = parseFindingLabels(readJson(resolve(options.cwd ?? process.cwd(), options.labels)));
	const data = isSchema(value, "interlinked.finding-run/2") ? reviewPlannedFindings(parseFindingPlanRun(value), labels) : reviewFindings(parseFindingRun(value), labels);
	return { data, status: 0, summary: `${data.population} cases: ${JSON.stringify(data.counts)}` };
}

function savedArtifactSummary(value: unknown): string {
	if (!isJsonObject(value) || typeof value.schema !== "string" || typeof value.id !== "string") throw new Error("Invalid saved finding artifact identity");
	const entries = [value.records, value.requests, value.packets].find(Array.isArray);
	const count = entries?.length ?? (isJsonObject(value.questions) ? Object.keys(value.questions).length : 0);
	return `${value.schema} id=${value.id} entries=${count}`;
}

function isSchema(value: unknown, schema: string): boolean { return isJsonObject(value) && value.schema === schema; }

function isFindingPlan(value: unknown): boolean {
	return isSchema(value, "interlinked.finding-plan/1") || isSchema(value, "interlinked.finding-plan/2");
}

function questionProfileResult(value: unknown): FindingResult {
	if (!isJsonObject(value) || typeof value.name !== "string" || Object.keys(value).length !== 2 || !Object.hasOwn(value, "questions")) throw new Error("Question drafts require only name and questions");
	const data = createFindingQuestionProfile(value.name, value.questions);
	return { data, status: 0, summary: `Frozen question profile ${data.id}. Inspect exact instructions and criteria with --json or --full` };
}

function retainedArtifact(value: unknown): unknown {
	if (isSchema(value, "interlinked.finding-run/1")) return parseFindingRun(value);
	if (isSchema(value, "interlinked.finding-run/2")) return parseFindingPlanRun(value);
	if (isFindingPlan(value)) return parseFindingPlan(value);
	if (isSchema(value, "interlinked.finding-question-profile/1")) return parseFindingQuestionProfile(value);
	return parseFindingBundle(value);
}

function findingAdapterConfig(options: FindingsOptions) {
	const root = resolve(options.cwd ?? process.cwd());
	if (options.config) return parseConfig(readJson(resolve(root, options.config)));
	if (options.provider && options.provider !== "typesafe") return readDecisionConfig(root);
	return DEFAULT_CONFIG;
}

async function providerSpec(options: FindingsOptions): Promise<FindingProviderSpec> {
	const config = findingAdapterConfig(options);
	const backend = options.provider ?? (options.config ? config.backend : "typesafe");
	if (!wireLiteral("typesafe", "ollama", "liquid", "openrouter", "perplexity")(backend)) throw new Error("Unsupported finding provider");
	const model = options.model ?? (backend === "typesafe" ? FINDING_MODEL : config.model);
	const url = options.url ?? (options.config || backend !== "typesafe" ? config.url : "https://api.typesafe.ai/v1");
	const command = options.command ?? config.command;
	const timeoutMs = bounded(options.timeoutMs, 10000, 60000, "timeout-ms");
	const maxRequestBytes = bounded(options.maxRequestBytes, config.maxRequestBytes, 1000000, "max-request-bytes");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error("Request byte and deadline budgets must be positive integers");
	const modelIdentity = await freezeModelIdentity(options.modelIdentity, backend, model, url, timeoutMs);
	return { backend, model, modelIdentity, url, command, adapterIdentity: backend === "typesafe" ? "typesafe-systemone-http-v1" : adapterIdentity(command), timeoutMs, maxRequestBytes };
}

async function freezeModelIdentity(explicit: string | undefined, backend: FindingProviderSpec["backend"], model: string, url: string, timeoutMs: number): Promise<string> {
	if (explicit !== undefined) return explicit;
	if (backend !== "ollama") return model;
	return localModelIdentity({ ...DEFAULT_CONFIG, ollamaUrl: url.replace(/\/v1\/?$/, "") }, model, Date.now() + timeoutMs);
}

function validateFrozenOptions(plan: FindingPlan, options: FindingsOptions): void {
	if (options.config || options.select !== undefined) throw new Error("Selection and configuration are frozen in this plan; prepare a new plan to change them");
	if (options.questionProfile !== undefined) throw new Error("Question profile is frozen in this plan; prepare a new plan to change it");
	for (const [name, expected] of [["provider", plan.provider.backend], ["model", plan.provider.model], ["modelIdentity", plan.provider.modelIdentity], ["url", plan.provider.url], ["command", plan.provider.command]] as const) {
		if (options[name] !== undefined && options[name] !== expected) throw new Error(`${name} differs from the approved frozen plan`);
	}
	if (options.timeoutMs !== undefined && Number(options.timeoutMs) !== plan.provider.timeoutMs) throw new Error("timeout-ms differs from the frozen plan");
	if (options.maxRequestBytes !== undefined && Number(options.maxRequestBytes) !== plan.provider.maxRequestBytes) throw new Error("max-request-bytes differs from the frozen plan");
}

async function planArtifact(value: unknown, options: FindingsOptions): Promise<FindingPlan> {
	if (isFindingPlan(value)) {
		const plan = parseFindingPlan(value);
		validateFrozenOptions(plan, options);
		return plan;
	}
	const selected = options.select?.split(",").map(value => value.trim()).filter(Boolean);
	const profile = options.questionProfile ? parseFindingQuestionProfile(readJson(resolve(options.cwd ?? process.cwd(), options.questionProfile))) : null;
	return createFindingPlan(parseFindingBundle(value), { provider: await providerSpec(options), ...(selected !== undefined ? { selected } : {}), ...(profile ? { profile } : {}) });
}

function reviewPlannedRecord(record: FindingPlanRecord, packet: FindingPacket, labels: FindingLabels) {
	const reference = labels.labels.find(label => label.caseId === record.caseId);
	if (!reference || reference.evidenceIds.some(id => !packet.evidence.some(row => row.id === id))) throw new Error("Missing label or invalid evidence citation");
	const answer = record.observation?.answers.find(answer => answer.metric === "disposition")?.raw;
	const ranked = answer?.kind === "choice" ? Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]) : [];
	const choice = ranked.length && ranked[0]![1] > ranked[1]![1] ? FINDING_DISPOSITIONS.find(value => value === ranked[0]![0]) ?? null : null;
	const comparison = record.status !== "answered" ? "unassessed" : choice ? compareFindingDecision(choice, reference.acceptable) : "uncertain";
	return {
		caseId: record.caseId, family: packet.family, status: record.status, reason: record.reason,
		comparison, choice, probabilities: answer?.kind === "choice" ? answer.probabilities : null,
		confidence: answer?.kind === "choice" ? answer.confidence ?? null : null, reference,
	};
}

function reviewPlannedFindings(run: FindingPlanRun, labels: FindingLabels) {
	if (labels.bundleId !== run.plan.bundle.id) throw new Error("Labels must name this frozen bundle");
	const packets = new Map(run.plan.bundle.packets.map(packet => [packet.caseId, packet]));
	const rows = run.records.map(record => reviewPlannedRecord(record, packets.get(record.caseId)!, labels));
	const counts: Record<string, number> = {};
	for (const row of rows) counts[row.comparison] = (counts[row.comparison] ?? 0) + 1;
	return { schema: "interlinked.finding-review/2", runId: run.id, planId: run.plan.id, questionProfileId: run.plan.schema === "interlinked.finding-plan/2" ? run.plan.profile.id : null, bundleId: run.plan.bundle.id, labelsId: digest(labels), reviewer: labels.reviewer, population: rows.length, omitted: run.plan.omitted, counts, rows };
}

/** Assessment owns network budgets and requires durable output; local actions do neither. */
async function assessArtifact(value: unknown, options: FindingsOptions): Promise<FindingResult> {
	const plan = await planArtifact(value, options);
	if (options.dryRun) return { data: plan, status: 0, summary: "Frozen requests and estimated costs only; no inference or artifact writes" };
	if (!options.output) throw new Error("assess requires --output to retain the exact observations");
	if (existsSync(resolve(options.cwd ?? process.cwd(), options.output))) throw new Error("Assessment output already exists; choose a fresh path before inference");
	const data = await assessFindingPlan(plan, {
		root: resolve(options.cwd ?? process.cwd()),
		maxCalls: bounded(options.maxCalls, 50, 200, "max-calls"),
		...(options.maxUsd !== undefined ? { maxUsd: bounded(options.maxUsd, 0.25, 10, "max-usd") } : {}),
		...(options.approvePlan !== undefined ? { approvedPlanId: options.approvePlan } : {}),
		...(options.estimateAllowanceUsd !== undefined ? { estimateAllowanceUsd: bounded(options.estimateAllowanceUsd, 0.25, 10, "estimate-allowance-usd") } : {}),
		...(options.reuse ? { reuse: parseFindingPlanRun(readJson(resolve(options.cwd ?? process.cwd(), options.reuse))) } : {}),
	});
	const answered = data.records.filter(row => row.status === "answered").length;
	return { data, status: answered === data.records.length ? 0 : 2, summary: `${answered}/${data.records.length} assessed; ${data.records.length - answered} unavailable. Advisory only.` };
}

/** This command is the only finding-review inference entrypoint; verify and hooks never invoke it. */
export async function findingAction(action: string, input: string | undefined, options: FindingsOptions): Promise<number> {
	const mode = getOutputMode(options);
	let outputClaim: string | null = null;
	try {
		if (action === "assess" && options.output && !options.dryRun) {
			const path = resolve(options.cwd ?? process.cwd(), options.output);
			privateDirectory(dirname(path));
			const claim = `${path}.lock`;
			writeFileSync(claim, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
			outputClaim = claim;
		}
		const result = await findingResult(action, input, options);
		if (options.output && !options.dryRun) {
			const path = resolve(options.cwd ?? process.cwd(), options.output);
			privateDirectory(dirname(path));
			saveImmutable(path, result.data);
		}
		output(mode, result.data, { normal: () => result.summary, short: () => result.shortSummary ?? result.summary, full: () => JSON.stringify(result.data, null, 2) });
		return result.status;
	} catch (error) {
		const message = error instanceof Error ? error.message : "finding review failed";
		output(mode, { error: message }, { normal: () => message });
		return 1;
	} finally {
		if (outputClaim) unlinkSync(outputClaim);
	}
}
