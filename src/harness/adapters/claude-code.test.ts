import { describe, expect, it } from "vitest";
import { isReadOnlyToolName } from "../../lib/hook-read-only-tools.js";
import { nonNull } from "../../lib/non-null.js";
import { CLAUDE_HOOK_EVENTS } from "../../lib/hook-installers-claude.js";
import { CLAUDE_CODE_WRITE_TOOLS, writeToolEntry } from "../../lib/write-tool-registry.js";
import { resolveEditedPaths } from "../server/post-tool-pipeline-paths.js";
import type { HarnessEvent } from "../types.js";
import { CLAUDE_POST_TOOL_USE_MATCHER, createClaudeCodeAdapter } from "./claude-code.js";

const adapter = createClaudeCodeAdapter();

describe("Claude Code adapter identity", () => {
	it("has the expected id and label", () => {
		expect(adapter.id).toBe("claude-code");
		expect(adapter.label).toBe("Claude Code");
	});
	it("covers all known native events", () => {
		expect(adapter.nativeEventNames).toContain("PreToolUse");
		expect(adapter.nativeEventNames).toContain("PostToolUse");
		expect(adapter.nativeEventNames).toContain("SessionStart");
	});
});

describe("Claude Code detectFromEnv", () => {
	it("detects CLAUDE_CODE env", () => {
		expect(adapter.detectFromEnv({ CLAUDE_CODE: "1" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Claude Code parseHookInput — PreToolUse Edit", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "s-1",
			cwd: "/repo",
			hook_event_name: "PreToolUse",
			tool_name: "Edit",
			tool_input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
		},
		"PreToolUse",
	);

	it("has schema_version 1", () => {
		expect(event.schema_version).toBe("1");
	});
	it("has phase pre-tool", () => {
		expect(event.phase).toBe("pre-tool");
	});
	it("classifies Edit as modify", () => {
		expect(event.action.kind).toBe("tool_call");
		if (event.action.kind === "tool_call") {
			expect(event.action.tool_class).toBe("modify");
			expect(event.action.tool_name).toBe("edit");
		}
	});
	it("preserves session id and cwd", () => {
		expect(event.session_id).toBe("s-1");
		expect(event.context.cwd).toBe("/repo");
	});
});

describe("Claude Code parseHookInput — PreToolUse Bash", () => {
	const event = adapter.parseHookInput(
		{
			session_id: "s-2",
			cwd: "/repo",
			tool_name: "Bash",
			tool_input: { command: "rm -rf /tmp/out" },
		},
		"PreToolUse",
	);
	it("routes Bash through command classifier", () => {
		if (event.action.kind === "tool_call") {
			expect(event.action.tool_class).toBe("side-effect");
		} else {
			throw new Error("expected tool_call action");
		}
	});
});

describe("Claude Code parseHookInput — SessionStart", () => {
	const event = adapter.parseHookInput({ session_id: "s-3", cwd: "/repo" }, "SessionStart");
	it("produces a session_lifecycle action", () => {
		expect(event.action.kind).toBe("session_lifecycle");
	});
	it("sets phase to session-start", () => {
		expect(event.phase).toBe("session-start");
	});
});

describe("Claude Code classifyToolClass", () => {
	it("Edit → modify", () => {
		expect(adapter.classifyToolClass("Edit", {})).toBe("modify");
	});
	it("Bash routes to command classifier", () => {
		expect(adapter.classifyToolClass("Bash", { command: "git status" })).toBe("read");
	});
});

describe("Claude Code renderSettingsFragment", () => {
	const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
	it("writes to the project settings path", () => {
		expect(frag.path).toBe(".claude/settings.json");
	});
	it("uses array-append for hook merge", () => {
		expect(frag.mergeStrategy).toBe("array-append");
	});
	// Pin the SHIPPED fragment, not the event list. The omission was pinned on
	// the legacy installer's `CLAUDE_HOOK_EVENTS`, which no longer performs the
	// install — so the adapter re-registered the event and every live settings
	// file got "2 PostToolUse hooks ran" while the test stayed green.
	it("N: does NOT register PostToolUseFailure (Claude counts it as a second PostToolUse)", () => {
		const fragment = frag.fragment as { hooks: Record<string, unknown> };
		expect(Object.keys(fragment.hooks)).not.toContain("PostToolUseFailure");
	});

	it("registers PermissionRequest now that its native response contract is implemented", () => {
		const fragment = frag.fragment as { hooks: Record<string, unknown> };
		expect(Object.keys(fragment.hooks)).toContain("PermissionRequest");
		expect(adapter.nativeEventNames).toContain("PermissionRequest");
	});

	it("registers WorktreeCreate as a native hard-stop", () => {
		const fragment = frag.fragment as { hooks: Record<string, unknown> };
		expect(Object.keys(fragment.hooks)).toContain("WorktreeCreate");
		expect(adapter.nativeEventNames).toContain("WorktreeCreate");
		expect(CLAUDE_HOOK_EVENTS).toContain("WorktreeCreate");
	});

	it("the legacy install/reporting list agrees on PermissionRequest", () => {
		// The legacy list feeds successful-install reporting; drift here made
		// preview and success text disagree and would re-register on the legacy
		// install path.
		expect(CLAUDE_HOOK_EVENTS).toContain("PermissionRequest");
	});

	// Review 2026-08-28 (final round, P1): absence checks alone let the lists
	// drift on ANY OTHER event (deleting TaskCompleted from one list passed
	// every prior assertion). Full equality, order included — until the
	// duplicate list is deleted and reporting derives from the adapter.
	it("retains every legacy event and adds the documented observation boundaries", () => {
		expect(adapter.nativeEventNames.filter(name => !CLAUDE_HOOK_EVENTS.some(legacy => legacy === name))).toEqual([
			"PostToolBatch", "InstructionsLoaded", "ConfigChange", "CwdChanged", "DirectoryAdded", "FileChanged", "WorktreeRemove", "PostCompact",
		]);
		for (const name of CLAUDE_HOOK_EVENTS) expect(adapter.nativeEventNames).toContain(name);
	});

	it("parses a registered PermissionRequest into the normalized permission phase", () => {
		const parsed = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: { command: "ls" } },
			"PermissionRequest",
		);
		expect(parsed).not.toBeNull();
		expect(parsed.phase).toBe("permission-request");
	});

	it("parses WorktreeCreate into the provider-neutral worktree phase", () => {
		const parsed = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", name: "feature" },
			"WorktreeCreate",
		);
		expect(parsed.phase).toBe("worktree-create");
		expect(parsed.action).toMatchObject({ kind: "other", subkind: "WorktreeCreate" });
	});

	it("P: still PARSES a PostToolUseFailure payload it did not register", () => {
		// Handling and registering are separate decisions: another runner (or a
		// future Claude version) can still deliver the event.
		const parsed = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: { command: "ls" } },
			"PostToolUseFailure",
		);
		expect(parsed).not.toBeNull();
	});

	// PostToolUse is SCOPED to the mutating tools. Registering for every tool
	// fired the post-tool pipeline on reads and searches, and the daemon builds
	// the edited-file list from a post-call filesystem diff — so a read-only call
	// in a busy tree picked up somebody ELSE's writes and ran the whole per-file
	// pass (including `affected_tests`, which shells out to vitest) over them.
	// Codex is the deliberate exception and keeps matcher "" for `apply_patch`.
	it("scopes PostToolUse to the mutating tools (NOT the all-tools matcher)", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
		};
		const post = nonNull(nonNull(fragment.hooks.PostToolUse)[0]);
		expect(post.matcher).toBe("Write|Edit|MultiEdit|NotebookEdit|Bash");
		expect(post.matcher).toBe(CLAUDE_POST_TOOL_USE_MATCHER);
		expect(nonNull(post.hooks[0]).command).toContain("--runner 'claude-code'");
		expect(nonNull(post.hooks[0]).command).toContain("--event 'PostToolUse'");
		expect(nonNull(post.hooks[0]).command).toContain("if test -f");
		expect(nonNull(post.hooks[0]).command).not.toContain("|| true");
	});

	it("registers SessionEnd as a detached fire-and-forget command", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		const sessionEnd = nonNull(nonNull(fragment.hooks.SessionEnd)[0]);
		const command = nonNull(sessionEnd.hooks[0]).command;
		// Backgrounded subshell + discarded output: `claude update` fires
		// SessionEnd and exits immediately, cancelling any foreground hook that
		// is still booting ("Hook cancelled"). Detached, the shell returns in
		// milliseconds and there is nothing left to cancel.
		expect(command).toContain("( node");
		expect(command).toContain(">/dev/null 2>&1 & )");
		expect(command).toContain("--event 'SessionEnd'");
	});

	it("keeps every other event foreground (their output is consumed)", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};
		for (const [eventName, entries] of Object.entries(fragment.hooks)) {
			if (eventName === "SessionEnd") continue;
			expect(nonNull(nonNull(entries[0]).hooks[0]).command).not.toContain("& )");
		}
	});

	it("uses empty matcher for PreToolUse as well", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ matcher: string }>>;
		};
		expect(nonNull(nonNull(fragment.hooks.PreToolUse)[0]).matcher).toBe("");
	});

	it("omits FileChanged's static matcher and scopes only PostToolUse", () => {
		const fragment = frag.fragment as {
			hooks: Record<string, Array<{ matcher: string }>>;
		};
		for (const eventName of Object.keys(fragment.hooks)) {
			if (eventName === "PostToolUse") continue;
			if (eventName === "FileChanged") {
				expect(nonNull(nonNull(fragment.hooks[eventName])[0])).not.toHaveProperty("matcher");
				continue;
			}
			expect(nonNull(nonNull(fragment.hooks[eventName])[0]).matcher).toBe("");
		}
	});

	it("N: the PostToolUse matcher names no read-only tool", () => {
		// The whole point of scoping it. A read/search must never reach the
		// per-file pipeline, whose path list comes from a post-call filesystem
		// diff it did not cause.
		for (const readOnly of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite"]) {
			expect(CLAUDE_POST_TOOL_USE_MATCHER.split("|")).not.toContain(readOnly);
		}
	});

	it("P: the PostToolUse matcher keeps Bash (the bash-edit obligation channel)", () => {
		expect(CLAUDE_POST_TOOL_USE_MATCHER.split("|")).toContain("Bash");
	});
});

