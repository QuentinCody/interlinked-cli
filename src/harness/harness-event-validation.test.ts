import { describe, expect, it } from "vitest";
import { isHarnessEvent, parseLiveHarnessEvent } from "./harness-event-validation.js";

const event = { hook_event: "PreToolUse", session_id: "session", agent_source: "codex", timestamp: "2026-11-11T00:00:00Z" };

describe("harness event wire contract", () => {
	// test-contract: boundary — every consumed wire field must have its declared runtime shape.
	it.each([null, [], {}, true, 42, { ...event, session_id: 1 }, { ...event, tool_input: [] }, { ...event, files_modified: [3] }, { ...event, dry_run: "false" }, { ...event, tool_outcome: "maybe" }])
		("P1: rejects malformed event %j", value => expect(isHarnessEvent(value)).toBe(false));
	it("N1: retains lifecycle events, unknown provider fields and opaque tool responses", () => {
		expect(isHarnessEvent(event)).toBe(true);
		expect(isHarnessEvent({ ...event, hook_event: "FutureEvent", agent_source: "future-provider", extra: 1, tool_response: null })).toBe(true);
		expect(isHarnessEvent({ ...event, tool_name: "Read", tool_input: { file_path: "src/a.ts" }, dry_run: false })).toBe(true);
	});
	it("preserves legacy live events without source/time metadata while validating operational fields", () => {
		expect(parseLiveHarnessEvent({ hook_event: "Stop", session_id: "s" })).toEqual({ hook_event: "Stop", session_id: "s", agent_source: "unknown", timestamp: "" });
		expect(parseLiveHarnessEvent({ ...event, timestamp: 42 })?.timestamp).toBe("");
		expect(parseLiveHarnessEvent({ ...event, tool_input: "unsafe" })).toBeNull();
		expect(parseLiveHarnessEvent({ ...event, agent_source: 42 })).toBeNull();
		expect(parseLiveHarnessEvent(null)).toBeNull();
	});
	it("normalizes the generated hook's null optional fields without weakening control validation", () => {
		const generated = { ...event, agent_name: null, tool_name: "Bash", tool_input: { command: "rm -rf /" }, tool_use_id: null, cwd: null, model: null, tool_outcome: null, error_message: null, exit_code: null, stderr: null, stdout: null, tool_response_sha256: null };
		expect(parseLiveHarnessEvent(generated)).toEqual({ ...event, tool_name: "Bash", tool_input: { command: "rm -rf /" } });
		expect(parseLiveHarnessEvent({ ...generated, dry_run: null })).toBeNull();
		expect(parseLiveHarnessEvent({ ...generated, session_id: null })).toBeNull();
		expect(parseLiveHarnessEvent({ ...generated, tool_input: [] })).toBeNull();
	});
});
