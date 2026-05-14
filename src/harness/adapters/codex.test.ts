import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "./codex.js";

const adapter = createCodexAdapter();

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
		expect(adapter.nativeEventNames).toContain("PreToolUse");
		expect(adapter.nativeEventNames).toContain("PostToolUse");
		expect(adapter.nativeEventNames).toContain("PermissionRequest");
		expect(adapter.nativeEventNames).toContain("Stop");
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
		expect(event.action).toMatchObject({ kind: "tool_call", tool_name: "Bash" });
	});
	it("propagates Codex turn_id as parent_event_id", () => {
		expect(event.parent_event_id).toBe("turn-7");
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
			tool_name: "Bash",
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
	it("produces a session_lifecycle action with event=end", () => {
		expect(event.action).toMatchObject({ kind: "session_lifecycle", event: "end" });
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
	it("block emits legacy {decision:'block'} JSON on stdout", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, event);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeDefined();
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({ decision: "block", reason: "no" });
	});
	it("ask collapses to block on PreToolUse (no ask primitive)", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({ decision: "block", reason: "confirm?" });
	});
});

describe("Codex encodeDecision — UserPromptSubmit additionalContext", () => {
	// Plan §3 / §7: Codex copies Claude's hookSpecificOutput.additionalContext
	// contract. Before the fix, `additional_context` went to stderr, where the
	// model never sees it. The metacoder's system_prompt_addendum needs to
	// reach the model on UserPromptSubmit.
	const event = adapter.parseHookInput(
		{ session_id: "c", prompt: "Refactor payments." },
		"UserPromptSubmit",
	);

	it("emits additionalContext on stdout when decision carries additional_context", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "Stay focused on the refactor." },
			event,
		);
		expect(out.stdout).toBeDefined();
		const parsed = JSON.parse(out.stdout ?? "{}");
		expect(parsed).toEqual({
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: "Stay focused on the refactor.",
			},
		});
	});

	it("does NOT smuggle additional_context onto stderr", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "Stay focused on the refactor." },
			event,
		);
		expect(out.stderr ?? "").not.toContain("Stay focused on the refactor.");
	});

	it("plain allow with no additional_context exits 0 silently", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toBeUndefined();
	});
});

describe("Codex encodeDecision — PermissionRequest path", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", tool_name: "Bash", tool_input: { command: "ls /etc" } },
		"PermissionRequest",
	);
	it("allow uses hookSpecificOutput.decision.behavior=allow", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		const parsed = JSON.parse(out.stdout || "{}");
		expect(parsed).toEqual({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "allow" },
			},
		});
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
		const root = fragment.fragment as { hooks: Record<string, unknown[]> };
		const entries = root.hooks.PreToolUse as Array<{
			matcher: string;
			hooks: Array<{ type: string; command: string }>;
		}>;
		expect(entries[0].hooks[0].type).toBe("command");
		expect(entries[0].hooks[0].command).toContain("/bin/hook");
	});
	it("scopes PostToolUse matcher to mutating tools only", () => {
		const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
		const root = fragment.fragment as { hooks: Record<string, unknown[]> };
		const entries = root.hooks.PostToolUse as Array<{ matcher: string }>;
		expect(entries[0].matcher).toMatch(/Edit\|Write\|MultiEdit/);
	});
});
