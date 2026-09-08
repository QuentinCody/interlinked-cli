import { nonNull } from "../../lib/non-null.js";
// Mutation-kill suite (wave 39) for candidate-runner.ts.
// Targets guard-class survivors (Conditional/Logical/Boolean/String mutants)
// left un-killed by the companion candidate-runner.test.ts. Each test isolates
// one boundary the companion's happy-path cases don't exercise.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import {
	buildCandidateRequest,
	extractProposedAction,
	runCandidate,
	stripPriorThinking,
} from "./candidate-runner.js";
import type { InferenceEnvelope } from "./inference-store.js";

function baseEnvelope(): InferenceEnvelope {
	return {
		schema: "inference-envelope.v1",
		request_index: 1,
		ts_request: "t0",
		ts_response: "t1",
		latency_ms: 1,
		provider: "anthropic",
		request_headers: { "anthropic-version": "2023-06-01" },
		request: {
			model: "reference-model",
			messages: [],
			params: {},
		},
		response: { id: "msg_ref", content: [] },
		tool_use_ids: [],
		request_sha256: "0".repeat(64),
		session_id: "sess",
		seq: 5,
	} as unknown as InferenceEnvelope; // SAFETY: minimal fixture; real InferenceEnvelope has more optional fields unused by candidate-runner
}

afterEach(() => {
	vi.unstubAllGlobals();
});

interface CapturedInit {
	headers: Record<string, string>;
	body: string;
}

function mockFetchOnce(status: number, bodyObj: unknown) {
	const fn = vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(bodyObj),
	}));
	vi.stubGlobal("fetch", fn);
	return fn;
}

function mockFetchError(status: number, text: string) {
	const fn = vi.fn(async () => ({
		ok: false,
		status,
		text: async () => text,
	}));
	vi.stubGlobal("fetch", fn);
	return fn;
}

function capturedInit(fn: ReturnType<typeof vi.fn>): CapturedInit {
	// SAFETY: fetch mock is called as fetch(url, init); vitest's untyped mock.calls needs this shape asserted
	const call = fn.mock.calls[0] as unknown as [string, CapturedInit] | undefined;
	if (!call) throw new Error("fetch was not called");
	return call[1];
}

describe("stripPriorThinking — asObject boundary via non-object/array blocks", () => {
	// test-contract: boundary — a non-array `content` on an assistant message
	// must short-circuit to "return message unchanged", never reach .filter().
	it("leaves an assistant message untouched when content is not an array", () => {
		// SAFETY: deliberately malformed (non-array content) to probe the guard's crash-avoidance path
		const msg = { role: "assistant", content: "plain string content" } as unknown as JsonObject;
		expect(() => stripPriorThinking([msg])).not.toThrow();
		expect(stripPriorThinking([msg])[0]).toEqual(msg);
	});

	// test-contract: invariant — only assistant-role messages get filtered;
	// a user message carrying a stray "thinking"-typed block must ride along
	// verbatim.
	it("does not touch a non-assistant message even if its content looks like thinking blocks", () => {
		// SAFETY: fixture-only shape; only role/content fields matter to stripPriorThinking
		const msg = {
			role: "user",
			content: [{ type: "thinking", thinking: "secret" }],
		} as unknown as JsonObject; // SAFETY: fixture-only shape; only role/content fields matter to stripPriorThinking
		expect(stripPriorThinking([msg])[0]).toEqual(msg);
	});

	// test-contract: boundary — a non-object array element (asObject -> null)
	// must be kept as-is by the filter, not crash on `.type` access.
	it("keeps a non-object array element in an assistant message's content", () => {
		// SAFETY: deliberately mixed content array to probe asObject(block)===null handling
		const msg = {
			role: "assistant",
			content: ["raw-non-object-element", { type: "text", text: "keep" }],
		} as unknown as JsonObject; // SAFETY: deliberately mixed content array to probe asObject(block)===null handling
		expect(() => stripPriorThinking([msg])).not.toThrow();
		const [result] = stripPriorThinking([msg]);
		// SAFETY: result is one of the fixture messages we constructed above, which are JsonObject-shaped
		expect((nonNull(result)).content).toEqual(["raw-non-object-element", { type: "text", text: "keep" }]);
	});

	// test-contract: invariant — "redacted_thinking" blocks are stripped, same
	// as plain "thinking" blocks.
	it("removes redacted_thinking blocks from assistant content", () => {
		// SAFETY: fixture-only shape; only role/content fields matter to stripPriorThinking
		const msg = {
			role: "assistant",
			content: [{ type: "redacted_thinking", data: "x" }],
		} as unknown as JsonObject; // SAFETY: fixture-only shape; only role/content fields matter to stripPriorThinking
		const [result] = stripPriorThinking([msg]);
		// SAFETY: result is one of the fixture messages we constructed above, which are JsonObject-shaped
		expect((nonNull(result)).content).toEqual([]);
	});
});

