import { describe, expect, it } from "vitest";
import {
	capToolUseResult,
	MAX_TOOL_USE_RESULT_BYTES,
	parseTranscriptEntry,
	parseTranscriptText,
	readUsage,
} from "./transcript-record.js";

// A minimal valid assistant entry with the given content blocks.
function assistant(content: unknown[], model = "claude-test-5") {
	return {
		type: "assistant",
		uuid: "u-assistant",
		timestamp: "2026-06-28T12:24:50.271Z",
		sessionId: "sess-1",
		cwd: "/repo",
		gitBranch: "main",
		version: "2.1.0",
		message: { role: "assistant", model, content },
	};
}

function user(content: unknown) {
	return {
		type: "user",
		uuid: "u-user",
		timestamp: "2026-06-28T12:24:49.000Z",
		sessionId: "sess-1",
		message: { role: "user", content },
	};
}

describe("parseTranscriptEntry — positive cases", () => {
	it("emits an agent_message for an assistant text block, labeled with the model", () => {
		const recs = parseTranscriptEntry(assistant([{ type: "text", text: "This is squarely a test." }]));
		expect(recs).toHaveLength(1);
		const r = recs[0];
		expect(r?.category).toBe("agent_message");
		expect(r?.role).toBe("assistant");
		expect(r?.model).toBe("claude-test-5");
		expect(r?.text).toBe("This is squarely a test.");
		expect(r?.scrubbed).toBe(true);
		expect(r?.git_branch).toBe("main");
		expect(r?.schema).toBe("timeline.v1");
		expect(r?.provider).toBe("claude-code");
	});

	it("emits an agent_thinking record for a thinking block", () => {
		const recs = parseTranscriptEntry(assistant([{ type: "thinking", thinking: "let me reason" }]));
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("agent_thinking");
		expect(recs[0]?.text).toBe("let me reason");
		expect(recs[0]?.role).toBe("assistant");
		expect(recs[0]?.scrubbed).toBe(true);
	});

	it("emits a tool_use record carrying name, input, and id", () => {
		const recs = parseTranscriptEntry(
			assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
		);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("tool_use");
		expect(recs[0]?.tool_name).toBe("Bash");
		expect(recs[0]?.tool_use_id).toBe("toolu_1");
		expect(recs[0]?.tool_input).toEqual({ command: "ls" });
		expect(recs[0]?.role).toBe("assistant");
	});

	it("emits a user_prompt for a bare-string user message", () => {
		const recs = parseTranscriptEntry(user("hello there"));
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("user_prompt");
		expect(recs[0]?.role).toBe("user");
		expect(recs[0]?.text).toBe("hello there");
		expect(recs[0]?.scrubbed).toBe(true);
	});

	it("emits a tool_result (with is_error) from a user content array", () => {
		const recs = parseTranscriptEntry(
			user([{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "boom" }]),
		);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("tool_result");
		expect(recs[0]?.tool_use_id).toBe("toolu_1");
		expect(recs[0]?.is_error).toBe(true);
		expect(recs[0]?.text).toBe("boom");
		expect(recs[0]?.role).toBe("user");
	});

	it("emits a user_prompt for a text block inside a user content array", () => {
		const recs = parseTranscriptEntry(user([{ type: "text", text: "array-form prompt" }]));
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("user_prompt");
		expect(recs[0]?.text).toBe("array-form prompt");
		expect(recs[0]?.role).toBe("user");
		expect(recs[0]?.scrubbed).toBe(true);
	});

	it("flattens a tool_result content array of mixed block shapes via blockText", () => {
		const recs = parseTranscriptEntry(
			user([
				{
					type: "tool_result",
					tool_use_id: "toolu_2",
					content: ["plain string element", { text: "block with text" }, { type: "other" }, 42],
				},
			]),
		);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.text).toBe("plain string element\nblock with text");
	});

	it("carries a sidechain entry's agentId as agent_id (subagent attribution)", () => {
		const entry = {
			...assistant([{ type: "text", text: "subagent result" }]),
			agentId: "af2124f",
			isSidechain: true,
		};
		const recs = parseTranscriptEntry(entry);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.agent_id).toBe("af2124f");
	});

	it("leaves agent_id undefined for main-session entries (JSON round-trip drops it)", () => {
		const recs = parseTranscriptEntry(assistant([{ type: "text", text: "main turn" }]));
		expect(recs[0]?.agent_id).toBeUndefined();
		expect(JSON.parse(JSON.stringify(recs[0]))).not.toHaveProperty("agent_id");
	});

	it("decomposes a multi-block assistant turn into ordered records (seq = block index)", () => {
		const recs = parseTranscriptEntry(
			assistant([
				{ type: "text", text: "first I'll explain" },
				{ type: "tool_use", id: "toolu_9", name: "Read", input: {} },
			]),
		);
		expect(recs.map((r) => r.category)).toEqual(["agent_message", "tool_use"]);
		expect(recs.map((r) => r.seq)).toEqual([0, 1]);
		// uuid#seq is the stable dedup key
		expect(`${recs[0]?.uuid}#${recs[0]?.seq}`).toBe("u-assistant#0");
		expect(`${recs[1]?.uuid}#${recs[1]?.seq}`).toBe("u-assistant#1");
	});
});

