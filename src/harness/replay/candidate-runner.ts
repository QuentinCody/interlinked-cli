// ===========================================
// T1 candidate runner — replay an exact observation into another model
// ===========================================
// Sends a captured envelope's request — the EXACT observation the reference
// model saw — to a candidate model and returns its proposed action. Two
// documented transforms only
// (docs/design/reproducibility/tier1-teacher-forced-eval.md):
//   1. prior-turn thinking blocks are stripped by default — mirrors the
//      API's own cross-model semantics (foreign thinking blocks are dropped
//      server-side) and replay-reconstruct.mjs precedent; --keep-thinking
//      restores exact-envelope mode for same-model candidates;
//   2. the model id is replaced; `stream` is forced off (the runner wants
//      one JSON body); every other parameter rides along verbatim.
// Off-policy by construction: the candidate's action is scored, never fed
// back into the next step's observation.

import type { JsonObject } from "../../lib/json-types.js";
import type { InferenceEnvelope } from "./inference-store.js";

/** Bounds a single candidate turn. Generous — hard reference turns ran for
 *  minutes; this only stops a hung upstream from wedging an eval run. */
const CANDIDATE_TURN_TIMEOUT_MS = 600_000;

interface ProposedAction {
	tool: string | null;
	input: JsonObject | null;
}

export interface CandidateRunResult {
	raw: JsonObject;
	stop_reason: string | null;
	content: JsonObject[];
	proposed: ProposedAction;
}

function asObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

/** Remove thinking blocks from assistant turns; everything else verbatim. */
export function stripPriorThinking(messages: readonly JsonObject[]): JsonObject[] {
	return messages.map((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
		const content = (message.content as unknown[]).filter((block) => {
			const b = asObject(block);
			return b === null || (b.type !== "thinking" && b.type !== "redacted_thinking");
		});
		return { ...message, content };
	});
}

/** Build the candidate's request body from an envelope. */
export function buildCandidateRequest(
	envelope: InferenceEnvelope,
	candidateModel: string,
	opts: { keepThinking?: boolean },
): JsonObject {
	const request = envelope.request;
	const body: JsonObject = { model: candidateModel };
	if (request.system !== undefined) body.system = request.system;
	if (request.tools !== undefined) body.tools = request.tools;
	const messages = Array.isArray(request.messages) ? (request.messages as JsonObject[]) : [];
	body.messages = opts.keepThinking ? messages : stripPriorThinking(messages);
	const params = asObject(request.params) ?? {};
	for (const [key, value] of Object.entries(params)) {
		if (key === "stream") continue; // the runner needs one JSON body
		body[key] = value;
	}
	return body;
}

/** The candidate's action = its first tool_use block (the same convention the
 *  trace spine uses for the reference). Text-only responses propose nothing. */
export function extractProposedAction(content: readonly unknown[]): ProposedAction {
	for (const block of content) {
		const b = asObject(block);
		if (b && b.type === "tool_use" && typeof b.name === "string") {
			return { tool: b.name, input: asObject(b.input) };
		}
	}
	return { tool: null, input: null };
}

export interface RunCandidateArgs {
	envelope: InferenceEnvelope;
	model: string;
	baseUrl: string;
	apiKey: string | undefined;
	keepThinking?: boolean;
}

/** POST the transformed observation to the candidate and parse its proposal.
 *  Throws on transport/API failure — an eval run WANTS loud failures, unlike
 *  the capture path. */
export async function runCandidate(args: RunCandidateArgs): Promise<CandidateRunResult> {
	const version =
		typeof args.envelope.request_headers["anthropic-version"] === "string"
			? args.envelope.request_headers["anthropic-version"]
			: "2023-06-01";
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": version,
	};
	if (args.apiKey) headers["x-api-key"] = args.apiKey;

	const resp = await fetch(`${args.baseUrl}/v1/messages`, {
		method: "POST",
		headers,
		body: JSON.stringify(
			buildCandidateRequest(args.envelope, args.model, { keepThinking: args.keepThinking ?? false }),
		),
		signal: AbortSignal.timeout(CANDIDATE_TURN_TIMEOUT_MS),
	});
	const text = await resp.text();
	if (!resp.ok) {
		throw new Error(`candidate request failed (${resp.status}): ${text.slice(0, 300)}`);
	}
	const raw = asObject(JSON.parse(text)) ?? {};
	const content = Array.isArray(raw.content) ? (raw.content as JsonObject[]) : [];
	return {
		raw,
		stop_reason: typeof raw.stop_reason === "string" ? raw.stop_reason : null,
		content,
		proposed: extractProposedAction(content),
	};
}
