import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createJevClient, type JevAskResult } from "../../harness/jev/client.js";
import type { JevResponse } from "../../harness/jev/types.js";
import { adapterIdentity } from "./adapter-identity.js";
import { parseAnswer } from "./answers.js";
import { DEFAULT_CONFIG } from "./config.js";
import { validFindingResponse } from "./finding-assessment.js";
import { findingDecisionQuestions, findingInputTokenPrice, type FindingPlannedRequest, type FindingProviderSpec } from "./finding-plan.js";
import { withLocalModel } from "./runtime.js";
import { digest, readJson } from "./store.js";
import { annotate, type BackendAnswer } from "./thinkthen.js";

export interface FindingProviderObservation {
	answers: BackendAnswer[];
	servedModel: string | null;
	response: unknown;
	calls: number;
	costUsd: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	failure: string | null;
	probabilitySource: "backend_distribution" | "adapter_reported_distribution" | "unavailable";
	wireReceipts: unknown[];
}
export interface FindingProvider {
	unavailable: string | null;
	dispatch(request: FindingPlannedRequest, folder: string): Promise<FindingProviderObservation>;
}

function typesafeAnswers(response: JevResponse | null, spec: FindingProviderSpec, request: FindingPlannedRequest, failure: string | null): BackendAnswer[] {
	return findingDecisionQuestions(request.semantic.questions).map(question => {
		const answer = response?.answers[question.id];
		const base = { metric: question.id, servedModel: response?.model ?? null, adapterVersion: spec.adapterIdentity, requestHash: digest(JSON.stringify(request.semantic)) };
		try {
			const raw = answer?.type === "choice" ? parseAnswer({ kind: "choice", probabilities: answer.probabilities, confidence: answer.confidence }, question) : null;
			return { ...base, raw, ...(failure ? { failure } : {}) };
		} catch (error) {
			return { ...base, raw: null, failure: error instanceof Error ? error.message : "invalid_backend_distribution" };
		}
	});
}

function typesafeObservation(spec: FindingProviderSpec, request: FindingPlannedRequest, requestBody: string, result: JevAskResult, calls: number): FindingProviderObservation {
	const response = result.ok ? result.response : null;
	const failure = result.ok ? (validFindingResponse(result.response, spec.model) ? null : "invalid_distribution_or_model") : result.error;
	const inputPrice = findingInputTokenPrice(spec.model);
	return {
		answers: typesafeAnswers(response, spec, request, failure),
		servedModel: response?.model ?? null, response: result, calls,
		costUsd: response && inputPrice !== null ? response.usage.input_tokens * inputPrice : calls === 0 ? 0 : null,
		inputTokens: response?.usage.input_tokens ?? null,
		outputTokens: response?.usage.output_tokens ?? null,
		failure, probabilitySource: "backend_distribution",
		wireReceipts: [{ target: `${spec.url.replace(/\/$/, "")}/systemone`, requestBody, response: result }],
	};
}

function typesafeProvider(spec: FindingProviderSpec): FindingProvider {
	const client = createJevClient({ enabled: true, model: spec.model, endpoint: `${spec.url.replace(/\/$/, "")}/systemone`, timeout_ms: spec.timeoutMs, max_spend_usd: Number.MAX_VALUE });
	return {
		unavailable: client ? null : "no_client",
		async dispatch(request) {
			if (!client) throw new Error("TypeSafe credential unavailable");
			const requestBody = JSON.stringify({ model: spec.model, state: request.semantic.state, questions: request.semantic.questions });
			if (request.wire.kind !== "http_json" || request.wire.bodyJson !== requestBody) throw new Error("Frozen TypeSafe wire body mismatch");
			const before = client.spend().calls;
			const result = await client.askDetailed(request.semantic.state, request.semantic.questions);
			return typesafeObservation(spec, request, requestBody, result, client.spend().calls - before);
		},
	};
}

async function adapterDispatch(spec: FindingProviderSpec, request: FindingPlannedRequest, folder: string): Promise<FindingProviderObservation> {
	if (adapterIdentity(spec.command) !== spec.adapterIdentity) throw new Error("Finding adapter identity changed since planning");
	const config = { ...DEFAULT_CONFIG, enabled: true, backend: spec.backend, model: spec.model, command: spec.command, url: spec.url, ollamaUrl: spec.url.replace(/\/v1\/?$/, ""), allowRemote: spec.backend !== "ollama", maxRequestBytes: spec.maxRequestBytes };
	const deadline = Date.now() + spec.timeoutMs;
	const questions = findingDecisionQuestions(request.semantic.questions);
	const dispatch = () => annotate(config, { id: request.requestId, evidence: { state: request.semantic.state } }, questions, { folder, deadline, plan: false });
	const answers = spec.backend === "ollama" ? await withLocalModel(config, spec.model, deadline, identity => {
		if (identity !== spec.modelIdentity) throw new Error("Local model identity changed since planning");
		return dispatch();
	}) : await dispatch();
	const exchanges = join(folder, "exchanges");
	const wireReceipts = existsSync(exchanges) ? readdirSync(exchanges).map(file => readJson(join(exchanges, file))) : [];
	const servedModel = answers[0]?.servedModel ?? null;
	const complete = questions.every(question => answers.some(answer => answer.metric === question.id && answer.raw !== null && !answer.failure));
	return {
		answers: answers.map(answer => ({ ...answer, adapterVersion: spec.adapterIdentity })),
		servedModel, response: answers, calls: Math.max(1, wireReceipts.length),
		costUsd: spec.backend === "ollama" ? 0 : null,
		inputTokens: null, outputTokens: null,
		failure: complete ? null : "missing_or_invalid_backend_distribution",
		probabilitySource: "adapter_reported_distribution", wireReceipts,
	};
}

/** All providers are optional. Construction never sends inference or downloads a model. */
export function findingProvider(spec: FindingProviderSpec): FindingProvider {
	if (spec.backend === "typesafe") return typesafeProvider(spec);
	let unavailable: string | null = null;
	try {
		if (adapterIdentity(spec.command) !== spec.adapterIdentity) unavailable = "adapter_identity_changed";
	} catch (error) {
		unavailable = error instanceof Error ? error.message : "adapter_unavailable";
	}
	return { unavailable, dispatch: (request, folder) => adapterDispatch(spec, request, folder) };
}