describe("parseTranscriptEntry — negative cases (must produce no records)", () => {
	it("drops an entry missing uuid", () => {
		expect(parseTranscriptEntry({ type: "assistant", timestamp: "t", sessionId: "s", message: { content: [] } })).toEqual(
			[],
		);
	});

	it("drops an entry missing a timestamp", () => {
		expect(parseTranscriptEntry({ type: "assistant", uuid: "x", sessionId: "s", message: { content: [] } })).toEqual([]);
	});

	it("drops a non-user/assistant entry type (system, mode, …)", () => {
		expect(parseTranscriptEntry({ type: "system", uuid: "x", timestamp: "t", sessionId: "s" })).toEqual([]);
	});

	it("drops a whitespace-only assistant text block", () => {
		expect(parseTranscriptEntry(assistant([{ type: "text", text: "   \n  " }]))).toEqual([]);
	});

	it("drops non-object input", () => {
		expect(parseTranscriptEntry(null)).toEqual([]);
		expect(parseTranscriptEntry(42)).toEqual([]);
		expect(parseTranscriptEntry("a string")).toEqual([]);
	});
});

describe("parseTranscriptText", () => {
	it.each([
		{ field: "timestamp", value: 123 },
		{ field: "uuid", value: { id: "bad" } },
		{ field: "sessionId", value: true },
	])("rejects a non-string $field from JSONL while preserving the next valid entry", ({ field, value }) => {
		const malformed = { ...assistant([{ type: "text", text: "invalid entry" }]), [field]: value };
		const valid = user("next valid prompt");
		const records = parseTranscriptText([JSON.stringify(malformed), JSON.stringify(valid)].join("\n"));
		expect(records.map((record) => record.text)).toEqual(["next valid prompt"]);
	});

	it("parses multiple JSONL lines and preserves file order", () => {
		const lines = [
			JSON.stringify(user("a question")),
			JSON.stringify(assistant([{ type: "text", text: "an answer" }])),
		].join("\n");
		const recs = parseTranscriptText(lines);
		expect(recs.map((r) => r.category)).toEqual(["user_prompt", "agent_message"]);
	});

	it("skips blank and truncated/non-JSON lines without throwing", () => {
		const lines = ["", "  ", "{not valid json", JSON.stringify(assistant([{ type: "text", text: "ok" }])), "{trailing"].join(
			"\n",
		);
		const recs = parseTranscriptText(lines);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("agent_message");
	});
});

