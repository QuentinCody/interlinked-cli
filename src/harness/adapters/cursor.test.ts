import { outputObject, flatHookSettings } from "./test-output.js";
import { nonNull } from "../../lib/non-null.js";
import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "./cursor.js";

const adapter = createCursorAdapter();

describe("Cursor adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("cursor");
	});
	it("lists native event names", () => {
		expect(adapter.nativeEventNames).toContain("beforeShellExecution");
		expect(adapter.nativeEventNames).toContain("beforeMCPExecution");
		expect(adapter.nativeEventNames).toContain("beforeMcpToolExecution");
		expect(adapter.nativeEventNames).toContain("afterFileEdit");
		expect(adapter.nativeEventNames).toContain("beforeReadFile");
		expect(adapter.nativeEventNames).toContain("sessionStart");
	});
});

describe("Cursor detectFromEnv", () => {
	it("detects CURSOR_SESSION_ID env", () => {
		expect(adapter.detectFromEnv({ CURSOR_SESSION_ID: "abc" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Cursor parseHookInput — beforeShellExecution", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-1", cwd: "/repo", command: "rm -rf /tmp/z" },
		"beforeShellExecution",
	);
	it("produces a shell_command action", () => {
		expect(event.action.kind).toBe("shell_command");
	});
	it("classifies the command", () => {
		if (event.action.kind !== "shell_command") throw new Error("expected shell_command");
		expect(event.action.tool_class).toBe("side-effect");
	});
});

describe("Cursor parseHookInput — beforeReadFile", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-2", path: "/repo/x.ts" },
		"beforeReadFile",
	);
	it("produces a file_operation read", () => {
		if (event.action.kind !== "file_operation") throw new Error("expected file_operation");
		expect(event.action.operation).toBe("read");
		expect(event.action.path).toBe("/repo/x.ts");
	});
});

describe("Cursor parseHookInput — MCP tool", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-3", tool_name: "search", arguments: { query: "x" } },
		"beforeMCPExecution",
	);
	it("produces a tool_call", () => {
		expect(event.action.kind).toBe("tool_call");
	});
	it("parses string-form tool_input (Cursor's MCP convention)", () => {
		const e = adapter.parseHookInput(
			{
				session_id: "cur-4",
				tool_name: "delete_volume",
				tool_input: '{"volumeId":"abc-123"}',
			},
			"beforeMCPExecution",
		);
		if (e.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(e.action.tool_input).toEqual({ volumeId: "abc-123" });
	});
	it("accepts legacy beforeMcpToolExecution naming variant", () => {
		const e = adapter.parseHookInput(
			{ session_id: "cur-4b", tool_name: "search", tool_input: '{"q":"abc"}' },
			"beforeMcpToolExecution",
		);
		if (e.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(e.action.tool_input).toEqual({ q: "abc" });
	});
	it("preserves post MCP output when Cursor provides it", () => {
		const e = adapter.parseHookInput(
			{
				session_id: "cur-4c",
				tool_name: "search",
				tool_input: '{"q":"abc"}',
				tool_output: { content: [{ type: "text", text: "result" }] },
			},
			"afterMCPExecution",
		);
		if (e.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(e.action.tool_response).toEqual({ content: [{ type: "text", text: "result" }] });
	});
});

describe("Cursor parseHookInput — afterFileEdit", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-5", file_path: "/repo/src/foo.ts", edits: [] },
		"afterFileEdit",
	);
	it("produces a file_operation edit", () => {
		if (event.action.kind !== "file_operation") throw new Error("expected file_operation");
		expect(event.action.operation).toBe("edit");
		expect(event.action.path).toBe("/repo/src/foo.ts");
	});
});

