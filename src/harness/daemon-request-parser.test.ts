import { describe, expect, it } from "vitest";
import { isRpcHookEvent } from "./daemon-request-parser.js";
import type { UnifiedHookEvent } from "./unified-event.js";

const event: UnifiedHookEvent = {
	schema_version: "1", event_id: "evt", session_id: "session", ts: "2026-09-07T00:00:00Z",
	runner: "codex", runner_native_event: "PreToolUse", phase: "pre-tool",
	action: { kind: "tool_call", tool_name: "read", tool_class: "read", tool_input: { path: "a.ts" }, tool_input_redacted: {} },
	context: { cwd: "/repo" }, raw: {},
};

describe("RPC hook request validation", () => {
	it("accepts fully shaped hook events and optional provider evidence", () => {
		expect(isRpcHookEvent({
			...event, future_field: "retained", post_delivery_pid: 42,
			context: { cwd: "/repo", agent: { id: "a" } },
			outcome: { policy: "allow", execution: "not_started", tool_body_executed: false },
			observation: { kind: "tool_batch", boundary: "before_model", calls: [{ tool_use_id: "tool-1" }] },
		})).toBe(true);
	});

	it.each([
		{ runner: "invented" }, { phase: "invented" }, { post_delivery_pid: "42" },
		{ context: { cwd: "/repo", agent: { id: 42 } } },
		{ action: { kind: "tool_call" } },
		{ action: { kind: "shell_command", command: 42, tool_class: "read" } },
		{ action: { kind: "file_operation", path: "a.ts", operation: "edit", tool_class: "modify", new_string: null } },
		{ action: { kind: "session_lifecycle", event: "restart" } },
		{ outcome: { policy: "allow", execution: "succeeded", tool_body_executed: "yes" } },
		{ observation: { kind: "tool_batch", boundary: "before_model", calls: [null] } },
		{ capability: { schema_version: "1", runtime: null } },
	])("rejects malformed fields that the envelope validator cannot establish: %j", (change) => {
		expect(isRpcHookEvent({ ...event, ...change })).toBe(false);
	});
});
