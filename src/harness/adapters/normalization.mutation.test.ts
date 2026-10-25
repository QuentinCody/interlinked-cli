import { describe, expect, it } from "vitest";
import {
	buildStandardAction,
	normalizeNativeHookEvent,
	normalizeToolName,
	type NormalizeNativeHookOptions,
} from "./normalization.js";
import {
	CLAUDE_CODE_CAPABILITIES,
	CODEX_CAPABILITIES,
} from "./provider-capabilities.js";

function normalize(
	nativeJson: unknown,
	nativeEventName = "PreToolUse",
	extra: Partial<NormalizeNativeHookOptions> = {},
	capabilities: NormalizeNativeHookOptions["capabilities"] = CODEX_CAPABILITIES,
) {
	return normalizeNativeHookEvent({
		runner: "codex",
		capabilities,
		nativeEventName,
		nativeJson,
		now: () => new Date("2026-08-30T12:34:56.000Z"),
		makeEventId: () => "evt-fixed",
		buildAction: ({ raw, phase }) =>
			buildStandardAction({ raw, phase, nativeEventName }),
		...extra,
	});
}

describe("turn id / parent event id bridge", () => {
	it("exposes the turn id as parent_event_id when the compatibility bridge is on", () => {
		const event = normalize({ turn_id: "t1" }, "PreToolUse", {
			turnIdAsParentEventId: true,
		});
		expect(event.parent_event_id).toBe("t1");
		expect(event.turn_id).toBe("t1");
	});

	it("does not invent a parent_event_id from the turn id when the bridge is off", () => {
		const event = normalize({ turn_id: "t1" });
		expect("parent_event_id" in event).toBe(false);
		expect(event.turn_id).toBe("t1");
	});

	it("prefers a native parent event id over the bridged turn id", () => {
		const event = normalize(
			{ turn_id: "t1", parent_event_id: "p1" },
			"PreToolUse",
			{ turnIdAsParentEventId: true },
		);
		expect(event.parent_event_id).toBe("p1");
	});
});

describe("default envelope fallbacks and aliases", () => {
	it("falls back to the process working directory when the payload has no cwd", () => {
		expect(normalize({}).context.cwd).toBe(process.cwd());
	});

	it("reads the runner version from the plain 'version' key", () => {
		expect(normalize({ version: "9.9.9" }).runner_version).toBe("9.9.9");
	});

	it("reads the turn id from prompt_id", () => {
		expect(normalize({ prompt_id: "pr-1" }).turn_id).toBe("pr-1");
	});

	it("reads the agent role from agent_type", () => {
		expect(normalize({ agent_type: "reviewer" }).context.agent).toEqual({
			role: "reviewer",
		});
	});

	it("prefers agent_id over agent_name when both are present", () => {
		const event = normalize({ agent_id: "a-1", agent_name: "named" });
		expect(event.context.agent?.id).toBe("a-1");
	});

	it("ignores non-string values and falls through to the next alias", () => {
		expect(normalize({ session_id: 42 }).session_id).toBe("unknown");
		expect(normalize({ session_id: 42, sessionId: "s-2" }).session_id).toBe(
			"s-2",
		);
	});

	it("honours caller alias overrides while keeping defaults for other fields", () => {
		const event = normalize({ sid: "custom", cwd: "/w" }, "PreToolUse", {
			aliases: { sessionId: ["sid"] },
		});
		expect(event.session_id).toBe("custom");
		expect(event.context.cwd).toBe("/w");
	});
});

describe("optional envelope fields are omitted when absent", () => {
	it("emits no optional keys for a payload carrying only a cwd", () => {
		const event = normalize({ cwd: "/only" });
		expect(Object.keys(event.context)).toEqual(["cwd"]);
		for (const key of [
			"parent_event_id",
			"tool_use_id",
			"turn_id",
			"runner_version",
			"observation",
		]) {
			expect(key in event).toBe(false);
		}
	});

	it("emits only the agent id when no role is supplied", () => {
		const agent = normalize({ agent_id: "a-1" }).context.agent;
		expect(agent).toBeDefined();
		expect(Object.keys(agent ?? {})).toEqual(["id"]);
	});

	it("emits only the agent role when no id is supplied", () => {
		const agent = normalize({ agent_role: "r" }).context.agent;
		expect(agent).toBeDefined();
		expect(Object.keys(agent ?? {})).toEqual(["role"]);
	});
});

describe("native hook observations", () => {
	it("attaches a filesystem observation for a declared file-change event", () => {
		const event = normalize(
			{ file_path: "/repo/a.ts", event: "change" },
			"FileChanged",
			{},
			CLAUDE_CODE_CAPABILITIES,
		);
		expect(event.phase).toBe("file-change");
		expect(event.observation).toMatchObject({
			kind: "filesystem",
			path: "/repo/a.ts",
			operation: "change",
		});
	});
});