// ===========================================
// Matcher ↔ pipeline drift
// ===========================================
// Two hand-maintained lists answered "which tools can change a file": the
// matcher above, and `DIRECT_FILE_EDIT_TOOLS` in the quality pipeline. They
// drifted — `MultiEdit` was in the matcher and not in the pipeline, so a
// MultiEdit was registered, delivered to the daemon, and then treated as
// editing nothing (no ChangeSet ⇒ zero paths and `shouldRunChecks: false`; a
// ChangeSet ⇒ `isDirectFileEdit: false`, which hands a pre-write-GATED edit to
// the bash-channel obligation gate).
//
// Both now derive from `lib/write-tool-registry.ts`. These tests assert the
// end-to-end consequence — what the pipeline actually DOES with each tool the
// matcher admits — so they still fail if someone reintroduces a local list.

const MATCHER_TOOLS = CLAUDE_POST_TOOL_USE_MATCHER.split("|");

function toolEvent(tool_name: string, tool_input: Record<string, unknown>): HarnessEvent {
	// SAFETY: resolveEditedPaths reads only tool_name + tool_input.
	return { tool_name, tool_input } as unknown as HarnessEvent;
}

describe("PostToolUse matcher and the pipeline's direct-edit list cannot drift", () => {
	it("P1: every tool the matcher admits is a registered write tool", () => {
		for (const name of MATCHER_TOOLS) {
			expect({ name, entry: Boolean(writeToolEntry(name)) }).toEqual({ name, entry: true });
		}
	});

	it("P2: the matcher is exactly the registry's Claude-native write tools", () => {
		expect(MATCHER_TOOLS).toEqual([...CLAUDE_CODE_WRITE_TOOLS]);
	});

	it("P3: every DIRECT-channel matcher tool is a direct edit in the pipeline", () => {
		const direct = MATCHER_TOOLS.filter((n) => writeToolEntry(n)?.channel === "direct");
		expect(direct.length).toBeGreaterThan(0);
		for (const name of direct) {
			const r = resolveEditedPaths(toolEvent(name, { file_path: "src/foo.ts" }));
			expect({
				name,
				isDirectFileEdit: r.isDirectFileEdit,
				paths: r.editedFilePaths,
				shouldRunChecks: r.shouldRunChecks,
			}).toEqual({
				name,
				isDirectFileEdit: true,
				paths: ["src/foo.ts"],
				shouldRunChecks: true,
			});
		}
	});

	it("P4: every SHELL-channel matcher tool resolves through the command scan", () => {
		const shell = MATCHER_TOOLS.filter((n) => writeToolEntry(n)?.channel === "shell");
		expect(shell).toEqual(["Bash"]);
		for (const name of shell) {
			const r = resolveEditedPaths(
				toolEvent(name, { command: "sed -i '' 's/a/b/' src/foo.ts" }),
			);
			expect({ name, isDirectFileEdit: r.isDirectFileEdit, paths: r.editedFilePaths }).toEqual({
				name,
				isDirectFileEdit: false,
				paths: ["src/foo.ts"],
			});
		}
	});

	it("N1: the matcher admits no read-only tool", () => {
		for (const name of MATCHER_TOOLS) {
			expect({ name, readOnly: isReadOnlyToolName(name) }).toEqual({ name, readOnly: false });
		}
	});

	it("N2: a tool outside the matcher is not promoted to a direct edit", () => {
		for (const name of ["Read", "Grep", "WebFetch", "TodoWrite"]) {
			const r = resolveEditedPaths(toolEvent(name, { file_path: "src/foo.ts" }));
			expect({ name, isDirectFileEdit: r.isDirectFileEdit }).toEqual({
				name,
				isDirectFileEdit: false,
			});
		}
	});
});

