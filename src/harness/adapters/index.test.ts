import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import { buildAllAdapters, detectAdapter, getAdapter } from "./index.js";

describe("buildAllAdapters", () => {
	const adapters = buildAllAdapters();
	it("returns all eight runner adapters", () => {
		expect(adapters.length).toBe(8);
		const ids = adapters.map((a) => a.id).sort();
		expect(ids).toEqual([
			"claude-code",
			"codex",
			"copilot-cli",
			"cursor",
			"gemini-cli",
			"opencode",
			"opencode2",
			"pi",
		]);
	});
	it("every adapter conforms to the basic interface", () => {
		for (const a of adapters) {
			expect(typeof a.parseHookInput).toBe("function");
			expect(typeof a.classifyToolClass).toBe("function");
			expect(typeof a.renderSettingsFragment).toBe("function");
			expect(typeof a.encodeDecision).toBe("function");
			expect(typeof a.detectFromEnv).toBe("function");
			expect(a.nativeEventNames.length).toBeGreaterThan(0);
		}
	});
});

describe("detectAdapter", () => {
	it("returns null for a plain env", () => {
		expect(detectAdapter({})).toBeNull();
	});
	it("prefers claude-code when CLAUDE_CODE env is set", () => {
		const a = detectAdapter({ CLAUDE_CODE: "1" });
		expect(a?.id).toBe("claude-code");
	});
	it("detects cursor via CURSOR_SESSION_ID", () => {
		const a = detectAdapter({ CURSOR_SESSION_ID: "c-1" });
		expect(a?.id).toBe("cursor");
	});
	it("detects copilot-cli via GH_COPILOT_CLI", () => {
		const a = detectAdapter({ GH_COPILOT_CLI: "1" });
		expect(a?.id).toBe("copilot-cli");
	});
	it("detects gemini-cli via GEMINI_API_KEY", () => {
		const a = detectAdapter({ GEMINI_API_KEY: "k" });
		expect(a?.id).toBe("gemini-cli");
	});
	it("detects codex via CODEX_CLI", () => {
		const a = detectAdapter({ CODEX_CLI: "1" });
		expect(a?.id).toBe("codex");
	});
	it("detects OpenCode via OPENCODE", () => {
		expect(detectAdapter({ OPENCODE: "1" })?.id).toBe("opencode");
	});
	it("detects OpenCode v2 via OPENCODE2 before OPENCODE*", () => {
		expect(detectAdapter({ OPENCODE2: "1" })?.id).toBe("opencode2");
	});
	it("detects Pi via PI_CODING_AGENT", () => {
		expect(detectAdapter({ PI_CODING_AGENT: "1" })?.id).toBe("pi");
	});
});

describe("getAdapter", () => {
	it("returns the adapter with a matching id", () => {
		expect(getAdapter("claude-code")?.id).toBe("claude-code");
		expect(getAdapter("copilot-cli")?.id).toBe("copilot-cli");
		expect(getAdapter("cursor")?.id).toBe("cursor");
		expect(getAdapter("opencode")?.id).toBe("opencode");
		expect(getAdapter("opencode2")?.id).toBe("opencode2");
		expect(getAdapter("pi")?.id).toBe("pi");
	});
	it("returns null for unknown ids", () => {
		expect(getAdapter("unknown")).toBeNull();
	});
});

describe("cross-runner equivalence — semantically identical Edit events", () => {
	// Same file edit coming from different runners should produce the same
	// tool_class. We do not assert identical HarnessDecision here since the
	// evaluator layer is not yet wired; this test checks the envelope is
	// consistent enough to be evaluated by the same check set.
	const runners: Array<[string, UnifiedHookEvent]> = [
		[
			"claude",
			nonNull(buildAllAdapters()[0]).parseHookInput(
				{
					session_id: "s",
					cwd: "/r",
					tool_name: "Edit",
					tool_input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" },
				},
				"PreToolUse",
			),
		],
		[
			"copilot",
			nonNull(buildAllAdapters()[1]).parseHookInput(
				{
					sessionId: "s",
					cwd: "/r",
					toolName: "edit_file",
					toolInput: { path: "/r/a.ts" },
				},
				"preToolUse",
			),
		],
		[
			"cursor",
			nonNull(buildAllAdapters()[2]).parseHookInput(
				{
					session_id: "s",
					cwd: "/r",
					tool_name: "Edit",
					tool_input: { file_path: "/r/a.ts" },
				},
				"preToolUse",
			),
		],
		[
			"gemini",
			nonNull(buildAllAdapters()[3]).parseHookInput(
				{
					session_id: "s",
					cwd: "/r",
					tool_name: "Edit",
					tool_input: { file_path: "/r/a.ts" },
				},
				"BeforeTool",
			),
		],
		[
			"codex",
			nonNull(buildAllAdapters()[4]).parseHookInput(
				{
					session_id: "s",
					cwd: "/r",
					tool_name: "Edit",
					tool_input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" },
				},
				"PreToolUse",
			),
		],
		[
			"opencode2",
			nonNull(buildAllAdapters()[5]).parseHookInput(
				{
					sessionID: "s",
					cwd: "/r",
					tool: "edit",
					args: { filePath: "/r/a.ts", oldString: "x", newString: "y" },
				},
				"tool.execute.before",
			),
		],
	];
	for (const [name, event] of runners) {
		it(`${name} Edit → modify tool_class`, () => {
			if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
			expect(event.action.tool_class).toBe("modify");
		});
	}
});

describe("encodeDecision maps the same allow across adapters", () => {
	const adapters = buildAllAdapters();
	const decision: HarnessDecision = { decision: "allow" };
	for (const a of adapters) {
		it(`${a.id} allow → exit 0`, () => {
			const event = a.parseHookInput(
				{ session_id: "s", tool_name: "Read", cwd: "/r" },
				nonNull(a.nativeEventNames[0]),
			);
			const out = a.encodeDecision(decision, event);
			expect(out.exit_code).toBe(0);
		});
	}
});
