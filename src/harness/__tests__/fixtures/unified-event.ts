import type { UnifiedHookEvent } from "../../unified-event.js";

export function makeUnifiedEvent(overrides: Partial<UnifiedHookEvent> = {}): UnifiedHookEvent {
	return {
		schema_version: "1",
		event_id: "test-event",
		session_id: "test-session",
		ts: "2026-09-01T00:00:00.000Z",
		runner: "claude-code",
		runner_native_event: "PreToolUse",
		phase: "pre-tool",
		action: { kind: "tool_call", tool_name: "edit", tool_class: "modify", tool_input: {}, tool_input_redacted: {} },
		context: { cwd: "/workspace" },
		raw: {},
		...overrides,
	};
}