describe("Claude Code encodeDecision", () => {
	const baseEvent = adapter.parseHookInput(
		{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
		"PreToolUse",
	);
	it("allow — exit 0 with no stdout by default", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, baseEvent);
		expect(out.exit_code).toBe(0);
		expect(out.stdout).toBeUndefined();
	});
	it("allow with additional_context — emits hookSpecificOutput with hookEventName", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi" },
			baseEvent,
		);
		expect(out.stdout).toBeDefined();
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "fyi" },
		});
	});
	it("PreToolUse block — emits permissionDecision: deny in hookSpecificOutput (NOT root decision:deny)", () => {
		// Root {decision:"deny"} is invalid for PreToolUse ("(root): Invalid
		// input") and silently fails to block — deny must live in
		// hookSpecificOutput.permissionDecision.
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, baseEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no",
			},
		});
	});
	it("PostToolUse block — emits root decision: block (valid for PostToolUse)", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
			"PostToolUse",
		);
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, postEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({ decision: "block", reason: "no" });
	});
	it("PreToolUse ask — emits permissionDecision: ask in hookSpecificOutput", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, baseEvent);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "ask",
				permissionDecisionReason: "confirm?",
			},
		});
	});
	it("P: PermissionRequest block emits Claude's exact permission-specific deny envelope", () => {
		const permissionEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: {} },
			"PermissionRequest",
		);
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "policy denied" },
			permissionEvent,
		);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: "policy denied" },
			},
		});
	});
	it("N: PermissionRequest block never reuses the PreToolUse permissionDecision fields", () => {
		const permissionEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: {} },
			"PermissionRequest",
		);
		const out = adapter.encodeDecision(
			{ decision: "block", reason: "policy denied" },
			permissionEvent,
		);
		const parsed = JSON.parse(out.stdout as string) as {
			hookSpecificOutput: Record<string, unknown>;
		};
		expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
		expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecisionReason");
	});
	it("N: PermissionRequest ask abstains so Claude keeps the native prompt", () => {
		const permissionEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: {} },
			"PermissionRequest",
		);
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "please confirm" },
			permissionEvent,
		);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toBe("please confirm");
		expect(out.exit_code).toBe(0);
	});
	it("N: PermissionRequest allow diagnostics use stderr, never additionalContext stdout", () => {
		const permissionEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: {} },
			"PermissionRequest",
		);
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "policy note", warnings: ["warning note"] },
			permissionEvent,
		);
		expect(out).toEqual({ stderr: "policy note\nwarning note", exit_code: 0 });
	});
	it("P: PermissionRequest system_message overrides the formatted ask-reason text", () => {
		const permissionEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Bash", tool_input: {} },
			"PermissionRequest",
		);
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm this deletion", system_message: "custom operator note" },
			permissionEvent,
		);
		// If system_message were ignored, "ask" would fall into the
		// formatAskReasonWithTargets branch and produce text built from
		// `reason`, not this literal.
		expect(out.stderr).toBe("custom operator note");
	});
	it("WorktreeCreate always fails without returning a replacement path", () => {
		const worktreeEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", name: "feature" },
			"WorktreeCreate",
		);
		const out = adapter.encodeDecision({ decision: "allow" }, worktreeEvent);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toContain("Agent-created Git worktrees are disabled");
		expect(out.exit_code).toBe(2);
	});
	it("routes warnings to stderr", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1", "w2"] },
			baseEvent,
		);
		expect(out.stderr).toBe("w1\nw2");
	});

	// PreToolUse stderr is dropped from the model's view by Claude Code's
	// runtime (only PostToolUse stderr surfaces as additional context). Without
	// this fan-out, every PreToolUse advisory the harness emits — including
	// supermodel-graph blast-radius warnings — is invisible to the agent.
	it("PreToolUse: also routes warnings into hookSpecificOutput.additionalContext", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1", "w2"] },
			baseEvent,
		);
		expect(out.stdout).toBeDefined();
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "w1\nw2" },
		});
		expect(out.stderr).toBe("w1\nw2");
	});

	it("PreToolUse: combines explicit additional_context with warnings", () => {
		const out = adapter.encodeDecision(
			{ decision: "allow", additional_context: "fyi", warnings: ["w1"] },
			baseEvent,
		);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "fyi\nw1" },
		});
	});

	// This previously asserted stderr-only, on the belief that the runtime echoes
	// PostToolUse stderr to the model. It does not: Claude Code feeds hook stderr
	// to the model on exit code 2 (a block), NOT on exit 0. Measured directly —
	// a PostToolUse warning the daemon composed and logged to activity.jsonl never
	// reached the agent, which is why advisory findings only ever appeared
	// alongside some OTHER blocking error. Every non-blocking PostToolUse finding
	// the harness produced was invisible.
	it("PostToolUse: routes warnings into additionalContext so the agent sees them", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		const out = adapter.encodeDecision(
			{ decision: "allow", warnings: ["w1"] },
			postEvent,
		);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "w1" },
		});
		expect(out.stderr).toBe("w1");
	});

	it("PostToolUse with no warnings: still no stdout", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Edit", tool_input: {} },
			"PostToolUse",
		);
		expect(adapter.encodeDecision({ decision: "allow" }, postEvent).stdout).toBeUndefined();
	});

	it("PreToolUse with no warnings + no additional_context: no stdout", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, baseEvent);
		expect(out.stdout).toBeUndefined();
	});

	it("block with no reason falls back to the generic harness-bug message", () => {
		const out = adapter.encodeDecision({ decision: "block" }, baseEvent);
		const parsed = JSON.parse(out.stdout as string) as {
			hookSpecificOutput: { permissionDecisionReason: string };
		};
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe(
			"Blocked by the interlinked harness, but no reason was attached — likely a harness " +
				"bug; re-run, or run `interlinked harness restart`, then report it.",
		);
	});

	it("ask reason includes resolved_targets via formatAskReasonWithTargets", () => {
		const out = adapter.encodeDecision(
			{
				decision: "ask",
				reason: "Confirm push?",
				resolved_targets: [{ kind: "branch", value: "origin/main" }],
			},
			baseEvent,
		);
		const parsed = JSON.parse(out.stdout as string) as {
			hookSpecificOutput: { permissionDecisionReason: string };
		};
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("Confirm push?");
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("origin/main");
	});

	it("falls back to hookEventName by phase when no event is supplied (PostToolUse default)", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, undefined as never);
		expect(JSON.parse(out.stdout as string)).toEqual({ decision: "block", reason: "no" });
	});

	it("falls back to hookEventName 'PreToolUse' when event.phase is pre-tool but native event name is absent", () => {
		const fakeEvent = { ...baseEvent, runner_native_event: undefined };
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, fakeEvent as never);
		expect(JSON.parse(out.stdout as string)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no",
			},
		});
	});
});

