import { nestedHookSettings } from "./test-output.js";
import { nonNull } from "../../lib/non-null.js";
import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./claude-code.js";

const adapter = createClaudeCodeAdapter();

describe("mutation-kill w29 — parseHookInput tool_use_id", () => {
	// test-contract: invariant — tool_use_id must be passed through by `??`, not
	// short-circuited by `&&` (mutation target: LogicalOperator on line ~90)
	it("passes a present tool_use_id through unchanged", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_use_id: "tu-1" },
			"PreToolUse",
		);
		expect(event.tool_use_id).toBe("tu-1");
	});
});

describe("mutation-kill w29 — parseHookInput runner field", () => {
	// test-contract: invariant — `runner` must be the literal "claude-code";
	// downstream routing keys off it (mutation target: StringLiteral)
	it("stamps runner as 'claude-code'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SessionStart");
		expect(event.runner).toBe("claude-code");
	});
});

describe("mutation-kill w29 — renderSettingsFragment runner literal in detached command", () => {
	// test-contract: invariant — the detached SessionEnd command must still carry
	// the literal runner id "claude-code" (mutation target: StringLiteral)
	it("includes --runner 'claude-code' in the detached SessionEnd command", () => {
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		const fragment = nestedHookSettings(frag.fragment);
		const sessionEnd = fragment.hooks.SessionEnd?.[0];
		expect(sessionEnd?.hooks[0]?.command).toContain("--runner 'claude-code'");
	});
});

describe("mutation-kill w29 — renderSettingsFragment conditional timeout spread", () => {
	// test-contract: invariant — per-event timeout policy from hook-timeouts.ts must
	// be spread in only when defined (mutation targets: ConditionalExpression,
	// EqualityOperator, ObjectLiteral around `timeout !== undefined ? { timeout } : {}`)
	it("includes a timeout key for PreToolUse (policy defines one)", () => {
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		const fragment = nestedHookSettings(frag.fragment);
		const entry = fragment.hooks.PreToolUse?.[0]?.hooks[0];
		expect(entry).toBeDefined();
		expect(entry).toHaveProperty("timeout");
		expect(entry?.timeout).toBe(240);
	});
	// test-contract: invariant — the `{}` branch of the conditional spread must add
	// no key at all when there is no policy timeout (mutation targets as above)
	it("omits the timeout key entirely for an event with no policy timeout (SessionStart)", () => {
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		const fragment = nestedHookSettings(frag.fragment);
		const entry = fragment.hooks.SessionStart?.[0]?.hooks[0];
		expect(entry).toBeDefined();
		expect(entry).not.toHaveProperty("timeout");
	});
});

describe("mutation-kill w29 — encodeDecision hookEventName PostToolUse fallback", () => {
	// test-contract: invariant — hookEventName's phase-based fallback must emit the
	// literal "PostToolUse" (mutation target: StringLiteral)
	it("falls back to hookEventName 'PostToolUse' when phase is post-tool and native event name is absent", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		const fakeEvent = { ...postEvent, runner_native_event: "" };
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "hi" },
			fakeEvent,
		);
		// SAFETY: encodeDecision's stdout is always a JSON string on this branch —
		// asserted immediately below via JSON.parse, which throws if it were not.
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "hi" },
		});
	});
});

describe("mutation-kill w29 — encodeDecision stderr fan-out per return path", () => {
	const baseEvent = adapter.parseHookInput(
		{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
		"PreToolUse",
	);
	const postEvent = adapter.parseHookInput(
		{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
		"PostToolUse",
	);

	// test-contract: invariant — the PreToolUse block return's `stderr: stderr ||
	// undefined` must yield the joined warnings when non-empty (mutation targets:
	// ConditionalExpression true/false, LogicalOperator || -> &&)
	it("PreToolUse block with warnings: stderr carries the joined warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "no", warnings: ["w1"] },
			baseEvent,
		);
		expect(out.stderr).toBe("w1");
	});
	// test-contract: invariant — the same fallback must yield exactly `undefined`
	// (not `""`, `true`, or `false`) when there are no warnings
	it("PreToolUse block with no warnings: stderr is undefined", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, baseEvent);
		expect(out.stderr).toBeUndefined();
	});

	// test-contract: invariant — the PostToolUse block return's own `stderr ||
	// undefined` fallback (a separate call site) must carry warnings through
	it("PostToolUse block with warnings: stderr carries the joined warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "no", warnings: ["w1"] },
			postEvent,
		);
		expect(out.stderr).toBe("w1");
	});
	// test-contract: invariant — and yield `undefined` exactly when there are none
	it("PostToolUse block with no warnings: stderr is undefined", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, postEvent);
		expect(out.stderr).toBeUndefined();
	});

	// test-contract: invariant — the `ask` return's `stderr || undefined` fallback
	// must carry warnings through
	it("ask with warnings: stderr carries the joined warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm?", warnings: ["w1"] },
			baseEvent,
		);
		expect(out.stderr).toBe("w1");
	});
	// test-contract: invariant — and yield `undefined` exactly when there are none
	it("ask with no warnings: stderr is undefined", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, baseEvent);
		expect(out.stderr).toBeUndefined();
	});

	// test-contract: invariant — the additionalContext return's `stderr ||
	// undefined` fallback must yield `undefined` exactly when there are no warnings
	it("allow with additional_context and no warnings: stderr is undefined", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi" },
			baseEvent,
		);
		expect(out.stderr).toBeUndefined();
	});
	// test-contract: invariant — and must carry the joined warnings through when present
	it("allow with additional_context and warnings: stderr carries the joined warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi", warnings: ["w1"] },
			baseEvent,
		);
		expect(out.stderr).toBe("w1");
	});
});