describe("buildCandidateRequest — optional system/tools fields", () => {
	// test-contract: invariant — absent `system` must not appear as an
	// explicit undefined key on the built body.
	it("omits body.system when the envelope request has no system field", () => {
		const body = buildCandidateRequest(baseEnvelope(), "candidate-y", {});
		expect("system" in body).toBe(false);
	});

	// test-contract: invariant — absent `tools` must not appear as an
	// explicit undefined key on the built body.
	it("omits body.tools when the envelope request has no tools field", () => {
		const body = buildCandidateRequest(baseEnvelope(), "candidate-y", {});
		expect("tools" in body).toBe(false);
	});
});

describe("extractProposedAction — full predicate boundary", () => {
	// test-contract: invariant — a non tool_use block must never be read as a
	// proposed action, even when it happens to carry a string `name` field.
	it("ignores a non tool_use block that happens to have a string name", () => {
		const action = extractProposedAction([{ type: "text", name: "foo" }]);
		expect(action).toEqual({ tool: null, input: null });
	});

	// test-contract: invariant — a tool_use block whose `name` is not a
	// string must not be accepted as a proposed action.
	it("ignores a tool_use block whose name is not a string", () => {
		const action = extractProposedAction([{ type: "tool_use", name: 123, input: {} }]);
		expect(action).toEqual({ tool: null, input: null });
	});
});

describe("runCandidate — anthropic-version header resolution", () => {
	// test-contract: invariant — a valid string header rides through verbatim,
	// and the request headers object is exactly {content-type, anthropic-version}.
	it("uses the envelope's anthropic-version header verbatim when present", async () => {
		const fn = mockFetchOnce(200, { content: [], stop_reason: null });
		const env = baseEnvelope();
		env.request_headers = { "anthropic-version": "2024-01-01" };
		await runCandidate({ envelope: env, model: "candidate-y", baseUrl: "http://test", apiKey: undefined });
		const init = capturedInit(fn);
		expect(init.headers["anthropic-version"]).toBe("2024-01-01");
		expect(init.headers["content-type"]).toBe("application/json");
	});

	// test-contract: boundary — a missing header must fall back to the
	// documented "2023-06-01" default, not an unresolved/undefined value.
	it("falls back to 2023-06-01 when the header is absent", async () => {
		const fn = mockFetchOnce(200, { content: [], stop_reason: null });
		const env = baseEnvelope();
		env.request_headers = {};
		await runCandidate({ envelope: env, model: "candidate-y", baseUrl: "http://test", apiKey: undefined });
		const init = capturedInit(fn);
		expect(init.headers["anthropic-version"]).toBe("2023-06-01");
	});
});

describe("runCandidate — apiKey header gating", () => {
	// test-contract: security — no apiKey means no x-api-key header at all,
	// not a header key present with an undefined value.
	it("omits x-api-key entirely when no apiKey is provided", async () => {
		const fn = mockFetchOnce(200, { content: [], stop_reason: null });
		await runCandidate({ envelope: baseEnvelope(), model: "candidate-y", baseUrl: "http://test", apiKey: undefined });
		const init = capturedInit(fn);
		expect("x-api-key" in init.headers).toBe(false);
	});
});

describe("runCandidate — keepThinking default", () => {
	// test-contract: invariant — omitting keepThinking must default to
	// stripping, mirroring buildCandidateRequest's documented default.
	it("strips thinking blocks by default when keepThinking is not passed", async () => {
		const fn = mockFetchOnce(200, { content: [], stop_reason: null });
		const env = baseEnvelope();
		// SAFETY: overwriting messages on a loosely-typed fixture request object
		(env.request).messages = [
			{ role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "s" }] },
		];
		await runCandidate({ envelope: env, model: "candidate-y", baseUrl: "http://test", apiKey: undefined });
		const init = capturedInit(fn);
		expect(init.body).not.toContain("thinking");
	});
});

describe("runCandidate — non-ok response error", () => {
	// test-contract: invariant — the thrown error must be exactly
	// "candidate request failed (<status>): <first 300 chars of body>",
	// truncated, not the full body and not swallowed.
	it("throws a truncated status+body error on a non-ok response", async () => {
		const longText = "y".repeat(500);
		mockFetchError(500, longText);
		let caught: unknown;
		try {
			await runCandidate({ envelope: baseEnvelope(), model: "candidate-y", baseUrl: "http://test", apiKey: undefined });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(Error);
		// SAFETY: guarded by the toBeInstanceOf(Error) assertion immediately above
		expect((caught as Error).message).toBe(`candidate request failed (500): ${longText.slice(0, 300)}`);
	});
});

describe("runCandidate — stop_reason type guard", () => {
	// test-contract: boundary — a non-string stop_reason must normalize to
	// null, never pass the raw non-string value through.
	it("returns null stop_reason when the raw field isn't a string", async () => {
		mockFetchOnce(200, { content: [], stop_reason: 42 });
		const result = await runCandidate({
			envelope: baseEnvelope(),
			model: "candidate-y",
			baseUrl: "http://test",
			apiKey: undefined,
		});
		expect(result.stop_reason).toBeNull();
	});
});
