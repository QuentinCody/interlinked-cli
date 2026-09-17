// Coverage backfill for src/harness/adapters/claude-code.ts sites left
// uncovered after the 2026-09 checks: encodeClaudeContinuation's fallback
// block-reason text, and resolveClaudeHookEventName's PermissionRequest
// phase fallback when the native event name wasn't echoed on the event.
// See the sibling claude-code.test.ts for the primary encodeDecision suite
// this file does not duplicate.
import { describe, expect, it } from "vitest";
import { makeUnifiedEvent } from "../__tests__/fixtures/unified-event.js";
import { createClaudeCodeAdapter } from "./claude-code.js";

const adapter = createClaudeCodeAdapter();

describe("Claude continuation block with no diagnostic text", () => {
	it("falls back to a generic 'Further work is required.' reason when the decision carries no reason/context/warnings", () => {
		const stopEvent = adapter.parseHookInput({ session_id: "s" }, "Stop");
		const out = adapter.encodeDecision({ decision: "block" }, stopEvent);
		expect(JSON.parse(String(out.stdout))).toEqual({
			decision: "block",
			reason: "Further work is required.",
		});
	});
});

describe("resolveClaudeHookEventName — PermissionRequest phase fallback", () => {
	it("falls back to the literal 'PermissionRequest' hookEventName when the event carries no runner_native_event", () => {
		// Every event built through adapter.parseHookInput(...) echoes the
		// native event name, so this path only fires for a hand-built event
		// (e.g. an internally-synthesized permission-request phase event)
		// that omits it.
		const permissionEvent = makeUnifiedEvent({
			phase: "permission-request",
			runner_native_event: "",
			action: { kind: "tool_call", tool_name: "Bash", tool_class: "side-effect", tool_input: {}, tool_input_redacted: {} },
		});
		const out = adapter.encodeDecision({ decision: "block", reason: "policy denied" }, permissionEvent);
		expect(JSON.parse(String(out.stdout))).toEqual({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: "policy denied" },
			},
		});
	});
});
