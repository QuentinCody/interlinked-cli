import { nestedHookSettings } from "./test-output.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { CODEX_WRITE_TOOLS } from "../../lib/write-tool-registry.js";
import { CODEX_POST_TOOL_USE_MATCHER, codexRegistration, createCodexAdapter } from "./codex.js";

const adapter = createCodexAdapter();
const overriddenAdapter = createCodexAdapter({
	overrides: {
		tool_name_classes: { CustomTool: "side-effect" },
		command_substrings: [],
	},
});

describe("Codex adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("codex");
	});
	it("is no longer marked experimental", () => {
		// Codex shipped its hook contract in 2026-04 with PascalCase event
		// names that mirror Claude Code's vocabulary, so the adapter is
		// no longer experimental.
		expect(adapter.experimental).toBe(false);
	});
	it("lists native event names in PascalCase", () => {
		expect(adapter.nativeEventNames).toEqual([
			"SessionStart",
			"SessionEnd",
			"UserPromptSubmit",
			"Stop",
			"PreToolUse",
			"PermissionRequest",
			"PostToolUse",
			"PreCompact",
			"PostCompact",
			"SubagentStart",
			"SubagentStop",
			"Interrupt",
		]);
	});
});

describe("Codex detectFromEnv", () => {
	it("detects CODEX_CLI env", () => {
		expect(adapter.detectFromEnv({ CODEX_CLI: "1" })).toBe(true);
	});
	it("detects INTERLINKED_CLIENT=codex", () => {
		expect(adapter.detectFromEnv({ INTERLINKED_CLIENT: "codex" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Codex parseHookInput — PreToolUse", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "cx-1",
			cwd: "/repo",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			turn_id: "turn-7",
		},
		"PreToolUse",
	);
	it("produces a tool_call action with the canonical tool name", () => {
		expect(event.action).toMatchObject({ kind: "tool_call", tool_name: "bash" });
	});
	it("propagates Codex turn_id as parent_event_id", () => {
		expect(event.parent_event_id).toBe("turn-7");
		expect(event.turn_id).toBe("turn-7");
	});
	it("uses the canonical pre-tool phase", () => {
		expect(event.phase).toBe("pre-tool");
	});
});

describe("Codex parseHookInput — PostToolUse", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "cx-1b",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			tool_response: "file1\nfile2",
		},
		"PostToolUse",
	);
	it("preserves the tool_response on the action", () => {
		expect(event.action).toMatchObject({
			kind: "tool_call",
			tool_name: "bash",
			tool_response: "file1\nfile2",
		});
	});
	it("uses the canonical post-tool phase", () => {
		expect(event.phase).toBe("post-tool");
	});
});

describe("Codex parseHookInput — UserPromptSubmit", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cx-2", prompt: "make me a coffee" },
		"UserPromptSubmit",
	);
	it("produces a user_prompt action carrying the prompt text", () => {
		expect(event.action).toMatchObject({ kind: "user_prompt", text: "make me a coffee" });
	});
	it("uses the canonical user-prompt phase", () => {
		expect(event.phase).toBe("user-prompt");
	});
});

describe("Codex parseHookInput — Interrupt", () => {
	const event = adapter.parseHookInput(
		{
			cwd: "/repo",
			hook_event_name: "Interrupt",
			model: "gpt-5.6-sol", // REAL_WORLD_VERSION_FIXTURE_OK — exact native Interrupt payload under test.
			permission_mode: "default",
			session_id: "cx-interrupt",
			transcript_path: "/repo/transcript.jsonl",
			turn_id: "turn-interrupt",
		},
		"Interrupt",
	);

	it("preserves the strict seven-field payload as observation-only metadata", () => {
		expect(event.phase).toBe("other");
		expect(event.runner_native_event).toBe("Interrupt");
		expect(event.context).toMatchObject({
			cwd: "/repo",
			model: "gpt-5.6-sol", // REAL_WORLD_VERSION_FIXTURE_OK — exact normalized Interrupt payload under test.
			permission_mode: "default",
			transcript_path: "/repo/transcript.jsonl",
		});
		expect(event.turn_id).toBe("turn-interrupt");
		expect(event.action).toMatchObject({ kind: "other", subkind: "Interrupt" });
	});

	it("always emits zero stdout even if an internal decision carries feedback", () => {
		expect(
			adapter.encodeDecision(
				{ decision: "block", reason: "must not control", warnings: ["must not print"] },
				event,
			),
		).toEqual({ exit_code: 0 });
	});
});

