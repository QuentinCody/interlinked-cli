// G1 envelope builder — pins credential hygiene (auth headers NEVER persist),
// the request split (model/system/tools/messages verbatim + everything else
// under params), and tool_use_id extraction — the join key to the hook logs
// (docs/design/reproducibility/g1-inference-capture.md).

import { describe, expect, it } from "vitest";
import {
	buildEnvelope,
	extractToolUseIds,
	persistableHeaders,
	splitRequestBody,
} from "./inference-envelope.js";

describe("persistableHeaders", () => {
	it("keeps anthropic-version and anthropic-beta only", () => {
		const kept = persistableHeaders({
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "oauth-2025-04-20",
			"content-type": "application/json",
			host: "localhost:8787",
		});
		expect(kept).toEqual({
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "oauth-2025-04-20",
		});
	});

	it("NEVER persists credentials, regardless of casing", () => {
		const kept = persistableHeaders({
			"X-Api-Key": "sk-super-secret",
			Authorization: "Bearer tok",
			Cookie: "session=1",
			"Proxy-Authorization": "Basic xx",
			"anthropic-version": "2023-06-01",
		});
		expect(JSON.stringify(kept)).not.toContain("secret");
		expect(JSON.stringify(kept)).not.toContain("Bearer");
		expect(JSON.stringify(kept)).not.toContain("session=1");
		expect(kept["anthropic-version"]).toBe("2023-06-01");
	});
});

describe("splitRequestBody", () => {
	it("keeps model/system/tools/messages verbatim and folds the rest into params", () => {
		const body = {
			model: "vendor-model-v6",
			system: "be helpful",
			tools: [{ name: "Bash" }],
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 16000,
			thinking: { type: "adaptive" },
		};
		const split = splitRequestBody(body);
		expect(split.model).toBe("vendor-model-v6");
		expect(split.system).toBe("be helpful");
		expect(split.tools).toEqual([{ name: "Bash" }]);
		expect(split.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(split.params).toEqual({ max_tokens: 16000, thinking: { type: "adaptive" } });
	});
});

describe("extractToolUseIds", () => {
	it("collects every tool_use block id in order", () => {
		const ids = extractToolUseIds({
			content: [
				{ type: "text", text: "x" },
				{ type: "tool_use", id: "toolu_1", name: "Read", input: {} },
				{ type: "tool_use", id: "toolu_2", name: "Bash", input: {} },
			],
		});
		expect(ids).toEqual(["toolu_1", "toolu_2"]);
	});

	it("returns [] for text-only or malformed content", () => {
		expect(extractToolUseIds({ content: [{ type: "text", text: "hi" }] })).toEqual([]);
		expect(extractToolUseIds({})).toEqual([]);
		expect(extractToolUseIds({ content: "nope" })).toEqual([]);
	});
});

describe("buildEnvelope", () => {
	it.each([
		["invalid", "2026-07-24T12:00:00Z"],
		["2026-07-24T12:00:00Z", "invalid"],
	])("records zero latency when a timestamp cannot be parsed: %s, %s", (tsRequest, tsResponse) => {
		const envelope = buildEnvelope({ requestIndex: 1, tsRequest, tsResponse, requestHeaders: {}, requestBody: {}, response: {} });
		expect(envelope.latency_ms).toBe(0);
		expect(envelope.ts_request).toBe(tsRequest);
		expect(envelope.ts_response).toBe(tsResponse);
	});
	it("assembles a v1 envelope with sha256 and null session/seq", () => {
		const env = buildEnvelope({
			requestIndex: 3,
			tsRequest: "2026-07-24T12:00:00.000Z",
			tsResponse: "2026-07-24T12:00:02.500Z",
			requestHeaders: { "x-api-key": "sk-no", "anthropic-version": "2023-06-01" },
			requestBody: { model: "m", messages: [], max_tokens: 5 },
			response: {
				id: "msg_9",
				stop_reason: "tool_use",
				content: [{ type: "tool_use", id: "toolu_z", name: "X", input: {} }],
			},
		});
		expect(env.schema).toBe("inference-envelope.v1");
		expect(env.request_index).toBe(3);
		expect(env.latency_ms).toBe(2500);
		expect(env.request_headers).toEqual({ "anthropic-version": "2023-06-01" });
		expect(env.request.model).toBe("m");
		expect(env.request.params).toEqual({ max_tokens: 5 });
		expect(env.tool_use_ids).toEqual(["toolu_z"]);
		expect(env.request_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(env.session_id).toBeNull();
		expect(env.seq).toBeNull();
	});
});