describe("Cursor parseHookInput — new event surface (2026-04-30)", () => {
	it("postToolUseFailure produces a tool_call action with the failing tool", () => {
		const e = adapter.parseHookInput(
			{
				session_id: "f1",
				tool_name: "Bash",
				tool_input: { command: "npm test" },
				tool_output: "partial output",
				error_message: "timed out",
				failure_type: "timeout",
			},
			"postToolUseFailure",
		);
		expect(e.phase).toBe("post-tool");
		if (e.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(e.action.tool_name).toBe("bash");
		expect(e.action.tool_response).toBe("partial output");
		expect(e.action.tool_error).toBe("timed out");
	});

	it("subagentStart carries subagent_type + task in the action data", () => {
		const e = adapter.parseHookInput(
			{
				session_id: "s1",
				subagent_id: "abc",
				subagent_type: "shell",
				task: "run something",
			},
			"subagentStart",
		);
		expect(e.phase).toBe("pre-tool");
		if (e.action.kind !== "other") throw new Error("expected other");
		expect(e.action.subkind).toBe("subagentStart");
		expect((outputObject(e.action.data)).subagent_type).toBe("shell");
		expect((outputObject(e.action.data)).task).toBe("run something");
	});

	it("subagentStop carries status + summary", () => {
		const e = adapter.parseHookInput(
			{ session_id: "s2", subagent_type: "explore", status: "completed", summary: "done" },
			"subagentStop",
		);
		expect(e.phase).toBe("subagent-stop");
		if (e.action.kind !== "other") throw new Error("expected other");
		expect(e.action.subkind).toBe("subagentStop");
	});

	it("preCompact captures trigger + context_usage_percent", () => {
		const e = adapter.parseHookInput(
			{ session_id: "c1", trigger: "auto", context_usage_percent: 87 },
			"preCompact",
		);
		expect(e.phase).toBe("pre-compact");
		if (e.action.kind !== "other") throw new Error("expected other");
		expect((outputObject(e.action.data)).trigger).toBe("auto");
		expect((outputObject(e.action.data)).context_usage_percent).toBe(87);
	});
});

describe("Cursor encodeDecision", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", command: "ls" },
		"beforeShellExecution",
	);
	it("allow emits stdout with permission:allow", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({ permission: "allow" });
	});
	it("block emits permission:deny with snake_case agent + user messages (per Cursor docs)", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, event);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			permission: "deny",
			agent_message: "no",
			user_message: "no",
		});
	});
	it("ask emits permission:ask with snake_case messages on shell/MCP gates", () => {
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm?", system_message: "potentially destructive" },
			event,
		);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			permission: "ask",
			agent_message: "confirm?",
			user_message: "potentially destructive",
		});
	});
	it("ask collapses to deny on preToolUse (Cursor doesn't enforce ask there)", () => {
		const preToolEvent = adapter.parseHookInput(
			{ session_id: "c", tool_name: "Edit", tool_input: { file_path: "/a" } },
			"preToolUse",
		);
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, preToolEvent);
		const parsed = outputObject(JSON.parse(nonNull(out.stdout)));
		expect(parsed.permission).toBe("deny");
		expect(parsed.agent_message).toBe("confirm?");
	});
	it("ask collapses to deny on subagentStart (docs: ask treated as deny)", () => {
		const subEvent = adapter.parseHookInput(
			{ session_id: "c", subagent_id: "x", subagent_type: "shell", task: "go" },
			"subagentStart",
		);
		const out = adapter.encodeDecision({ decision: "ask", reason: "untrusted" }, subEvent);
		const parsed = outputObject(JSON.parse(nonNull(out.stdout)));
		expect(parsed.permission).toBe("deny");
	});
	it("post_warn / advisory on postToolUse routes through additional_context (model-visible)", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "c", tool_name: "Edit", tool_input: {}, tool_output: "ok" },
			"postToolUse",
		);
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "Fix this lint." },
			postEvent,
		);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			additional_context: "Fix this lint.",
		});
	});
	it("post_block on postToolUse uses additional_context (closest Cursor analogue)", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "c", tool_name: "Edit", tool_input: {}, tool_output: "ok" },
			"postToolUse",
		);
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "tsc failed: missing return type" },
			postEvent,
		);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			additional_context: "tsc failed: missing return type",
		});
	});
	it("non-gated event (afterFileEdit) blocks via stderr instead of stdout JSON", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "c", file_path: "/a", edits: [] },
			"afterFileEdit",
		);
		const out = adapter.encodeDecision({ decision: "block", reason: "lint failed" }, postEvent);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toContain("lint failed");
	});
});

describe("Cursor renderSettingsFragment", () => {
	const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
	it("writes to .cursor/hooks.json (project scope)", () => {
		expect(fragment.path).toBe(".cursor/hooks.json");
	});
	it("includes version: 1 in the fragment", () => {
		const f = flatHookSettings(fragment.fragment);
		expect(f.version).toBe(1);
	});
	it("sets failClosed: true on gated events", () => {
		const f = flatHookSettings(fragment.fragment);
		expect(f.hooks.beforeShellExecution?.[0]?.failClosed).toBe(true);
		expect(f.hooks.beforeMCPExecution?.[0]?.failClosed).toBe(true);
		expect(f.hooks.beforeMcpToolExecution?.[0]?.failClosed).toBe(true);
		expect(f.hooks.beforeReadFile?.[0]?.failClosed).toBe(true);
		expect(f.hooks.subagentStart?.[0]?.failClosed).toBe(true);
	});
	it("registers postToolUseFailure / subagentStop / preCompact as observation hooks", () => {
		const f = flatHookSettings(fragment.fragment);
		expect(f.hooks.postToolUseFailure?.[0]?.failClosed).toBeUndefined();
		expect(f.hooks.subagentStop?.[0]?.failClosed).toBeUndefined();
		expect(f.hooks.preCompact?.[0]?.failClosed).toBeUndefined();
	});
	it("leaves failClosed unset on observation hooks", () => {
		const f = flatHookSettings(fragment.fragment);
		expect(f.hooks.afterFileEdit?.[0]?.failClosed).toBeUndefined();
		expect(f.hooks.sessionStart?.[0]?.failClosed).toBeUndefined();
	});
});

