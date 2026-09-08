import { outputObject, nestedHookSettings } from "./test-output.js";
import { nonNull } from "../../lib/non-null.js";
import { describe, expect, it } from "vitest";
import { createGeminiCliAdapter } from "./gemini-cli.js";

const adapter = createGeminiCliAdapter();

describe("Gemini CLI adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("gemini-cli");
	});
	it("is marked experimental", () => {
		expect(adapter.experimental).toBe(true);
	});
	it("lists native event names", () => {
		expect(adapter.nativeEventNames).toContain("BeforeTool");
		expect(adapter.nativeEventNames).toContain("PreCompress");
	});
});

describe("Gemini CLI detectFromEnv", () => {
	it("detects GEMINI_API_KEY env", () => {
		expect(adapter.detectFromEnv({ GEMINI_API_KEY: "x" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Gemini CLI parseHookInput — BeforeTool", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "gem-1",
			cwd: "/repo",
			tool_name: "edit_file",
			tool_input: { path: "/repo/a.ts" },
		},
		"BeforeTool",
	);
	it("has phase pre-tool", () => {
		expect(event.phase).toBe("pre-tool");
	});
	it("classifies as modify", () => {
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("modify");
	});
});

describe("Gemini CLI parseHookInput — PreCompress", () => {
	const event = adapter.parseHookInput({ session_id: "x" }, "PreCompress");
	it("maps to pre-compact phase", () => {
		expect(event.phase).toBe("pre-compact");
	});
});

describe("Gemini CLI encodeDecision", () => {
	const event = adapter.parseHookInput(
		{ session_id: "g", tool_name: "read_file", tool_input: {} },
		"BeforeTool",
	);
	it("allow emits the native JSON no-op", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({});
	});
	it("block emits decision deny through the exit-zero JSON channel", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "bad" }, event);
		expect(out.exit_code).toBe(0);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({ decision: "deny", reason: "bad" });
	});
	it("block with no reason falls back to the default harness-bug message", () => {
		const out = adapter.encodeDecision({ decision: "block" }, event);
		expect(out.exit_code).toBe(0);
		const parsed = outputObject(JSON.parse(nonNull(out.stdout)));
		expect(parsed.decision).toBe("deny");
		expect(parsed.reason).toMatch(/harness bug/);
	});
	it("an unsupported ask emits deny with the given reason", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "please confirm" }, event);
		expect(out.exit_code).toBe(0);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({ decision: "deny", reason: "please confirm" });
		expect(out.translation?.status).toBe("degraded");
	});
	it("ask with no reason falls back to the default confirmation message", () => {
		const out = adapter.encodeDecision({ decision: "ask" }, event);
		expect(JSON.parse(nonNull(out.stdout))).toEqual({
			decision: "deny",
			reason: "Confirmation required",
		});
	});
	it("attaches warnings joined onto stderr", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["warn one", "warn two"] },
			event,
		);
		expect(out.stderr).toBe("warn one\nwarn two");
	});
	it("stderr is undefined when there are no warnings", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.stderr).toBeUndefined();
	});
	it("uses the minimal valid JSON no-op for a clean AfterTool result", () => {
		const afterTool = adapter.parseHookInput(
			{ session_id: "g", tool_name: "read_file", tool_input: {}, tool_response: {} },
			"AfterTool",
		);
		const out = adapter.encodeDecision({ decision: "allow" }, afterTool);
		expect(out).toEqual({ stdout: "{}", stderr: undefined, exit_code: 0 });
	});
});