describe("malformed transcript metadata", () => {
	it("omits wrong-type optional metadata without discarding valid assistant text", () => {
		const entry = {
			...assistant([]),
			agentId: 1, cwd: false, gitBranch: [], version: {}, isSidechain: "true",
			promptId: 2, requestId: {}, effort: 3, permissionMode: true, attributionAgent: [],
			message: { model: {}, content: [{ type: "text", text: "valid text" }] },
		};
		expect(parseTranscriptText(JSON.stringify(entry))).toEqual([{
			schema: "timeline.v1", ts: entry.timestamp, session: entry.sessionId,
			uuid: entry.uuid, provider: "claude-code", seq: 0,
			category: "agent_message", role: "assistant", text: "valid text", scrubbed: true,
		}]);
	});

	it("keeps unknown tool input and block indexes while omitting malformed optional names and IDs", () => {
		const input = [null, { nested: [1, "value"] }];
		const records = parseTranscriptEntry(assistant([
			null,
			[],
			{ type: "tool_use", id: 123, name: {}, input },
			{ type: "tool_use", id: "", name: "", input: null },
			{ type: "text", text: "after tools" },
		]));
		expect(records.map((record) => record.seq)).toEqual([2, 3, 4]);
		expect(records[0]?.tool_input).toBe(input);
		expect(records[0]).not.toHaveProperty("tool_use_id");
		expect(records[0]).not.toHaveProperty("tool_name");
		expect(records[1]).toMatchObject({ tool_use_id: "", tool_name: "", tool_input: null });
	});

	it("keeps tool results while omitting malformed optional identifiers, flags, and denial metadata", () => {
		const toolUseResult = { output: [1, null, { ok: true }] };
		const records = parseTranscriptEntry({
			...user([{ type: "tool_result", tool_use_id: {}, is_error: "false",
				content: ["raw", null, [], { text: 3 }, { text: "result" }] }]),
			toolUseResult,
			toolDenialKind: { reason: "bad" },
		});
		expect(records).toHaveLength(1);
		expect(records[0]?.text).toBe("raw\nresult");
		expect(records[0]?.tool_use_result).toBe(toolUseResult);
		expect(records[0]).not.toHaveProperty("tool_use_id");
		expect(records[0]).not.toHaveProperty("is_error");
		expect(records[0]).not.toHaveProperty("tool_denial_kind");
	});

	it.each([null, [], "message", 7])("rejects a non-object message without throwing: %j", (message) => {
		expect(parseTranscriptEntry({ ...assistant([]), message })).toEqual([]);
		expect(readUsage(message)).toBeNull();
	});
});

describe("entry-level metadata capture — positive (must record)", () => {
	it("P1: carries sidechain, prompt/request ids, effort, permission mode and attribution", () => {
		const recs = parseTranscriptEntry({
			...assistant([{ type: "text", text: "hello" }]),
			isSidechain: true,
			agentId: "a99a0410",
			promptId: "p-1",
			requestId: "req_abc",
			effort: "high",
			permissionMode: "bypassPermissions",
			attributionAgent: "general-purpose",
		});
		expect(recs[0]).toMatchObject({
			is_sidechain: true,
			agent_id: "a99a0410",
			prompt_id: "p-1",
			request_id: "req_abc",
			effort: "high",
			permission_mode: "bypassPermissions",
			attribution_agent: "general-purpose",
		});
	});

	it("P2: attaches token usage to the first record of an assistant entry only", () => {
		const content = [
			{ type: "text", text: "thinking out loud" },
			{ type: "tool_use", name: "Bash", id: "toolu_1", input: {} },
		];
		const recs = parseTranscriptEntry({
			...assistant(content),
			message: {
				role: "assistant",
				model: "claude-test-5",
				usage: { input_tokens: 3, output_tokens: 90, cache_read_input_tokens: 1200 },
				content,
			},
		});
		expect(recs[0]?.usage).toEqual({
			input: 3,
			output: 90,
			cache_read: 1200,
			cache_creation: undefined,
		});
		expect(recs[1]?.usage).toBeUndefined();
	});

	it("P3: records the structural toolUseResult and the denial kind on tool_result rows", () => {
		const recs = parseTranscriptEntry({
			...user([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]),
			toolUseResult: { stdout: "ok", exitCode: 0 },
			toolDenialKind: "permission",
		});
		expect(recs[0]?.tool_use_result).toEqual({ stdout: "ok", exitCode: 0 });
		expect(recs[0]?.tool_denial_kind).toBe("permission");
		expect(recs[0]?.tool_use_result_truncated).toBeUndefined();
	});

	it("P4: truncates an oversized structural result and marks it", () => {
		const recs = parseTranscriptEntry({
			...user([{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]),
			toolUseResult: { blob: "x".repeat(MAX_TOOL_USE_RESULT_BYTES + 100) },
		});
		expect(recs[0]?.tool_use_result_truncated).toBe(true);
		expect(String(recs[0]?.tool_use_result)).toHaveLength(MAX_TOOL_USE_RESULT_BYTES + 1);
	});
});

describe("entry-level metadata capture — negative (must not invent)", () => {
	it("N1: absent metadata leaves the fields off the record entirely", () => {
		const recs = parseTranscriptEntry(assistant([{ type: "text", text: "plain" }]));
		expect(recs[0]?.is_sidechain).toBeUndefined();
		expect(recs[0]?.prompt_id).toBeUndefined();
		expect(recs[0]?.usage).toBeUndefined();
	});

	it("N2: a non-object usage payload yields no usage", () => {
		expect(readUsage({ role: "assistant", usage: "lots" })).toBeNull();
		expect(readUsage({ role: "assistant", usage: [1, 2] })).toBeNull();
	});

	it("N3: usage with no recognized numeric field yields null", () => {
		expect(readUsage({ role: "assistant", usage: { service_tier: "standard" } })).toBeNull();
	});

	it("N4: a structural result is not attached to non-tool_result rows", () => {
		const recs = parseTranscriptEntry({
			...assistant([{ type: "text", text: "hi" }]),
			toolUseResult: { stdout: "ok" },
		});
		expect(recs[0]?.tool_use_result).toBeUndefined();
	});

	it("N5: an unserializable structural result records nothing rather than throwing", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(capToolUseResult(circular)).toBeNull();
		expect(capToolUseResult(undefined)).toBeNull();
		expect(capToolUseResult(null)).toBeNull();
	});
});

