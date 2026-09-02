// ===========================================
// G1 inference-envelope store
// ===========================================
// Append/load for `inference-envelope.v1` records — the exact model
// request/response pairs captured at the inference boundary by the proxy
// (docs/design/reproducibility/g1-inference-capture.md). The proxy appends to
// `pending.jsonl` (it knows nothing about harness sessions); the Tier-1
// trace assembler later joins envelopes to hook events by `tool_use_id`,
// stamps `session_id`/`seq`, and rewrites into per-session files.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";

export interface InferenceEnvelope {
	schema: "inference-envelope.v1";
	/** Monotonic per proxy process — proxy-local ordering only. */
	request_index: number;
	ts_request: string;
	ts_response: string;
	latency_ms: number;
	provider: "anthropic";
	/** Non-auth headers that are part of the exact input (version + beta
	 *  flags). Auth material is stripped before persistence — see
	 *  `persistableHeaders` in inference-envelope.ts. */
	request_headers: JsonObject;
	/** The EXACT request body as sent: model/system/tools/messages plus every
	 *  other parameter under `params`. */
	request: JsonObject;
	/** Reassembled (or direct-JSON) response: id, stop_reason, usage, content. */
	response: JsonObject;
	/** tool_use block ids extracted from response.content — the join key to
	 *  the hook logs. Empty for text-only turns. */
	tool_use_ids: string[];
	request_sha256: string;
	/** Stamped by the trace assembler after the tool_use_id join; null as
	 *  written by the proxy. */
	session_id: string | null;
	seq: number | null;
}

/** Resolve the capture file the proxy appends to. */
export function pendingEnvelopePath(replayDir: string): string {
	return join(replayDir, "inference", "pending.jsonl");
}

/** Append one envelope. Creates the directory on first use. Throws on I/O
 *  failure — the PROXY decides to log-and-continue (capture must never break
 *  forwarding), so the fail-open lives at the call site, not here. */
export function appendEnvelope(replayDir: string, envelope: InferenceEnvelope): void {
	const path = pendingEnvelopePath(replayDir);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(envelope)}\n`);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((e): e is string => typeof e === "string");
}

/** Validate one envelope line (`pending.jsonl` or a stamped per-session file).
 *  Exported for direct testing. `request`/`response`/`request_headers` stay
 *  at the `JsonObject` boundary — they are the EXACT, arbitrarily-shaped
 *  Anthropic API bodies (open-shaped by design; see module header). */
export function parseInferenceEnvelope(value: unknown): InferenceEnvelope | null {
	if (!isJsonObject(value)) return null;
	if (value.schema !== "inference-envelope.v1") return null;
	if (value.provider !== "anthropic") return null;
	const scalars = parseScalarFields(value);
	if (!scalars) return null;
	const { request_index, ts_request, ts_response, latency_ms, request_sha256 } = scalars;
	const objectFields = parseObjectFields(value);
	if (!objectFields) return null;
	const { request_headers, request, response } = objectFields;
	if (!isStringArray(value.tool_use_ids)) return null;
	const sessionId = value.session_id ?? null;
	if (!isNullableString(sessionId)) return null;
	const seq = value.seq ?? null;
	if (!isNullableNumber(seq)) return null;

	return {
		schema: "inference-envelope.v1",
		request_index,
		ts_request,
		ts_response,
		latency_ms,
		provider: "anthropic",
		request_headers,
		request,
		response,
		tool_use_ids: value.tool_use_ids,
		request_sha256,
		session_id: sessionId,
		seq,
	};
}

interface ScalarFields {
	request_index: number;
	ts_request: string;
	ts_response: string;
	latency_ms: number;
	request_sha256: string;
}

/** Validate + narrow the top-level scalar fields shared by every envelope. */
function parseScalarFields(value: JsonObject): ScalarFields | null {
	const { request_index, ts_request, ts_response, latency_ms, request_sha256 } = value;
	if (typeof request_index !== "number") return null;
	if (typeof ts_request !== "string" || typeof ts_response !== "string") return null;
	if (typeof latency_ms !== "number") return null;
	if (typeof request_sha256 !== "string") return null;
	return { request_index, ts_request, ts_response, latency_ms, request_sha256 };
}

interface ObjectFields {
	request_headers: JsonObject;
	request: JsonObject;
	response: JsonObject;
}

/** Validate + narrow the three `JsonObject`-shaped fields (open-shaped by
 *  design — they are the EXACT, arbitrarily-shaped Anthropic API bodies). */
function parseObjectFields(value: JsonObject): ObjectFields | null {
	const { request_headers, request, response } = value;
	if (!isJsonObject(request_headers) || !isJsonObject(request) || !isJsonObject(response)) {
		return null;
	}
	return { request_headers, request, response };
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
	return value === null || typeof value === "number";
}

/** Load every parseable envelope from a JSONL file. Tolerant: unparseable or
 *  wrong-schema lines are skipped (a torn tail write must not poison reads). */
export function loadEnvelopes(path: string): InferenceEnvelope[] {
	if (!existsSync(path)) return [];
	const out: InferenceEnvelope[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = parseInferenceEnvelope(JSON.parse(line));
			if (parsed) out.push(parsed);
		} catch (err) {
			void err; // torn tail / foreign line — skipping is this reader's contract
		}
	}
	return out;
}

/** Find the envelope whose response contains this tool_use id. The id
 *  namespace is shared with the hook logs' `tool_use_id`, which makes this
 *  the Tier-1 join. Returns the FIRST match (ids are unique per API). */
export function envelopeForToolUseId(
	envelopes: readonly InferenceEnvelope[],
	toolUseId: string,
): InferenceEnvelope | null {
	for (const e of envelopes) {
		if (e.tool_use_ids.includes(toolUseId)) return e;
	}
	return null;
}