describe("Cursor parseHookInput — non-object / missing-field fallbacks", () => {
	it("treats a non-object native payload as empty (isObject false branch)", () => {
		const e = adapter.parseHookInput(null, "sessionStart");
		expect(e.session_id).toBe("unknown");
		expect(e.context.cwd).toBe(process.cwd());
	});
	it("falls back to session_id 'unknown' when neither session_id nor sessionId is present", () => {
		const e = adapter.parseHookInput({}, "sessionStart");
		expect(e.session_id).toBe("unknown");
	});
	it("falls back to camelCase sessionId when snake_case session_id is absent", () => {
		const e = adapter.parseHookInput({ sessionId: "cc-1" }, "sessionStart");
		expect(e.session_id).toBe("cc-1");
	});
	it("falls back to workspace_root when cwd is absent", () => {
		const e = adapter.parseHookInput({ workspace_root: "/ws" }, "sessionStart");
		expect(e.context.cwd).toBe("/ws");
	});
	it("falls back to process.cwd() when neither cwd nor workspace_root is present", () => {
		const e = adapter.parseHookInput({}, "sessionStart");
		expect(e.context.cwd).toBe(process.cwd());
	});
});

describe("Cursor classifyToolClass", () => {
	it("classifies a tool name without overrides configured", () => {
		const noOverrideAdapter = createCursorAdapter();
		expect(noOverrideAdapter.classifyToolClass("Read", { file_path: "/a" })).toBe("read");
	});
	it("classifies a tool name with overrides configured", () => {
		const overrideAdapter = createCursorAdapter({
			overrides: { tool_name_classes: { CustomWrite: "modify" }, command_substrings: [] },
		});
		expect(overrideAdapter.classifyToolClass("CustomWrite", {})).toBe("modify");
	});
});

describe("Cursor encodeDecision — additional branch coverage", () => {
	const gatedShellEvent = adapter.parseHookInput({ session_id: "g", command: "ls" }, "beforeShellExecution");
	const nonGatedEvent = adapter.parseHookInput({ session_id: "ng", file_path: "/a", edits: [] }, "afterFileEdit");
	const preToolEvent = adapter.parseHookInput(
		{ session_id: "p", tool_name: "Edit", tool_input: { file_path: "/a" } },
		"preToolUse",
	);

	it("block on a gated event with no reason falls back to the default block reason", () => {
		const out = adapter.encodeDecision({ decision: "block" }, gatedShellEvent);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			permission: "deny",
			agent_message:
				"Blocked by the interlinked harness, but no reason was attached — likely a harness bug; " +
				"re-run, or run `interlinked harness restart`, then report it.",
			user_message:
				"Blocked by the interlinked harness, but no reason was attached — likely a harness bug; " +
				"re-run, or run `interlinked harness restart`, then report it.",
		});
	});

	it("block on a non-gated, non-postContext event with no reason and no warnings emits empty stderr", () => {
		const out = adapter.encodeDecision({ decision: "block" }, nonGatedEvent);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toBeUndefined();
	});

	it("block on a non-gated event with no reason but warnings falls back to the joined warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "block", warnings: ["heads up"] },
			nonGatedEvent,
		);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toBe("heads up");
	});

	it("ask user_message falls back to reason when system_message is absent", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm this" }, gatedShellEvent);
		const parsed = outputObject(JSON.parse(nonNull(out.stdout)));
		expect(parsed.agent_message).toBe("confirm this");
		expect(parsed.user_message).toBe("confirm this");
	});

	it("ask falls back to the default ask reason when neither reason nor system_message is present", () => {
		const out = adapter.encodeDecision({ decision: "ask" }, gatedShellEvent);
		const parsed = outputObject(JSON.parse(nonNull(out.stdout)));
		expect(parsed.agent_message).toBe("Confirmation required");
		expect(parsed.user_message).toBe("Confirmation required");
	});

	it("ask on a non-gated event routes through stderr instead of stdout JSON", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "just checking" }, nonGatedEvent);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toBe("just checking");
	});

	it("allow on a gated, non-postContext event with additional_context sets agent_message", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi note" },
			preToolEvent,
		);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			permission: "allow",
			agent_message: "fyi note",
		});
	});
});