describe("Codex parseHookInput — SessionStart", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cx-3", source: "startup" },
		"SessionStart",
	);
	it("produces a session_lifecycle action with event=start", () => {
		expect(event.action).toMatchObject({ kind: "session_lifecycle", event: "start" });
	});
});

describe("Codex parseHookInput — Stop", () => {
	const event = adapter.parseHookInput({ session_id: "cx-4" }, "Stop");
	it("keeps turn stop distinct from session end", () => {
		expect(event.phase).toBe("stop");
		expect(event.action).toMatchObject({ kind: "session_lifecycle", event: "stop" });
	});
});

describe("Codex encodeDecision — PreToolUse path", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
		"PreToolUse",
	);
	it("allow exits 0 with no stdout", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeUndefined();
	});
	it("block emits the canonical PreToolUse deny shape", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, event);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeDefined();
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no",
			},
		});
	});
	it("ask collapses to block on PreToolUse (no ask primitive)", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed.hookSpecificOutput).toMatchObject({
			permissionDecision: "deny",
			permissionDecisionReason: "confirm?",
		});
	});
});

describe("Codex encodeDecision — PermissionRequest path", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: { command: "ls /etc" } },
		"PermissionRequest",
	);
	it("allow abstains so Codex applies its normal permission policy", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.stdout).toBeUndefined();
	});
	it("ask abstains so Codex can display its native permission prompt", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(out.stdout).toBeUndefined();
	});
	it("block uses hookSpecificOutput.decision.behavior=deny + message", () => {
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "Blocked by repo policy" },
			event,
		);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: "Blocked by repo policy" },
			},
		});
	});
});

describe("Codex renderSettingsFragment", () => {
	it("writes .codex/hooks.json at project scope", () => {
		const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
		expect(fragment.path).toBe(".codex/hooks.json");
	});
	it("writes ~/.codex/hooks.json at user scope", () => {
		const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "user");
		expect(fragment.path).toBe("~/.codex/hooks.json");
	});
	it("includes Claude-shaped {matcher, hooks:[{type, command}]} entries", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = nestedHookSettings(fragment.fragment);
		const entries = nonNull(root.hooks.PreToolUse);
		const handler = nonNull(nonNull(entries[0]).hooks[0]);
		expect(handler).toMatchObject({
			type: "command",
			statusMessage: "Interlinked policy check",
			additionalContextLimit: 2_500,
		});
		expect(handler.command).toContain("/bin/hook");
	});
	it("scopes PostToolUse to Codex's mutating tools", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = nestedHookSettings(fragment.fragment);
		const entries = nonNull(root.hooks.PostToolUse);
		expect(nonNull(entries[0]).matcher).toBe("Bash|apply_patch");
		expect(nonNull(entries[0]).matcher).toBe(CODEX_POST_TOOL_USE_MATCHER);
		expect(CODEX_POST_TOOL_USE_MATCHER.split("|")).toEqual([...CODEX_WRITE_TOOLS]);
	});

	it("uses an empty matcher for every event except PostToolUse", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = nestedHookSettings(fragment.fragment);
		for (const eventName of Object.keys(root.hooks)) {
			const entries = nonNull(root.hooks[eventName]);
			if (eventName === "PostToolUse") continue;
			expect(nonNull(entries[0]).matcher).toBe("");
		}
	});

	it("runs SessionEnd detached within Codex's three-second deadline", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = nestedHookSettings(fragment.fragment);
		const entries = nonNull(root.hooks.SessionEnd);
		const handler = nonNull(nonNull(entries[0]).hooks[0]);
		expect(handler.timeout).toBe(3);
		expect(handler.command).toContain(">/dev/null 2>&1 &");
	});

	it("runs Interrupt asynchronously with a three-second telemetry ceiling", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = nestedHookSettings(fragment.fragment);
		const entries = nonNull(root.hooks.Interrupt);
		const handler = nonNull(nonNull(entries[0]).hooks[0]);
		expect(handler).toMatchObject({ async: true, timeout: 3 });
		expect(handler.additionalContextLimit).toBeUndefined();
	});
});