describe("Claude Code detectFromEnv — remaining env var branches", () => {
	it("detects CLAUDE_WORKING_DIR", () => {
		expect(adapter.detectFromEnv({ CLAUDE_WORKING_DIR: "/repo" })).toBe(true);
	});
	it("detects CLAUDECODE", () => {
		expect(adapter.detectFromEnv({ CLAUDECODE: "1" })).toBe(true);
	});
	it("detects CLAUDE_CODE_VERSION", () => {
		expect(adapter.detectFromEnv({ CLAUDE_CODE_VERSION: "1.0.0" })).toBe(true);
	});
});

describe("Claude Code parseHookInput — agent_name context", () => {
	it("sets context.agent when agent_name is present", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", agent_name: "reviewer" },
			"SessionStart",
		);
		expect(event.context.agent).toEqual({ id: "reviewer" });
	});
	it("leaves context.agent undefined when agent_name is absent", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SessionStart");
		expect(event.context.agent).toBeUndefined();
	});
});

describe("Claude Code classifyToolClass with overrides", () => {
	it("uses a supplied tool_name_classes override", () => {
		const overriddenAdapter = createClaudeCodeAdapter({
			overrides: {
				tool_name_classes: { CustomTool: "side-effect" },
				command_substrings: [],
			},
		});
		expect(overriddenAdapter.classifyToolClass("CustomTool", {})).toBe("side-effect");
	});
});

