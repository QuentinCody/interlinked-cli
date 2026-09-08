import { flatHookSettings } from "./test-output.js";
import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import { createCopilotCliAdapter } from "./copilot-cli.js";

const adapter = createCopilotCliAdapter();

// A minimal event for encodeDecision tests — encodeDecision ignores the event
// argument entirely (the `_event` param), so its concrete contents are
// irrelevant; this keeps the per-test boilerplate down.
const dummyEvent: UnifiedHookEvent = adapter.parseHookInput(
	{ sessionId: "enc", toolName: "shell", toolInput: { command: "ls" } },
	"preToolUse",
);

function copilotDenyPayload(out: ReturnType<typeof adapter.encodeDecision>): {
	permissionDecision: string;
	permissionDecisionReason: string;
} {
	return JSON.parse(out.stdout ?? "");
}

describe("Copilot CLI adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("copilot-cli");
	});
	it("lists camelCase native events", () => {
		expect(adapter.nativeEventNames).toContain("preToolUse");
		expect(adapter.nativeEventNames).toContain("sessionStart");
	});
});

describe("Copilot CLI detectFromEnv", () => {
	it("detects GH_COPILOT_CLI env", () => {
		expect(adapter.detectFromEnv({ GH_COPILOT_CLI: "1" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Copilot CLI parseHookInput — preToolUse", () => {
	const event = adapter.parseHookInput(
		{
			sessionId: "cs-1",
			cwd: "/repo",
			toolName: "edit_file",
			toolInput: { path: "/repo/a.ts" },
		},
		"preToolUse",
	);
	it("has phase pre-tool", () => {
		expect(event.phase).toBe("pre-tool");
	});
	it("maps edit_file to modify", () => {
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("modify");
	});
	it("preserves sessionId", () => {
		expect(event.session_id).toBe("cs-1");
	});
});

describe("Copilot CLI parseHookInput — shell via command classifier", () => {
	const event = adapter.parseHookInput(
		{ sessionId: "cs-2", toolName: "shell", toolInput: { command: "git push" } },
		"preToolUse",
	);
	it("classifies shell git push as side-effect", () => {
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("side-effect");
	});
});

describe("Copilot CLI parseHookInput — documented JSON-string toolArgs", () => {
	it("decodes toolArgs before command classification", () => {
		const event = adapter.parseHookInput(
			{ sessionId: "args-1", toolName: "shell", toolArgs: JSON.stringify({ command: "git push" }) },
			"preToolUse",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_input).toEqual({ command: "git push" });
		expect(event.action.tool_class).toBe("side-effect");
	});

	it("documented toolArgs wins over a conflicting legacy toolInput field", () => {
		const event = adapter.parseHookInput(
			{
				sessionId: "args-2",
				toolName: "shell",
				toolArgs: JSON.stringify({ command: "git push" }),
				toolInput: { command: "git status" },
			},
			"preToolUse",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_input).toEqual({ command: "git push" });
	});

	it("malformed toolArgs cannot fall through to a read-looking legacy field", () => {
		const event = adapter.parseHookInput(
			{
				sessionId: "args-3",
				toolName: "shell",
				toolArgs: "{not-json",
				toolInput: { command: "git status" },
			},
			"preToolUse",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_input).toEqual({});
		expect(event.action.tool_class).not.toBe("read");
	});
});

describe("Copilot CLI renderSettingsFragment", () => {
	const frag = adapter.renderSettingsFragment("/bin/hook", "project");
	it("writes to .github/hooks/hooks.json", () => {
		expect(frag.path).toBe(".github/hooks/hooks.json");
	});
	it("includes version: 1", () => {
		const f = flatHookSettings(frag.fragment);
		expect(f.version).toBe(1);
	});
	it("passes runner and event to the shared hook entry", () => {
		const f = flatHookSettings(frag.fragment);
		expect(nonNull(nonNull(f.hooks.preToolUse)[0]).bash).toContain("--runner 'copilot-cli'");
		expect(nonNull(nonNull(f.hooks.preToolUse)[0]).bash).toContain("--event 'preToolUse'");
		expect(nonNull(nonNull(f.hooks.preToolUse)[0]).bash).toContain("if test -f");
		expect(nonNull(nonNull(f.hooks.preToolUse)[0]).bash).not.toContain("|| true");
	});
});

describe("Copilot CLI encodeDecision", () => {
	const event = adapter.parseHookInput(
		{ sessionId: "x", toolName: "shell", toolInput: { command: "ls" } },
		"preToolUse",
	);
	it("allow exits 0", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.exit_code).toBe(0);
	});
	it("block emits Copilot's deny JSON on stdout", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "nope" }, event);
		expect(out.exit_code).toBe(0);
		expect(copilotDenyPayload(out)).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason: "nope",
		});
	});
	it("ask collapses to deny until the installed runtime's approval is certified", () => {
		// Regression guard: previously this returned exit 0 with a stderr note,
		// which let destructive ask rules (curl DELETE, GraphQL mutations)
		// proceed unchecked on Copilot. The Copilot CLI ignores stderr from
		// non-deny hooks, so the user never saw the prompt and the call ran.
		// Current CLI docs support ask; earlier versions do not. The unknown
		// runtime path and the generated .mjs path retain conservative denial.
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(out.exit_code).toBe(0);
		expect(copilotDenyPayload(out)).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason: "confirm?",
		});
	});
});

