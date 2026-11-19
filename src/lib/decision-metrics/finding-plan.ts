import type { JevEntry, JevQuestion } from "../../harness/jev/types.js";
import { JEV_USD_PER_INPUT_TOKEN } from "../../harness/jev/client.js";
import { isJsonObject } from "../json-types.js";
import { wireArray, wireLiteral, wireNumber, wireObject, wireString } from "../value-validation.js";
import { loopbackUrl } from "./config.js";
import { FINDING_QUESTIONS, findingRequestState } from "./finding-assessment.js";
import { parseFindingBundle, type FindingBundle, type FindingPacket } from "./finding-evidence.js";
import { parseFindingQuestionProfile, type FindingQuestionProfile } from "./finding-question-profile.js";
import { digest } from "./store.js";
import type { DecisionConfig, DecisionQuestion } from "./types.js";

export interface FindingProviderSpec {
	backend: DecisionConfig["backend"];
	model: string;
	modelIdentity: string;
	url: string;
	command: string;
	adapterIdentity: string;
	timeoutMs: number;
	maxRequestBytes: number;
}
export interface FindingPlannedRequest {
	caseId: string;
	packetId: string;
	requestId: string;
	semantic: { model: string; state: JevEntry; questions: Record<string, JevQuestion> };
	wire: { kind: "http_json" | "adapter_semantic_request"; bodyJson: string | null; bytes: number | null };
	cost: { exactInputTokens: null; estimatedInputTokens: number; estimatedUsd: number | null; quoteUsd: null; estimateMethod: "utf8-bytes-divided-by-four-v1"; pricingSource: string | null };
	reason: string | null;
}
interface FindingPlanFields {
	id: string;
	bundle: FindingBundle;
	provider: FindingProviderSpec;
	selected: string[];
	omitted: string[];
	requests: FindingPlannedRequest[];
	retries: 0;
	retryScope: "orchestrator";
	adapterRetryPolicy: "requested_zero_unverified";
	network: false;
	budgetNotice: string;
	alternatives: { kind: "fewer_cases" | "explicit_source_spans"; coverageDifference: string; estimatedUsd: number | null }[];
}
export interface FindingPlanV1 extends FindingPlanFields { schema: "interlinked.finding-plan/1"; }
export interface FindingPlanV2 extends FindingPlanFields { schema: "interlinked.finding-plan/2"; profile: FindingQuestionProfile; }
export type FindingPlan = FindingPlanV1 | FindingPlanV2;

const providerShape = wireObject<FindingProviderSpec>({ backend: wireLiteral("typesafe", "ollama", "liquid", "openrouter", "perplexity"), model: wireString, modelIdentity: wireString, url: wireString, command: wireString, adapterIdentity: wireString, timeoutMs: wireNumber, maxRequestBytes: wireNumber });
const selectedShape = wireArray(wireString);

/** Price evidence covers the named published releases. Future or custom releases remain unpriced. */
export function findingInputTokenPrice(model: string): number | null {
	return ["jev-1.13.0", "jev-1.14.0"].includes(model) ? JEV_USD_PER_INPUT_TOKEN : null;
}

function validateProvider(provider: FindingProviderSpec): void {
	if (!providerShape(provider) || [provider.model, provider.modelIdentity, provider.command, provider.adapterIdentity].some(value => !value.trim())) throw new Error("Invalid finding provider identity");
	if (!Number.isSafeInteger(provider.timeoutMs) || provider.timeoutMs < 1 || provider.timeoutMs > 60000 || !Number.isSafeInteger(provider.maxRequestBytes) || provider.maxRequestBytes < 1 || provider.maxRequestBytes > 1000000) throw new Error("Invalid provider request budget");
	loopbackUrl(provider.url, provider.backend !== "ollama");
	if (provider.backend === "typesafe" && (!/^jev-\d+\.\d+\.\d+$/.test(provider.model) || provider.modelIdentity !== provider.model)) throw new Error("TypeSafe finding plans require a pinned model release");
}