describe("Codex classifyToolClass", () => {
	it("routes Bash through the command classifier", () => {
		expect(adapter.classifyToolClass("Bash", { command: "git status" })).toBe("read");
	});
	it("uses a supplied tool_name_classes override", () => {
		expect(overriddenAdapter.classifyToolClass("CustomTool", {})).toBe("side-effect");
	});
});

describe("Codex parseHookInput — non-object native payload falls back to {}", () => {
	it("treats a null payload as an empty object (session_id -> 'unknown')", () => {
		const event = adapter.parseHookInput(null, "SessionStart");
		expect(event.session_id).toBe("unknown");
		expect(event.context.cwd).toBe(process.cwd());
	});
	it("treats a string payload as an empty object", () => {
		const event = adapter.parseHookInput("not-an-object", "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
});

describe("Codex parseHookInput — unmapped native event falls back to phase 'other'", () => {
	it("uses phase 'other' for an event name not in PHASE_MAP", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "TeammateIdle");
		expect(event.phase).toBe("other");
	});
});

describe("Codex parseHookInput — missing session_id falls back to 'unknown'", () => {
	it("defaults session_id when absent from the payload", () => {
		const event = adapter.parseHookInput({ cwd: "/repo" }, "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
});

describe("Codex parseHookInput — UserPromptSubmit missing prompt falls back to ''", () => {
	it("defaults text to an empty string when raw.prompt is absent", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "UserPromptSubmit");
		expect(event.action).toMatchObject({ kind: "user_prompt", text: "" });
	});
});

describe("Codex parseHookInput — unrecognized event name falls through to 'other' action", () => {
	it("produces an 'other' action carrying the raw payload", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", foo: "bar" },
			"TeammateIdle",
		);
		expect(event.action).toEqual({
			kind: "other",
			subkind: "TeammateIdle",
			data: { session_id: "s", foo: "bar" },
		});
	});
});

describe("Codex parseHookInput — tool_input edge cases (readToolInput)", () => {
	it("defaults tool_input to {} when absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", tool_name: "Bash" },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
	it("defaults tool_input to {} when it is an array (not a plain object)", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", tool_name: "Bash", tool_input: ["not", "an", "object"] },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
	it("defaults tool_input to {} when it is a primitive", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", tool_name: "Bash", tool_input: "oops" },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
});

describe("Codex parseHookInput — classifier overrides propagate through tool_call actions", () => {
	it("applies a tool_name_classes override on PreToolUse", () => {
		const event = overriddenAdapter.parseHookInput(
			{ session_id: "s", tool_name: "CustomTool", tool_input: {} },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_class: "side-effect" });
	});
});

describe("Codex encodeDecision — block with no reason falls back to the generic message", () => {
	it("uses the generic harness-bug message when reason is absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "c", tool_name: "Bash", tool_input: {} },
			"PreToolUse",
		);
		const out = adapter.encodeDecision({ decision: "block" }, event);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(
			"Blocked by the interlinked harness, but no reason was attached — likely a harness bug; " +
				"re-run, or run `interlinked harness restart`, then report it.",
		);
	});
});

describe("Codex postInstall", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "interlinked-codex-postinstall-"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("dry-run: logs to stderr and does not write config.toml", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(adapter.postInstall).toBeDefined();
			adapter.postInstall?.({ cwd: workdir, scope: "project", dryRun: true });
			expect(spy).toHaveBeenCalledWith(
				expect.stringContaining(
					`[interlinked] codex postInstall (dry-run): would ensure ${workdir}/.codex/config.toml has [features] hooks = true`,
				),
			);
			expect(existsSync(join(workdir, ".codex", "config.toml"))).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("non-dry-run: writes the [features] hooks = true flag to config.toml", () => {
		adapter.postInstall?.({ cwd: workdir, scope: "project", dryRun: false });
		const configPath = join(workdir, ".codex", "config.toml");
		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf-8");
		expect(content).toContain("hooks = true");
	});
});