// ---------------------------------------------------------------------------
// classifyToolClass — adapter method (distinct from the classifier baked into
// parseHookInput). Drives both the with-overrides and without-overrides paths.
// ---------------------------------------------------------------------------
describe("Copilot CLI classifyToolClass", () => {
	it("classifies read_file as read (no overrides)", () => {
		expect(adapter.classifyToolClass("read_file", {})).toBe("read");
	});
	it("classifies a shell git push as side-effect by inspecting the command", () => {
		expect(adapter.classifyToolClass("shell", { command: "git push" })).toBe("side-effect");
	});
	it("honors a tool_name override, changing the resolved class", () => {
		// read_file defaults to "read"; the override flips it to "side-effect".
		const overridden = createCopilotCliAdapter({
			overrides: { tool_name_classes: { read_file: "side-effect" }, command_substrings: [] },
		});
		expect(adapter.classifyToolClass("read_file", {})).toBe("read");
		expect(overridden.classifyToolClass("read_file", {})).toBe("side-effect");
	});
});

// ---------------------------------------------------------------------------
// parseHookInput — tolerant-parsing fallbacks. Each fallback (non-object input,
// missing session id, snake_case keys, missing cwd) is a distinct branch.
// ---------------------------------------------------------------------------
describe("Copilot CLI parseHookInput — defensive fallbacks", () => {
	it("tolerates a non-object payload: session_id 'unknown', cwd = process.cwd()", () => {
		const event = adapter.parseHookInput("not-an-object", "preToolUse");
		expect(event.session_id).toBe("unknown");
		expect(event.context.cwd).toBe(process.cwd());
		// raw is coerced to {} when the payload is not an object.
		expect(event.raw).toEqual({});
	});

	it("tolerates a null payload the same way", () => {
		const event = adapter.parseHookInput(null, "sessionStart");
		expect(event.session_id).toBe("unknown");
		expect(event.context.cwd).toBe(process.cwd());
	});

	it("falls back to snake_case session_id when camelCase is absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "snake-1", toolName: "read_file", toolInput: {} },
			"preToolUse",
		);
		expect(event.session_id).toBe("snake-1");
	});

	it("defaults cwd to process.cwd() when the payload omits it", () => {
		const event = adapter.parseHookInput(
			{ sessionId: "no-cwd", toolName: "read_file", toolInput: {} },
			"preToolUse",
		);
		expect(event.context.cwd).toBe(process.cwd());
	});

	it("preserves an explicit cwd and stamps a parseable ISO timestamp + runner", () => {
		const event = adapter.parseHookInput(
			{ sessionId: "s", cwd: "/explicit/path", toolName: "read_file", toolInput: {} },
			"preToolUse",
		);
		expect(event.context.cwd).toBe("/explicit/path");
		expect(event.runner).toBe("copilot-cli");
		expect(event.runner_native_event).toBe("preToolUse");
		expect(event.schema_version).toBe("1");
		expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
		expect(event.event_id.startsWith("evt-")).toBe(true);
	});

	it("maps an unrecognized native event name to phase 'other'", () => {
		const event = adapter.parseHookInput({ sessionId: "s" }, "somethingNew");
		expect(event.phase).toBe("other");
	});
});