describe("buildStandardAction", () => {
	const base = { nativeEventName: "X" };

	it("reads a user prompt from the 'message' key and defaults to empty text", () => {
		expect(
			buildStandardAction({ ...base, phase: "user-prompt", raw: { message: "hi" } }),
		).toEqual({ kind: "user_prompt", text: "hi" });
		expect(
			buildStandardAction({ ...base, phase: "user-prompt", raw: {} }),
		).toEqual({ kind: "user_prompt", text: "" });
	});

	it("maps session lifecycle phases to start, end and stop", () => {
		const event = (phase: "session-start" | "session-end" | "stop") =>
			buildStandardAction({ ...base, phase, raw: {} });
		expect(event("session-start")).toEqual({ kind: "session_lifecycle", event: "start" });
		expect(event("session-end")).toEqual({ kind: "session_lifecycle", event: "end" });
		expect(event("stop")).toEqual({ kind: "session_lifecycle", event: "stop" });
	});

	it("treats a permission request as a tool call", () => {
		const action = normalize(
			{ tool_name: "Bash", tool_input: { command: "ls" } },
			"PermissionRequest",
		).action;
		expect(action.kind).toBe("tool_call");
	});

	it("names unknown tools 'unknown' and defaults the input to an empty object", () => {
		const action = buildStandardAction({ ...base, phase: "pre-tool", raw: {} });
		expect(action).toMatchObject({
			kind: "tool_call",
			tool_name: "unknown",
		});
		expect((action as { tool_input?: unknown }).tool_input).toEqual({});
		expect((action as { tool_input_redacted?: unknown }).tool_input_redacted).toEqual({});
	});

	it("keeps the redacted input equal to the supplied input", () => {
		const input = { command: "ls -la" };
		const action = buildStandardAction({
			...base,
			phase: "pre-tool",
			raw: { tool_name: "Bash", tool_input: input },
		});
		expect(action).toMatchObject({ tool_input: input, tool_input_redacted: input });
	});

	it("does not attach a response or error to a pre-tool call", () => {
		const action = buildStandardAction({
			...base,
			phase: "pre-tool",
			raw: { tool_name: "Bash", response: "late", error: "late" },
		});
		expect("tool_response" in action).toBe(false);
		expect("tool_error" in action).toBe(false);
	});

	it("attaches the response and error to a post-tool call", () => {
		const action = buildStandardAction({
			...base,
			phase: "post-tool",
			raw: { tool_name: "Bash", response: "ok", error_message: "boom" },
		});
		expect(action).toMatchObject({ tool_response: "ok", tool_error: "boom" });
	});

	it("leaves tool_error undefined on a post-tool call without an error", () => {
		const action = buildStandardAction({
			...base,
			phase: "post-tool",
			raw: { tool_name: "Bash", response: "ok" },
		});
		expect((action as { tool_error?: unknown }).tool_error).toBeUndefined();
	});

	it("lets a defined null value win over later alias keys", () => {
		const action = buildStandardAction({
			...base,
			phase: "post-tool",
			raw: { tool_name: "Bash", tool_response: null, response: "later" },
		});
		expect((action as { tool_response?: unknown }).tool_response).toBeNull();
	});

	it("applies a caller tool-name classification override", () => {
		const overrides = {
			tool_name_classes: { MyCustomTool: "side-effect" as const },
			command_substrings: [],
		};
		const action = buildStandardAction({
			...base,
			phase: "pre-tool",
			raw: { tool_name: "MyCustomTool" },
			overrides,
		});
		expect(action).toMatchObject({ tool_class: "side-effect" });
	});

	it("labels non-tool phases with compact subkinds", () => {
		const subkind = (phase: "pre-compact" | "post-compact" | "error") =>
			buildStandardAction({ phase, nativeEventName: "Native", raw: {} });
		expect(subkind("pre-compact")).toMatchObject({ kind: "other", subkind: "pre_compact" });
		expect(subkind("post-compact")).toMatchObject({ kind: "other", subkind: "post_compact" });
		expect(subkind("error")).toMatchObject({ kind: "other", subkind: "error" });
	});
});

describe("normalizeToolName", () => {
	it("splits a lower-case-or-digit to upper-case boundary", () => {
		expect(normalizeToolName("v2Tool")).toBe("v2_tool");
	});

	it("collapses runs of separators into one underscore", () => {
		expect(normalizeToolName("a  b")).toBe("a_b");
		expect(normalizeToolName("a.-b")).toBe("a_b");
	});

	it("trims leading and trailing underscores of any length", () => {
		expect(normalizeToolName("__a__")).toBe("a");
	});
});
