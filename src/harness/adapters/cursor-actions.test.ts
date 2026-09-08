import { assert, describe, expect, it } from "vitest";
import type { JsonObject } from "../../lib/json-types.js";
import { buildCursorAction } from "./cursor-actions.js";

describe("buildCursorAction", () => {
	it("beforeSubmitPrompt maps to user_prompt with prompt text", () => {
		const action = buildCursorAction("beforeSubmitPrompt", { prompt: "hello there" }, undefined);
		expect(action).toEqual({ kind: "user_prompt", text: "hello there" });
	});

	it("beforeSubmitPrompt with missing/non-string prompt defaults to empty string", () => {
		const action = buildCursorAction("beforeSubmitPrompt", { prompt: 42 }, undefined);
		expect(action).toEqual({ kind: "user_prompt", text: "" });
	});

	it("beforeShellExecution builds a shell_command action, classifying the command", () => {
		const action = buildCursorAction(
			"beforeShellExecution",
			{ command: "rm -rf /tmp/foo", cwd: "/tmp" },
			undefined,
		);
		expect(action).toEqual({
			kind: "shell_command",
			command: "rm -rf /tmp/foo",
			cwd: "/tmp",
			tool_class: "side-effect",
		});
	});

	it("afterShellExecution with missing command/cwd defaults command to empty string and cwd to undefined", () => {
		const action = buildCursorAction("afterShellExecution", {}, undefined);
		expect(action).toEqual({
			kind: "shell_command",
			command: "",
			cwd: undefined,
			tool_class: "unknown",
		});
	});

	it("beforeReadFile builds a file_operation read action using path", () => {
		const action = buildCursorAction("beforeReadFile", { path: "/a/b.ts" }, undefined);
		expect(action).toEqual({
			kind: "file_operation",
			operation: "read",
			path: "/a/b.ts",
			tool_class: "read",
		});
	});

	it("beforeReadFile falls back to file_path when path is absent", () => {
		const action = buildCursorAction("beforeReadFile", { file_path: "/c/d.ts" }, undefined);
		expect(action).toEqual({
			kind: "file_operation",
			operation: "read",
			path: "/c/d.ts",
			tool_class: "read",
		});
	});

	it("beforeReadFile with neither path nor file_path defaults to empty string", () => {
		const action = buildCursorAction("beforeReadFile", {}, undefined);
		expect(action).toEqual({
			kind: "file_operation",
			operation: "read",
			path: "",
			tool_class: "read",
		});
	});

	it("afterFileEdit builds a file_operation edit action using file_path", () => {
		const action = buildCursorAction("afterFileEdit", { file_path: "/e/f.ts" }, undefined);
		expect(action).toEqual({
			kind: "file_operation",
			operation: "edit",
			path: "/e/f.ts",
			tool_class: "modify",
		});
	});

	it("afterFileEdit with missing file_path defaults path to empty string", () => {
		const action = buildCursorAction("afterFileEdit", {}, undefined);
		expect(action).toEqual({
			kind: "file_operation",
			operation: "edit",
			path: "",
			tool_class: "modify",
		});
	});

	it("MCP event parses a string tool_input (JSON string) and lowercases tool name", () => {
		const action = buildCursorAction(
			"beforeMCPExecution",
			{ tool_name: "Some_Tool", arguments: JSON.stringify({ x: 1 }) },
			undefined,
		);
		assert(action.kind === "tool_call");
		expect(action.kind).toBe("tool_call");
		expect(action.tool_name).toBe("some_tool");
		expect(action.tool_input).toEqual({ x: 1 });
	});

	it("MCP event with an unparseable string tool_input keeps the raw string (swallowed catch)", () => {
		const action = buildCursorAction(
			"beforeMcpToolExecution",
			{ tool_name: "t", tool_input: "{not valid json" },
			undefined,
		);
		assert(action.kind === "tool_call");
		expect(action.tool_input).toBe("{not valid json");
	});

	it("MCP event falls back through name -> unknown, and args -> {} when nothing present", () => {
		const action = buildCursorAction("afterMCPExecution", {}, undefined);
		assert(action.kind === "tool_call");
		expect(action.tool_name).toBe("unknown");
		expect(action.tool_input).toEqual({});
	});

	it("MCP event uses `name` field when tool_name is absent, and `args` when arguments/tool_input absent", () => {
		const action = buildCursorAction(
			"afterMcpToolExecution",
			{ name: "MyTool", args: { y: 2 } },
			undefined,
		);
		assert(action.kind === "tool_call");
		expect(action.tool_name).toBe("mytool");
		expect(action.tool_input).toEqual({ y: 2 });
	});

	it("MCP event attaches tool_response/tool_error from raw payload", () => {
		const action = buildCursorAction(
			"beforeMCPExecution",
			{ tool_name: "t", tool_response: "ok", error: "boom" },
			undefined,
		);
		assert(action.kind === "tool_call");
		expect(action.tool_response).toBe("ok");
		expect(action.tool_error).toBe("boom");
	});

	it("MCP event passes classifier overrides through when provided", () => {
		const overrides = {
			tool_name_classes: { t: "side-effect" as const },
			command_substrings: [],
		};
		const action = buildCursorAction(
			"beforeMCPExecution",
			{ tool_name: "t" },
			overrides,
		);
		assert(action.kind === "tool_call");
		expect(action.tool_class).toBe("side-effect");
	});

	it("preToolUse/postToolUse/postToolUseFailure build a tool_call action from tool_name/tool_input", () => {
		for (const eventName of ["preToolUse", "postToolUse", "postToolUseFailure"]) {
			const action = buildCursorAction(
				eventName,
				{ tool_name: "Bash", tool_input: { command: "ls" } },
				undefined,
			);
		assert(action.kind === "tool_call");
			expect(action.kind).toBe("tool_call");
			expect(action.tool_name).toBe("bash");
			expect(action.tool_class).toBe("read");
		}
	});

	it("toolUse event with missing tool_name defaults to 'unknown' and tool_input to {}", () => {
		const action = buildCursorAction("preToolUse", {}, undefined);
		assert(action.kind === "tool_call");
		expect(action.tool_name).toBe("unknown");
		expect(action.tool_input).toEqual({});
	});

	it("subagentStart builds an 'other' action with subagent fields, defaulting missing ones to null", () => {
		const action = buildCursorAction(
			"subagentStart",
			{ subagent_id: "abc", subagent_type: "reviewer" },
			undefined,
		);
		expect(action).toEqual({
			kind: "other",
			subkind: "subagentStart",
			data: {
				subagent_id: "abc",
				subagent_type: "reviewer",
				task: null,
				parent_conversation_id: null,
			},
		});
	});

	it("subagentStop builds an 'other' action with status/summary fields, defaulting missing ones to null", () => {
		const action = buildCursorAction(
			"subagentStop",
			{ subagent_type: "reviewer", status: "done" },
			undefined,
		);
		expect(action).toEqual({
			kind: "other",
			subkind: "subagentStop",
			data: {
				subagent_type: "reviewer",
				status: "done",
				summary: null,
			},
		});
	});

	it("preCompact builds an 'other' action, carrying a numeric context_usage_percent through", () => {
		const action = buildCursorAction(
			"preCompact",
			{ trigger: "auto", context_usage_percent: 87 },
			undefined,
		);
		expect(action).toEqual({
			kind: "other",
			subkind: "preCompact",
			data: { trigger: "auto", context_usage_percent: 87 },
		});
	});

	it("preCompact with a non-number context_usage_percent defaults to null", () => {
		const action = buildCursorAction(
			"preCompact",
			{ trigger: "manual", context_usage_percent: "87%" },
			undefined,
		);
		expect(action).toEqual({
			kind: "other",
			subkind: "preCompact",
			data: { trigger: "manual", context_usage_percent: null },
		});
	});

	it("unrecognized event name falls through to a generic 'other' action carrying the raw payload", () => {
		const raw: JsonObject = { foo: "bar" };
		const action = buildCursorAction("someUnknownEvent", raw, undefined);
		expect(action).toEqual({ kind: "other", subkind: "someUnknownEvent", data: raw });
	});
});