// ---------------------------------------------------------------------------
// parseHookInput action shapes — exercises every branch of buildCopilotAction.
// ---------------------------------------------------------------------------
describe("Copilot CLI parseHookInput — userPromptSubmitted action", () => {
	it("reads the camelCase-free `prompt` field", () => {
		const event = adapter.parseHookInput(
			{ sessionId: "p1", prompt: "do the thing" },
			"userPromptSubmitted",
		);
		expect(event.phase).toBe("user-prompt");
		if (event.action.kind !== "user_prompt") throw new Error("expected user_prompt");
		expect(event.action.text).toBe("do the thing");
	});

	it("falls back to `userPrompt` when `prompt` is absent", () => {
		const event = adapter.parseHookInput(
			{ sessionId: "p2", userPrompt: "alt field" },
			"userPromptSubmitted",
		);
		if (event.action.kind !== "user_prompt") throw new Error("expected user_prompt");
		expect(event.action.text).toBe("alt field");
	});

	it("defaults to empty text when neither prompt field is present", () => {
		const event = adapter.parseHookInput({ sessionId: "p3" }, "userPromptSubmitted");
		if (event.action.kind !== "user_prompt") throw new Error("expected user_prompt");
		expect(event.action.text).toBe("");
	});
});

describe("Copilot CLI parseHookInput — session lifecycle action", () => {
	it("sessionStart maps to event 'start'", () => {
		const event = adapter.parseHookInput({ sessionId: "ls1" }, "sessionStart");
		expect(event.phase).toBe("session-start");
		if (event.action.kind !== "session_lifecycle") throw new Error("expected session_lifecycle");
		expect(event.action.event).toBe("start");
	});

	it("sessionEnd maps to event 'end'", () => {
		const event = adapter.parseHookInput({ sessionId: "ls2" }, "sessionEnd");
		expect(event.phase).toBe("session-end");
		if (event.action.kind !== "session_lifecycle") throw new Error("expected session_lifecycle");
		expect(event.action.event).toBe("end");
	});
});

describe("Copilot CLI parseHookInput — tool-call snake_case + lowercasing", () => {
	it("reads snake_case tool_name/tool_input and lowercases the tool name", () => {
		const event = adapter.parseHookInput(
			{ sessionId: "t1", tool_name: "Read_File", tool_input: { path: "/x" } },
			"preToolUse",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		// tool_name is normalized to lowercase by buildCopilotAction.
		expect(event.action.tool_name).toBe("read_file");
		expect(event.action.tool_class).toBe("read");
		expect(event.action.tool_input).toEqual({ path: "/x" });
		// pre-tool carries no response/error fields.
		expect("tool_response" in event.action).toBe(false);
	});

	it("defaults tool_name to 'unknown' and tool_input to {} when both are absent", () => {
		const event = adapter.parseHookInput({ sessionId: "t2" }, "preToolUse");
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_name).toBe("unknown");
		expect(event.action.tool_input).toEqual({});
	});

	it("applies classifier overrides inside the parsed pre-tool action", () => {
		const overridden = createCopilotCliAdapter({
			overrides: { tool_name_classes: { read_file: "side-effect" }, command_substrings: [] },
		});
		const event = overridden.parseHookInput(
			{ sessionId: "t3", toolName: "read_file", toolInput: {} },
			"preToolUse",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_class).toBe("side-effect");
	});
});