function plannedRequest(packet: FindingPacket, provider: FindingProviderSpec, questions: Record<string, JevQuestion>): FindingPlannedRequest {
	const semantic = { model: provider.model, state: findingRequestState(packet), questions: structuredClone(questions) };
	const text = JSON.stringify(semantic), bytes = Buffer.byteLength(text);
	const estimatedInputTokens = Math.ceil(bytes / 4);
	const inputPrice = findingInputTokenPrice(provider.model);
	let reason = packet.missing.length || !packet.evidence.length || (packet.contract.requiresPolicy && !packet.policy) ? "missing_evidence_or_policy" : null;
	if (bytes > provider.maxRequestBytes) reason = "request_exceeds_byte_budget";
	return {
		caseId: packet.caseId, packetId: packet.id, requestId: digest({ packetId: packet.id, provider: { backend: provider.backend, model: provider.model, modelIdentity: provider.modelIdentity, url: provider.url, command: provider.command, adapterIdentity: provider.adapterIdentity }, semantic }), semantic,
		wire: provider.backend === "typesafe" ? { kind: "http_json", bodyJson: text, bytes } : { kind: "adapter_semantic_request", bodyJson: null, bytes: null },
		cost: { exactInputTokens: null, estimatedInputTokens, estimatedUsd: provider.backend === "typesafe" && inputPrice !== null ? estimatedInputTokens * inputPrice : provider.backend === "ollama" ? 0 : null, quoteUsd: null, estimateMethod: "utf8-bytes-divided-by-four-v1", pricingSource: provider.backend === "typesafe" && inputPrice !== null ? "https://docs.typesafe.ai/models" : null },
		reason,
	};
}

/** Freeze complete semantic requests locally. Byte counts are exact, token and cost figures are estimates. */
export function createFindingPlan(bundle: FindingBundle, options: { provider: FindingProviderSpec; selected?: string[]; profile?: FindingQuestionProfile }): FindingPlan {
	parseFindingBundle(bundle);
	validateProvider(options.provider);
	const profile = options.profile === undefined ? null : parseFindingQuestionProfile(options.profile);
	const selected = options.selected ?? bundle.packets.map(packet => packet.caseId);
	if (!selectedShape(selected) || new Set(selected).size !== selected.length) throw new Error("Invalid or duplicate selected case");
	if (selected.some(id => !bundle.packets.some(packet => packet.caseId === id))) throw new Error("Unknown selected case");
	const requests = bundle.packets.filter(packet => selected.includes(packet.caseId)).map(packet => plannedRequest(packet, options.provider, profile?.questions ?? FINDING_QUESTIONS));
	const fields = {
		bundle, provider: options.provider,
		selected: requests.map(request => request.caseId), omitted: bundle.packets.filter(packet => !selected.includes(packet.caseId)).map(packet => packet.caseId), requests,
		retries: 0 as const, retryScope: "orchestrator" as const, adapterRetryPolicy: "requested_zero_unverified" as const, network: false as const,
		budgetNotice: "Token and USD figures use a byte heuristic. Usage receipts supply billable tokens after execution. Monetary admission uses estimates and can exceed the allowance. Unavailable prices remain unknown. Local service charges exclude hardware costs. Adapter wire requests are retained after dispatch.",
		alternatives: [
			{ kind: "fewer_cases" as const, coverageDifference: "Use --select to replan an explicit subset. Omitted cases remain unassessed. Each request retains its own cost estimate.", estimatedUsd: null },
			{ kind: "explicit_source_spans" as const, coverageDifference: "Prepare a new bundle with explicit source symbols or line ranges, then inspect its new request identities and estimates. Reduced caller, test or policy evidence can limit the judgment or change its outcome.", estimatedUsd: null },
		],
	};
	const body = profile ? { schema: "interlinked.finding-plan/2" as const, ...fields, profile } : { schema: "interlinked.finding-plan/1" as const, ...fields };
	const plan = { id: digest(body), ...body };
	if (Buffer.byteLength(JSON.stringify(plan)) > 32000000) throw new Error("Finding plan exceeds the 32MB artifact read budget; prepare an explicitly smaller cohort or source scope");
	return plan;
}

/** Reconstruct every bound request before honoring an approval or reusing an observation. */
export function parseFindingPlan(value: unknown): FindingPlan {
	if (!isJsonObject(value) || !["interlinked.finding-plan/1", "interlinked.finding-plan/2"].includes(String(value.schema)) || !providerShape(value.provider) || !selectedShape(value.selected)) throw new Error("Invalid finding plan");
	const profile = value.schema === "interlinked.finding-plan/2" ? parseFindingQuestionProfile(value.profile) : null;
	const plan = createFindingPlan(parseFindingBundle(value.bundle), { provider: value.provider, selected: value.selected, ...(profile ? { profile } : {}) });
	if (digest(value) !== digest(plan)) throw new Error("Finding plan identity or request mismatch");
	return structuredClone(plan);
}

/** Preserve the complete shared finding questions when using an existing decision adapter. */
export function findingDecisionQuestions(questions: Record<string, JevQuestion> = FINDING_QUESTIONS): DecisionQuestion[] {
	return Object.entries(questions).map(([id, question]) => {
		if (question.type !== "choice") throw new Error("Finding adapter requires choice questions");
		return { id, kind: "choose", question: typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions), on: ["/state"], options: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])) };
	});
}