describe("Codex encodeDecision — allow with additional_context (non-PermissionRequest)", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: {} },
		"PreToolUse",
	);
	it("uses additionalContext so feedback reaches the model", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi only" },
			event,
		);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "fyi only",
			},
		});
	});
	it("joins warnings and additional_context with a newline when both are present", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1"], additional_context: "fyi" },
			event,
		);
		expect(JSON.parse(out.stdout || "{}").hookSpecificOutput.additionalContext).toBe(
			"fyi\nw1",
		);
	});
});

describe("Codex encodeDecision — Stop/SubagentStop continuation path", () => {
	it("allow with no reason and no warnings emits zero bytes (native default continue)", () => {
		const event = adapter.parseHookInput({ session_id: "c" }, "Stop");
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out).toEqual({ exit_code: 0 });
	});
	it("block emits a decision:block continuation payload carrying the reason", () => {
		const event = adapter.parseHookInput({ session_id: "c" }, "Stop");
		const out = adapter.encodeDecision({ decision: "block", reason: "finish the task" }, event);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			decision: "block",
			reason: "finish the task",
		});
	});
	it("SubagentStop with warnings but no reason uses the warnings as the continuation reason", () => {
		const event = adapter.parseHookInput({ session_id: "c" }, "SubagentStop");
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["left TODOs behind"] },
			event,
		);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			decision: "block",
			reason: "left TODOs behind",
		});
	});
});

describe("Codex encodeDecision — block on a non-PreToolUse event", () => {
	it("PostToolUse block uses the plain {decision, reason} shape (no hookSpecificOutput)", () => {
		const event = adapter.parseHookInput(
			{ session_id: "c", tool_name: "Bash", tool_input: { command: "ls" } },
			"PostToolUse",
		);
		const out = adapter.encodeDecision({ decision: "block", reason: "quality gate failed" }, event);
		expect(JSON.parse(out.stdout || "{}")).toEqual({
			decision: "block",
			reason: "quality gate failed",
		});
	});
});

describe("Codex encodeDecision — allow feedback on an event with no model_context capability", () => {
	it("SessionEnd routes feedback to stderr instead of additionalContext", () => {
		const event = adapter.parseHookInput({ session_id: "c" }, "SessionEnd");
		const out = adapter.encodeDecision({ decision: "allow", additional_context: "session done" }, event);
		expect(out).toEqual({ stderr: "session done", exit_code: 0 });
		expect(out.stdout).toBeUndefined();
	});
});

describe("codexRegistration — capability catalog guard", () => {
	it("throws naming the missing event when called for an event outside CODEX_CAPABILITIES", () => {
		expect(() => codexRegistration("/bin/hook", "NotARealCodexEvent")).toThrow(
			"Codex event NotARealCodexEvent is missing from the capability catalog",
		);
	});
});

describe("Codex parseHookInput — full native metadata", () => {
	it("normalizes tool, context, and subagent identifiers", () => {
		const event = adapter.parseHookInput(
			{
				session_id: "cx-meta",
				turn_id: "turn-meta",
				tool_use_id: "call-meta",
				tool_name: "Write",
				tool_input: { file_path: "a.ts" },
				model: "vendor-model-v6",
				transcript_path: "/tmp/transcript.jsonl",
				permission_mode: "default",
				agent_id: "agent-1",
				agent_type: "worker",
			},
			"PreToolUse",
		);
		expect(event).toMatchObject({
			turn_id: "turn-meta",
			tool_use_id: "call-meta",
			context: {
				model: "vendor-model-v6",
				transcript_path: "/tmp/transcript.jsonl",
				permission_mode: "default",
				agent: { id: "agent-1", role: "worker" },
			},
		});
	});
});