describe("userRecords — array-form branch-guard edge cases", () => {
	it("P1: a whitespace-only bare-string user prompt produces no record", () => {
		expect(parseTranscriptEntry(user("   "))).toEqual([]);
	});

	it("P2: non-array non-string content (e.g. a bare number) produces no record and does not throw", () => {
		expect(() => parseTranscriptEntry(user(42))).not.toThrow();
		expect(parseTranscriptEntry(user(42))).toEqual([]);
	});

	it("P3: a block whose type isn't \"text\" but whose text field is a real string is not treated as a prompt", () => {
		// Exercises the AND (not OR) between the type check and the text check.
		expect(parseTranscriptEntry(user([{ type: "not-text", text: "hello world" }]))).toEqual([]);
	});

	it("P4: a null content element is skipped safely (b?.type never throws on null)", () => {
		expect(() => parseTranscriptEntry(user([null]))).not.toThrow();
		expect(parseTranscriptEntry(user([null]))).toEqual([]);
	});

	it("P5: a text block with no text field at all is skipped safely (no throw)", () => {
		expect(() => parseTranscriptEntry(user([{ type: "text" }]))).not.toThrow();
		expect(parseTranscriptEntry(user([{ type: "text" }]))).toEqual([]);
	});

	it("P6: a whitespace-only text block inside the array form produces no record", () => {
		expect(parseTranscriptEntry(user([{ type: "text", text: "   " }]))).toEqual([]);
	});

	it("P7: a block whose type is neither \"text\" nor \"tool_result\" produces no record", () => {
		expect(parseTranscriptEntry(user([{ type: "other" }]))).toEqual([]);
	});

	it("P8: a tool_result block with no is_error field defaults is_error to false", () => {
		const recs = parseTranscriptEntry(user([{ type: "tool_result", tool_use_id: "tr1", content: "ok" }]));
		expect(recs[0]?.is_error).toBe(false);
	});

	it("P9: a tool_result whose content flattens to an empty string leaves text undefined (not an empty string)", () => {
		const recs = parseTranscriptEntry(user([{ type: "tool_result", tool_use_id: "tr1", content: "" }]));
		expect(recs[0]?.text).toBeUndefined();
	});

	it("P10: a null element inside a tool_result content array is skipped, not thrown (blockText null-safety)", () => {
		const recs = parseTranscriptEntry(user([{ type: "tool_result", tool_use_id: "tr1", content: ["a", null, "b"] }]));
		expect(recs[0]?.text).toBe("a\nb");
	});

	it("P11: a non-array non-string tool_result content value flattens to no text, not a throw", () => {
		const recs = parseTranscriptEntry(user([{ type: "tool_result", tool_use_id: "tr1", content: 42 }]));
		expect(() => parseTranscriptEntry(user([{ type: "tool_result", tool_use_id: "tr1", content: 42 }]))).not.toThrow();
		expect(recs[0]?.text).toBeUndefined();
	});
});