describe("mutation-kill w29 — buildClaudeAction branch selection", () => {
	// test-contract: invariant — the PostToolUse branch condition in buildClaudeAction
	// must route to buildToolCallAction (mutation targets: ConditionalExpression
	// eventName==="PostToolUse"->false, StringLiteral "PostToolUse" -> "")
	it("PostToolUse produces a tool_call action", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		expect(event.action.kind).toBe("tool_call");
	});

	// test-contract: invariant — the SessionStart branch condition and its "start"
	// event value must both hold (mutation targets: ConditionalExpression
	// eventName==="SessionStart"->false, StringLiteral "SessionStart"->"" and "start"->"")
	it("SessionStart produces the exact session_lifecycle 'start' action", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SessionStart");
		expect(event.action).toEqual({ kind: "session_lifecycle", event: "start" });
	});

	// test-contract: invariant — for a PreToolUse event, isPost must resolve false
	// so tool_response/tool_error are never added (mutation targets: ConditionalExpression
	// eventName!=="PreToolUse"->true, StringLiteral "PreToolUse"->"", and
	// buildToolCallAction's internal `if (isPost)` forced to true)
	it("PreToolUse action carries no tool_response/tool_error keys (isPost is false)", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
			"PreToolUse",
		);
		expect(event.action).not.toHaveProperty("tool_response");
		expect(event.action).not.toHaveProperty("tool_error");
	});
});

describe("mutation-kill w29 — normalizeToolName anchored regex", () => {
	// test-contract: invariant — normalizeToolName's trailing `.replace(/^_/, "")`
	// must be anchored to the start, not strip the first underscore anywhere
	// (mutation target: Regex /^_/ -> /_/)
	it("keeps a mid-string underscore when there is no leading one to strip", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "myToolName", tool_input: {} },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ tool_name: "my_tool_name" });
	});
});

describe("mutation-kill w29 — isObject typeof guard", () => {
	// test-contract: invariant — isObject's `typeof v === "object"` clause must
	// actually gate on the runtime type, not be short-circuited to true
	// (mutation target: ConditionalExpression)
	it("treats a string native payload as not-an-object, so raw falls back to {}", () => {
		const event = adapter.parseHookInput("hello", "SessionStart");
		expect(event.raw).toEqual({});
	});
});

describe("mutation-kill w29 — readString typeof guard", () => {
	// test-contract: invariant — readString's `typeof v === "string"` clause must
	// actually gate on the runtime type, not be short-circuited to true
	// (mutation target: ConditionalExpression)
	it("rejects a non-string session_id, falling back to 'unknown'", () => {
		const event = adapter.parseHookInput({ session_id: 123, cwd: "/repo" }, "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
});

describe("mutation-kill w29 — PHASE_MAP string literals", () => {
	// test-contract: invariant — PHASE_MAP module StringLiteral "user-prompt" -> ""
	it("UserPromptSubmit maps to phase 'user-prompt'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "UserPromptSubmit");
		expect(event.phase).toBe("user-prompt");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "session-end" -> ""
	it("SessionEnd maps to phase 'session-end'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SessionEnd");
		expect(event.phase).toBe("session-end");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "stop" -> ""
	it("Stop maps to phase 'stop'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "Stop");
		expect(event.phase).toBe("stop");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "post-tool" -> "" (PostToolUse site)
	it("PostToolUse maps to phase 'post-tool'", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		expect(event.phase).toBe("post-tool");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "post-tool" -> "" (PostToolUseFailure site)
	it("PostToolUseFailure maps to phase 'post-tool'", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: {}, tool_error: "boom" },
			"PostToolUseFailure",
		);
		expect(event.phase).toBe("post-tool");
	});
	// test-contract: invariant — permission requests remain distinct from tool execution.
	it("PermissionRequest maps to phase 'permission-request'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "PermissionRequest");
		expect(event.phase).toBe("permission-request");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "other" -> "" (TaskCompleted site)
	it("TaskCompleted maps to phase 'other'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "TaskCompleted");
		expect(event.phase).toBe("other");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "subagent-start" -> ""
	it("SubagentStart maps to phase 'subagent-start'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SubagentStart");
		expect(event.phase).toBe("subagent-start");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "subagent-stop" -> ""
	it("SubagentStop maps to phase 'subagent-stop'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SubagentStop");
		expect(event.phase).toBe("subagent-stop");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "notification" -> ""
	it("Notification maps to phase 'notification'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "Notification");
		expect(event.phase).toBe("notification");
	});
	// test-contract: invariant — PHASE_MAP module StringLiteral "pre-compact" -> ""
	it("PreCompact maps to phase 'pre-compact'", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "PreCompact");
		expect(event.phase).toBe("pre-compact");
	});
});