describe("Claude Code parseHookInput — UserPromptSubmit action", () => {
	it("uses raw.prompt as the text when present", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", prompt: "hello there" },
			"UserPromptSubmit",
		);
		expect(event.action).toEqual({ kind: "user_prompt", text: "hello there" });
	});
	it("falls back to raw.message when prompt is absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", message: "fallback text" },
			"UserPromptSubmit",
		);
		expect(event.action).toEqual({ kind: "user_prompt", text: "fallback text" });
	});
	it("falls back to an empty string when neither prompt nor message is present", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "UserPromptSubmit");
		expect(event.action).toEqual({ kind: "user_prompt", text: "" });
	});
});

describe("Claude Code parseHookInput — SessionEnd and PostToolUseFailure", () => {
	it("produces a session_lifecycle 'end' action for SessionEnd", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "SessionEnd");
		expect(event.action).toEqual({ kind: "session_lifecycle", event: "end" });
	});
	it("routes PostToolUseFailure through buildToolCallAction as a post action", () => {
		const event = adapter.parseHookInput(
			{
				session_id: "s",
				cwd: "/repo",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				tool_error: "boom",
			},
			"PostToolUseFailure",
		);
		expect(event.action.kind).toBe("tool_call");
		if (event.action.kind === "tool_call") {
			expect(event.action.tool_error).toBe("boom");
		}
	});
});