describe("Copilot CLI parseHookInput — postToolUse action", () => {
	it("carries camelCase toolResponse and toolError", () => {
		const event = adapter.parseHookInput(
			{
				sessionId: "post1",
				toolName: "shell",
				toolInput: { command: "ls" },
				toolResponse: { stdout: "ok" },
				toolError: "boom",
			},
			"postToolUse",
		);
		expect(event.phase).toBe("post-tool");
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_response).toEqual({ stdout: "ok" });
		expect(event.action.tool_error).toBe("boom");
	});

	it("falls back to snake_case tool_response and tool_error", () => {
		const event = adapter.parseHookInput(
			{
				session_id: "post2",
				tool_name: "shell",
				tool_input: { command: "ls" },
				tool_response: { stdout: "snake" },
				tool_error: "snake-err",
			},
			"postToolUse",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_response).toEqual({ stdout: "snake" });
		expect(event.action.tool_error).toBe("snake-err");
	});

	it("leaves tool_error undefined when neither error field is present", () => {
		const event = adapter.parseHookInput(
			{ sessionId: "post3", toolName: "shell", toolInput: { command: "ls" } },
			"postToolUse",
		);
		if (event.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(event.action.tool_error).toBeUndefined();
		expect(event.action.tool_response).toBeUndefined();
	});
});

describe("Copilot CLI parseHookInput — error + unknown event actions", () => {
	it("errorOccurred becomes an `other`/error action carrying the raw payload", () => {
		const raw = { sessionId: "e1", message: "kaboom", code: 7 };
		const event = adapter.parseHookInput(raw, "errorOccurred");
		expect(event.phase).toBe("error");
		if (event.action.kind !== "other") throw new Error("expected other");
		expect(event.action.subkind).toBe("error");
		expect(event.action.data).toEqual(raw);
	});

	it("an unrecognized event becomes an `other` action keyed by the event name", () => {
		const raw = { sessionId: "u1", foo: "bar" };
		const event = adapter.parseHookInput(raw, "FutureBoundary");
		if (event.action.kind !== "other") throw new Error("expected other");
		expect(event.action.subkind).toBe("FutureBoundary");
		expect(event.action.data).toEqual(raw);
	});
});

// ---------------------------------------------------------------------------
// renderSettingsFragment — fragment shape across every native event + scope.
// ---------------------------------------------------------------------------
describe("Copilot CLI renderSettingsFragment — full shape", () => {
	it("emits an array-append fragment with one command hook per native event", () => {
		const frag = adapter.renderSettingsFragment("/bin/hook", "user");
		expect(frag.mergeStrategy).toBe("array-append");
		const f = flatHookSettings(frag.fragment);
		for (const ev of adapter.nativeEventNames) {
			const entries = f.hooks[ev];
			expect(Array.isArray(entries)).toBe(true);
			expect(entries).toHaveLength(1);
			expect(nonNull(nonNull(entries)[0]).type).toBe("command");
			expect(nonNull(nonNull(entries)[0]).bash).toContain(`--event '${ev}'`);
			expect(nonNull(nonNull(entries)[0]).bash).toContain("node");
			expect(nonNull(nonNull(entries)[0]).bash).toContain("/bin/hook");
		}
	});

	it("shell-quotes a binary path that contains a single quote (injection-safe)", () => {
		const frag = adapter.renderSettingsFragment("/weird/it's-here/hook", "project");
		const f = flatHookSettings(frag.fragment);
		// The single quote is escaped via the '\'' shell idiom.
		expect(nonNull(nonNull(f.hooks.preToolUse)[0]).bash).toContain("'\\''");
	});
});