describe("assistantRecords — array-form branch-guard edge cases", () => {
	it("P1: non-array content (e.g. a plain object) produces no record and does not throw", () => {
		const entry = { ...assistant([]), message: { content: {} } };
		expect(() => parseTranscriptEntry(entry)).not.toThrow();
		expect(parseTranscriptEntry(entry)).toEqual([]);
	});

	it("P2: a block whose type isn't \"text\" but whose text field is a real string is not treated as a message", () => {
		expect(parseTranscriptEntry(assistant([{ type: "not-text-at-all", text: "hello world" }]))).toEqual([]);
	});

	it("P3: a block whose type isn't \"thinking\" but whose thinking field is a real string is not treated as thinking", () => {
		expect(parseTranscriptEntry(assistant([{ type: "not-thinking-either", thinking: "hello world" }]))).toEqual([]);
	});

	it("P4: a null content element is skipped safely across all three branch checks (no throw)", () => {
		expect(() => parseTranscriptEntry(assistant([null]))).not.toThrow();
		expect(parseTranscriptEntry(assistant([null]))).toEqual([]);
	});

	it("P5: a text block with no text field at all is skipped safely (no throw)", () => {
		expect(() => parseTranscriptEntry(assistant([{ type: "text" }]))).not.toThrow();
		expect(parseTranscriptEntry(assistant([{ type: "text" }]))).toEqual([]);
	});

	it("P6: a thinking block with no thinking field at all is skipped safely (no throw)", () => {
		expect(() => parseTranscriptEntry(assistant([{ type: "thinking" }]))).not.toThrow();
		expect(parseTranscriptEntry(assistant([{ type: "thinking" }]))).toEqual([]);
	});

	it("P7: a whitespace-only thinking block produces no record", () => {
		expect(parseTranscriptEntry(assistant([{ type: "thinking", thinking: "   " }]))).toEqual([]);
	});

	it("P8: a tool_use block whose type check runs before a stray thinking field still resolves to tool_use", () => {
		// A tool_use block that happens to also carry a `thinking` field must not
		// be misrouted to the thinking branch — the thinking check requires
		// type==="thinking", not merely a truthy thinking field.
		const recs = parseTranscriptEntry(
			assistant([{ type: "tool_use", thinking: "sneaky text", id: "toolu_5", name: "Read", input: {} }]),
		);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("tool_use");
		expect(recs[0]?.tool_name).toBe("Read");
	});
});

describe("parseTranscriptEntry — entry-level guards (mutation hardening)", () => {
	it("P1: a function-shaped entry is rejected by the typeof-object guard even with matching fields attached", () => {
		// `typeof` a function is "function", not "object" — the guard must
		// reject it before ever reading the attached fields below.
		// Deliberately attach arbitrary fields to a function value to exercise the typeof guard.
		const fn = Object.assign(function entryFn() {}, {
			timestamp: "2026-01-01T00:00:00Z", uuid: "fn-uuid", sessionId: "fn-session",
			type: "user", message: { content: "function-shaped entry" },
		});
		expect(parseTranscriptEntry(fn)).toEqual([]);
	});

	it("P2: a missing uuid drops the entry even when the content is non-empty", () => {
		const entry: Record<string, unknown> = assistant([{ type: "text", text: "hello" }]);
		delete entry.uuid;
		expect(parseTranscriptEntry(entry)).toEqual([]);
	});

	it("P3: a missing timestamp drops the entry even when the content is non-empty", () => {
		const entry: Record<string, unknown> = assistant([{ type: "text", text: "hello" }]);
		delete entry.timestamp;
		expect(parseTranscriptEntry(entry)).toEqual([]);
	});

	it("P4: a missing sessionId drops the entry even when the content is non-empty", () => {
		const entry: Record<string, unknown> = assistant([{ type: "text", text: "hello" }]);
		delete entry.sessionId;
		expect(parseTranscriptEntry(entry)).toEqual([]);
	});

	it("P5: a non-boolean isSidechain leaves is_sidechain undefined rather than adopting the raw value", () => {
		const recs = parseTranscriptEntry({ ...assistant([{ type: "text", text: "hi" }]), isSidechain: "not-a-boolean" });
		expect(recs[0]?.is_sidechain).toBeUndefined();
	});

	it("P6: a user entry with no message field at all produces no record (no throw)", () => {
		const entry: Record<string, unknown> = user("x");
		delete entry.message;
		expect(() => parseTranscriptEntry(entry)).not.toThrow();
		expect(parseTranscriptEntry(entry)).toEqual([]);
	});

	it("P7: an assistant entry with no message field at all produces no record (no throw)", () => {
		const entry: Record<string, unknown> = assistant([]);
		delete entry.message;
		expect(() => parseTranscriptEntry(entry)).not.toThrow();
		expect(parseTranscriptEntry(entry)).toEqual([]);
	});

	it("N1: an unrecognized entry type does not fall through to the assistant branch", () => {
		const entry = { ...assistant([{ type: "text", text: "should not parse" }]), type: "other-type" };
		expect(parseTranscriptEntry(entry)).toEqual([]);
	});
});