describe("Claude Code parseHookInput — non-object native payload falls back to {}", () => {
	it("treats a null payload as an empty object", () => {
		const event = adapter.parseHookInput(null, "SessionStart");
		expect(event.session_id).toBe("unknown");
		expect(event.context.cwd).toBe(process.cwd());
	});
	it("treats an array payload as an empty object (not a plain object)", () => {
		const event = adapter.parseHookInput(["not", "an", "object"], "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
});

describe("Claude Code parseHookInput — unmapped native event uses phase 'other'", () => {
	it("falls back to phase 'other' for an event not in PHASE_MAP", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "TeammateIdle");
		expect(event.phase).toBe("other");
	});
});

describe("Claude Code parseHookInput — session_id and cwd fallbacks", () => {
	it("defaults session_id to 'unknown' when absent", () => {
		const event = adapter.parseHookInput({ cwd: "/repo" }, "SessionStart");
		expect(event.session_id).toBe("unknown");
	});
	it("defaults cwd to process.cwd() when absent", () => {
		const event = adapter.parseHookInput({ session_id: "s" }, "SessionStart");
		expect(event.context.cwd).toBe(process.cwd());
	});
});

describe("Claude Code renderSettingsFragment — user scope", () => {
	it("writes to the user settings path", () => {
		const frag = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "user");
		expect(frag.path).toBe("~/.claude/settings.json");
	});
});

