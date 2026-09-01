// ===========================================
// G1 envelope builder — exact-input capture, credential-free at rest
// ===========================================
// Assembles `inference-envelope.v1` records from the proxy's buffered request
// and reassembled response (docs/design/reproducibility/g1-inference-capture.md).
// Two invariants live here:
//   1. Credential hygiene — auth material (x-api-key, Authorization, cookies)
//      is forwarded live by the proxy but NEVER persisted; only
//      anthropic-version + anthropic-beta survive (they are part of the exact
//      input; the credential is not).
//   2. Exactness — model/system/tools/messages are stored verbatim; every
//      other body parameter is preserved under `params` so nothing is lost.

import { createHash } from "node:crypto";
import type { JsonObject } from "../../lib/json-types.js";
import type { InferenceEnvelope } from "./inference-store.js";

/** The only request headers that persist into envelopes. Everything else is
 *  either hop-by-hop, derivable, or a credential. */
const PERSISTED_HEADER_NAMES: ReadonlySet<string> = new Set([
	"anthropic-version",
	"anthropic-beta",
]);

function headerValueToString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(",");
	return null;
}

/** Project request headers down to the persistable set (case-insensitive). */
export function persistableHeaders(headers: Record<string, unknown>): JsonObject {
	const out: JsonObject = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!PERSISTED_HEADER_NAMES.has(name.toLowerCase())) continue;
		const str = headerValueToString(value);
		if (str !== null) out[name.toLowerCase()] = str;
	}
	return out;
}

interface SplitRequest {
	model: unknown;
	system: unknown;
	tools: unknown;
	messages: unknown;
	/** Every body field that is not model/system/tools/messages, verbatim. */
	params: JsonObject;
}

/** Split a Messages request body into the four load-bearing fields plus a
 *  params remainder. Lossless: split.model/system/tools/messages + params
 *  reassemble to the original body. */
export function splitRequestBody(body: JsonObject): SplitRequest {
	const params: JsonObject = {};
	for (const [k, v] of Object.entries(body)) {
		if (k === "model" || k === "system" || k === "tools" || k === "messages") continue;
		params[k] = v;
	}
	return {
		model: body.model,
		system: body.system,
		tools: body.tools,
		messages: body.messages,
		params,
	};
}

/** Collect the ids of every tool_use content block — the join key that
 *  correlates an envelope with the hook logs' `tool_use_id`. */
export function extractToolUseIds(response: JsonObject): string[] {
	const content = response.content;
	if (!Array.isArray(content)) return [];
	const ids: string[] = [];
	for (const block of content) {
		if (
			block !== null &&
			typeof block === "object" &&
			(block as JsonObject).type === "tool_use" &&
			typeof (block as JsonObject).id === "string"
		) {
			ids.push((block as JsonObject).id as string);
		}
	}
	return ids;
}

interface BuildEnvelopeInput {
	requestIndex: number;
	tsRequest: string;
	tsResponse: string;
	requestHeaders: Record<string, unknown>;
	requestBody: JsonObject;
	response: JsonObject;
}

/** Assemble one envelope. `session_id`/`seq` stay null — the Tier-1 trace
 *  assembler stamps them after the tool_use_id join. */
export function buildEnvelope(input: BuildEnvelopeInput): InferenceEnvelope {
	const split = splitRequestBody(input.requestBody);
	const request: JsonObject = { params: split.params };
	if (split.model !== undefined) request.model = split.model;
	if (split.system !== undefined) request.system = split.system;
	if (split.tools !== undefined) request.tools = split.tools;
	if (split.messages !== undefined) request.messages = split.messages;

	const latency = Date.parse(input.tsResponse) - Date.parse(input.tsRequest);
	return {
		schema: "inference-envelope.v1",
		request_index: input.requestIndex,
		ts_request: input.tsRequest,
		ts_response: input.tsResponse,
		latency_ms: Number.isFinite(latency) ? Math.max(0, latency) : 0,
		provider: "anthropic",
		request_headers: persistableHeaders(input.requestHeaders),
		request,
		response: input.response,
		tool_use_ids: extractToolUseIds(input.response),
		request_sha256: createHash("sha256").update(JSON.stringify(input.requestBody)).digest("hex"),
		session_id: null,
		seq: null,
	};
}