// ---------------------------------------------------------------------------
// encodeDecision — remaining branches: default reasons, warnings prefixing,
// allow + additional_context, and resolved_targets rendering.
// ---------------------------------------------------------------------------
describe("Copilot CLI encodeDecision — block branches", () => {
	it("uses an actionable default reason when block carries none", () => {
		const out = adapter.encodeDecision({ decision: "block" }, dummyEvent);
		expect(out.exit_code).toBe(0);
		// A reason-less block falls back to an actionable message (finding 2026-06:
		// agents reported opaque "no detail" blocks). Pin the stable anchor + the
		// actionable hint, not the exact wording.
		expect(copilotDenyPayload(out).permissionDecisionReason).toContain("interlinked harness");
		expect(copilotDenyPayload(out).permissionDecisionReason).toContain("no reason");
	});

	it("prefixes warnings before the reason on a block", () => {
		const decision: HarnessDecision = {
			decision: "block",
			reason: "denied",
			warnings: ["w1", "w2"],
		};
		const out = adapter.encodeDecision(decision, dummyEvent);
		expect(out.exit_code).toBe(0);
		expect(out.stderr).toBe("w1\nw2");
		expect(copilotDenyPayload(out).permissionDecisionReason).toBe("denied");
	});

	it("appends resolved targets as a bullet list after the block reason", () => {
		const decision: HarnessDecision = {
			decision: "block",
			reason: "no force push",
			resolved_targets: [{ kind: "branch", value: "main" }],
		};
		const out = adapter.encodeDecision(decision, dummyEvent);
		expect(out.exit_code).toBe(0);
		expect(copilotDenyPayload(out).permissionDecisionReason).toContain("no force push");
		expect(copilotDenyPayload(out).permissionDecisionReason).toContain("Targets:");
		expect(copilotDenyPayload(out).permissionDecisionReason).toContain("branch: main");
	});
});

describe("Copilot CLI encodeDecision — ask branches", () => {
	it("uses a default reason when ask carries none", () => {
		const out = adapter.encodeDecision({ decision: "ask" }, dummyEvent);
		expect(out.exit_code).toBe(0);
		expect(copilotDenyPayload(out).permissionDecisionReason).toBe("Confirmation required");
	});

	it("prefixes warnings and appends resolved targets on an ask-as-deny", () => {
		const decision: HarnessDecision = {
			decision: "ask",
			reason: "delete this file?",
			warnings: ["heads up"],
			resolved_targets: [{ kind: "file", value: "/repo/danger.ts" }],
		};
		const out = adapter.encodeDecision(decision, dummyEvent);
		expect(out.exit_code).toBe(0);
		expect(out.stderr).toBe("heads up");
		expect(copilotDenyPayload(out).permissionDecisionReason).toContain("delete this file?");
		expect(copilotDenyPayload(out).permissionDecisionReason).toContain("file: /repo/danger.ts");
	});
});

describe("Copilot CLI encodeDecision — allow branches", () => {
	it("plain allow with no warnings/context yields undefined stderr, exit 0", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, dummyEvent);
		expect(out.exit_code).toBe(0);
		expect(out.stderr).toBeUndefined();
	});

	it("allow surfaces warnings on stderr while still exiting 0", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["note A", "note B"] },
			dummyEvent,
		);
		expect(out.exit_code).toBe(0);
		expect(out.stderr).toBe("note A\nnote B");
	});

	it("allow with additional_context only puts the context on stderr", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "ctx info" },
			dummyEvent,
		);
		expect(out.exit_code).toBe(0);
		expect(out.stderr).toBe("ctx info");
	});

	it("allow appends additional_context after existing warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["warn"], additional_context: "extra" },
			dummyEvent,
		);
		expect(out.exit_code).toBe(0);
		expect(out.stderr).toBe("warn\nextra");
	});
});