describe("Claude Code encodeDecision — ask with no reason falls back to 'Confirmation required'", () => {
	it("uses the default confirmation reason when decision.reason is absent", () => {
		const preEvent = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Read", tool_input: {} },
			"PreToolUse",
		);
		const out = adapter.encodeDecision({ decision: "ask" }, preEvent);
		const parsed = JSON.parse(out.stdout as string) as {
			hookSpecificOutput: { permissionDecisionReason: string };
		};
		expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("Confirmation required");
	});
});

describe("Claude Code parseHookInput — buildToolCallAction fallbacks", () => {
	it("defaults tool_name to 'unknown' when absent", () => {
		const event = adapter.parseHookInput({ session_id: "s", cwd: "/repo" }, "PreToolUse");
		expect(event.action).toMatchObject({ kind: "tool_call", tool_name: "unknown" });
	});
	it("defaults tool_input to {} when absent", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "Read" },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_input: {} });
	});
	it("applies classifier overrides through parseHookInput (PreToolUse)", () => {
		const overriddenAdapter = createClaudeCodeAdapter({
			overrides: {
				tool_name_classes: { CustomTool: "side-effect" },
				command_substrings: [],
			},
		});
		const event = overriddenAdapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", tool_name: "CustomTool", tool_input: {} },
			"PreToolUse",
		);
		expect(event.action).toMatchObject({ kind: "tool_call", tool_class: "side-effect" });
	});
});

describe("Claude Code parseHookInput — unrecognized native event falls through to 'other'", () => {
	it("produces an 'other' action carrying the raw payload", () => {
		const event = adapter.parseHookInput(
			{ session_id: "s", cwd: "/repo", foo: "bar" },
			"Notification",
		);
		expect(event.action).toEqual({
			kind: "other",
			subkind: "Notification",
			data: { session_id: "s", cwd: "/repo", foo: "bar" },
		});
	});
});