describe("Gemini CLI classifyToolClass", () => {
	it("delegates to classifyFromToolName for the given tool name/input", () => {
		expect(adapter.classifyToolClass?.("edit_file", { path: "/repo/a.ts" })).toBe("modify");
	});
	it("classifies a read-only tool as read", () => {
		expect(adapter.classifyToolClass?.("read_file", { path: "/repo/a.ts" })).toBe("read");
	});
	it("passes overrides through when the adapter was built with them", () => {
		const withOverrides = createGeminiCliAdapter({
			overrides: { tool_name_classes: { custom_tool: "modify" }, command_substrings: [] },
		});
		expect(withOverrides.classifyToolClass?.("custom_tool", {})).toBe("modify");
	});
	it("applies overrides inside parseHookInput's BeforeTool action too", () => {
		const withOverrides = createGeminiCliAdapter({
			overrides: { tool_name_classes: { custom_tool: "modify" }, command_substrings: [] },
		});
		const event = withOverrides.parseHookInput(
			{ session_id: "x", tool_name: "custom_tool", tool_input: {} },
			"BeforeTool",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("modify");
	});
});

describe("Gemini CLI renderSettingsFragment", () => {
	it("targets the user-scope settings path and array-append merge strategy", () => {
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked", "user");
		expect(frag.path).toBe("~/.gemini/settings.json");
		expect(frag.mergeStrategy).toBe("array-append");
		const hooks = (nestedHookSettings(frag.fragment)).hooks;
		expect(Object.keys(hooks).sort()).toEqual(
			[
				"SessionStart",
				"SessionEnd",
				"BeforeAgent",
				"AfterAgent",
				"AfterModel",
				"BeforeTool",
				"AfterTool",
				"PreCompress",
				"Notification",
			].sort(),
		);
	});
	it("targets the project-scope settings path for a non-user scope", () => {
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked", "project");
		expect(frag.path).toBe(".gemini/settings.json");
	});
});

describe("Gemini CLI parseHookInput — field fallbacks and edge shapes", () => {
	it("falls back to {} when nativeJson is not an object", () => {
		const event = adapter.parseHookInput(null, "BeforeTool");
		expect(event.session_id).toBe("unknown");
		expect(event.context.cwd).toBe(process.cwd());
	});
	it("falls back to {} when nativeJson is an array", () => {
		const event = adapter.parseHookInput([1, 2, 3], "BeforeTool");
		expect(event.session_id).toBe("unknown");
	});
	it("uses sessionId when session_id is absent", () => {
		const event = adapter.parseHookInput({ sessionId: "gem-cc" }, "BeforeTool");
		expect(event.session_id).toBe("gem-cc");
	});
	it("uses process.cwd() when cwd is absent", () => {
		const event = adapter.parseHookInput({ session_id: "x" }, "BeforeTool");
		expect(event.context.cwd).toBe(process.cwd());
	});
	it("maps an unrecognized native event name to the 'other' phase", () => {
		const event = adapter.parseHookInput({ session_id: "x" }, "SomeFutureEvent");
		expect(event.phase).toBe("other");
	});
	it("builds an 'other' action for a native event that isn't Before/After/PreCompress", () => {
		const event = adapter.parseHookInput({ session_id: "x", foo: "bar" }, "AfterModel");
		expect(event.action).toEqual({ kind: "other", subkind: "AfterModel", data: { session_id: "x", foo: "bar" } });
	});
	it("uses toolName when tool_name is absent, defaults to unknown when neither present", () => {
		const withToolName = adapter.parseHookInput({ session_id: "x", toolName: "Grep" }, "BeforeTool");
		if (withToolName.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(withToolName.action.tool_name).toBe("grep");

		const withNeither = adapter.parseHookInput({ session_id: "x" }, "BeforeTool");
		if (withNeither.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(withNeither.action.tool_name).toBe("unknown");
	});
	it("falls back through toolInput then arguments for tool_input", () => {
		const viaToolInput = adapter.parseHookInput(
			{ session_id: "x", tool_name: "edit_file", toolInput: { a: 1 } },
			"BeforeTool",
		);
		if (viaToolInput.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(viaToolInput.action.tool_input).toEqual({ a: 1 });

		const viaArguments = adapter.parseHookInput(
			{ session_id: "x", tool_name: "edit_file", arguments: { b: 2 } },
			"BeforeTool",
		);
		if (viaArguments.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(viaArguments.action.tool_input).toEqual({ b: 2 });
	});
	it("AfterTool carries tool_response and tool_error through, with response/error fallbacks", () => {
		const event = adapter.parseHookInput(
			{
				session_id: "x",
				tool_name: "edit_file",
				tool_input: {},
				response: { ok: true },
				error: "boom",
			},
			"AfterTool",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action).toMatchObject({ tool_response: { ok: true }, tool_error: "boom" });
	});
	it("AfterTool with no response/error fields leaves tool_error undefined", () => {
		const event = adapter.parseHookInput(
			{ session_id: "x", tool_name: "edit_file", tool_input: {} },
			"AfterTool",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_error).toBeUndefined();
	});
});