describe("capToolUseResult — exact-boundary mutation hardening", () => {
	it("P1: a stringified result exactly at MAX_TOOL_USE_RESULT_BYTES is NOT truncated", () => {
		// JSON.stringify of a bare N-char string is N+2 bytes (the wrapping
		// quotes), so a string of MAX-2 chars lands the encoded length exactly
		// on the cap — the <= boundary, not the < side of it.
		const boundary = "x".repeat(MAX_TOOL_USE_RESULT_BYTES - 2);
		const result = capToolUseResult(boundary);
		expect(result?.truncated).toBe(false);
		expect(result?.value).toBe(boundary);
	});
});

describe("readUsage / readUsage.num — guard edge cases (mutation hardening)", () => {
	it("P1: a function-shaped usage payload is rejected by the typeof-object guard even with a numeric field attached", () => {
		// Use the same loose function shape as the entry-shaped boundary case above.
		const fn = Object.assign(function usageFn() {}, { input_tokens: 42 });
		expect(readUsage({ role: "assistant", usage: fn })).toBeNull();
	});

	it("P2: an undefined message is handled by the optional chain, not a throw", () => {
		expect(() => readUsage(undefined)).not.toThrow();
		expect(readUsage(undefined)).toBeNull();
	});

	it("P3: a null usage value returns null rather than throwing (typeof null === \"object\" quirk)", () => {
		expect(() => readUsage({ role: "assistant", usage: null })).not.toThrow();
		expect(readUsage({ role: "assistant", usage: null })).toBeNull();
	});

	it("P4: a non-finite numeric field (NaN) is dropped, not passed through as-is", () => {
		const result = readUsage({ role: "assistant", usage: { input_tokens: 5, output_tokens: Number.NaN } });
		expect(result?.input).toBe(5);
		expect(result?.output).toBeUndefined();
	});

	it("P5: a non-finite numeric field (Infinity) is dropped, not passed through as-is", () => {
		const result = readUsage({ role: "assistant", usage: { input_tokens: 1, cache_read_input_tokens: Number.POSITIVE_INFINITY } });
		expect(result?.cache_read).toBeUndefined();
	});
});

describe("attachEntryExtras — denial-kind edge case (mutation hardening)", () => {
	it("P1: a falsy (empty-string) toolDenialKind is left unset, exactly like an absent one", () => {
		// The guard is `if (e.toolDenialKind)`, so an empty string — present but
		// falsy — must NOT be recorded; only a truthy denial kind should be.
		const withEmpty = parseTranscriptEntry({
			...user([{ type: "tool_result", tool_use_id: "tr1", content: "x" }]),
			toolDenialKind: "",
		});
		expect(withEmpty[0]?.tool_denial_kind).toBeUndefined();

		const withoutField = parseTranscriptEntry(user([{ type: "tool_result", tool_use_id: "tr1", content: "x" }]));
		expect(withoutField[0]?.tool_denial_kind).toBeUndefined();
	});

	it("N1: a truthy toolDenialKind is recorded on the tool_result row", () => {
		const recs = parseTranscriptEntry({
			...user([{ type: "tool_result", tool_use_id: "tr1", content: "x" }]),
			toolDenialKind: "permission",
		});
		expect(recs[0]?.tool_denial_kind).toBe("permission");
	});
});
