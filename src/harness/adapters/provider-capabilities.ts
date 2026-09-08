import type { UnifiedPhase } from "../unified-event.js";
import type { HookControl } from "./hook-contract.js";
import { catalogControls } from "./catalog-controls.js";
import type {
	NativeDecisionControl,
	NativeHookEventCapability,
	RunnerCapabilities,
} from "./types.js";

interface EventOptions {
	controls?: readonly HookControl[];
	install?: boolean;
	control?: NativeDecisionControl;
	modelContext?: boolean;
	background?: boolean;
	missingRuntime?: NativeHookEventCapability["missing_runtime"];
}

function event(
	name: string,
	phase: UnifiedPhase,
	opts: EventOptions = {},
): NativeHookEventCapability {
	return {
		name,
		phase,
		install: opts.install ?? true,
		control: opts.control ?? "observe",
		model_context: opts.modelContext ?? false,
		...(opts.controls ? { controls: opts.controls } : {}),
		...(opts.background ? { background: true } : {}),
		missing_runtime: opts.missingRuntime ?? "warn_open",
	};
}

export function defineCapabilities(input: RunnerCapabilities): RunnerCapabilities {
	const seen = new Set<string>();
	for (const item of input.events) {
		if (seen.has(item.name)) {
			throw new Error(`duplicate native hook event capability: ${item.name}`);
		}
		seen.add(item.name);
	}
	return { ...input, events: input.events.map(item => {
		const controls = item.controls ?? catalogControls(input.project_hook_path, item.name);
		return controls ? { ...item, controls } : item;
	}) };
}

export function eventCapability(
	capabilities: RunnerCapabilities,
	nativeEventName: string,
): NativeHookEventCapability | null {
	return capabilities.events.find((item) => item.name === nativeEventName) ?? null;
}

export function installedEventNames(capabilities: RunnerCapabilities): readonly string[] {
	return capabilities.events.filter((item) => item.install).map((item) => item.name);
}

export const CLAUDE_CODE_CAPABILITIES = defineCapabilities({
	project_hook_path: ".claude/settings.json",
	hook_trust: "implicit",
	status_line: "custom-command",
	events: [
		event("SessionStart", "session-start", { modelContext: true }),
		event("SessionEnd", "session-end"),
		event("UserPromptSubmit", "user-prompt", { control: "deny", modelContext: true }),
		event("Stop", "stop", { control: "continue", modelContext: true }),
		event("PreToolUse", "pre-tool", {
			control: "ask",
			modelContext: true,
			missingRuntime: "fail_closed",
		}),
		event("PostToolUse", "post-tool", { control: "continue", modelContext: true }),
		event("PostToolUseFailure", "post-tool", {
			install: false,
			control: "continue",
			modelContext: true,
		}),
		event("PermissionRequest", "permission-request", {
			control: "permission",
			missingRuntime: "fail_closed",
		}),
		event("WorktreeCreate", "worktree-create", {
			control: "replace",
			missingRuntime: "fail_closed",
		}),
		event("SubagentStart", "subagent-start", { modelContext: true }),
		event("SubagentStop", "subagent-stop", { control: "continue", modelContext: true }),
		event("Notification", "notification"),
		event("PreCompact", "pre-compact", { control: "continue", modelContext: true }),
		event("TaskCompleted", "other"),
		event("TeammateIdle", "other"),
		event("Setup", "other", { controls: [], install: false }),
		event("UserPromptExpansion", "other", { controls: ["deny", "context"], install: false }),
		event("PermissionDenied", "other", { install: false }),
		event("PostToolBatch", "post-tool-batch", { controls: ["context", "cancel"] }),
		event("MessageDisplay", "other", { install: false }),
		event("TaskCreated", "other", { controls: ["deny"], install: false }),
		event("StopFailure", "error", { controls: [], install: false }),
		event("InstructionsLoaded", "other", { controls: [] }),
		event("ConfigChange", "config-change", { controls: ["deny"] }),
		event("CwdChanged", "cwd-change", { controls: [] }),
		event("DirectoryAdded", "other", { controls: [] }),
		event("FileChanged", "file-change", { controls: [] }),
		event("WorktreeRemove", "other", { controls: [] }),
		event("PostCompact", "post-compact", { controls: [] }),
		event("PreModelSwitch", "other", { controls: ["deny", "ask"], install: false }),
		event("PostModelSwitch", "other", { controls: ["context"], install: false }),
		event("Elicitation", "other", { install: false }),
		event("ElicitationResult", "other", { install: false }),
	],
});

export const CODEX_CAPABILITIES = defineCapabilities({
	project_hook_path: ".codex/hooks.json",
	hook_trust: "definition-review",
	status_line: "built-in-only",
	events: [
		event("SessionStart", "session-start", { modelContext: true }),
		event("SessionEnd", "session-end"),
		event("UserPromptSubmit", "user-prompt", { control: "deny", modelContext: true }),
		event("Stop", "stop", { control: "continue", modelContext: true }),
		event("PreToolUse", "pre-tool", {
			control: "deny",
			modelContext: true,
			missingRuntime: "fail_closed",
		}),
		event("PermissionRequest", "permission-request", {
			control: "permission",
			missingRuntime: "fail_closed",
		}),
		event("PostToolUse", "post-tool", { control: "continue", modelContext: true }),
		event("PreCompact", "pre-compact", { control: "continue" }),
		event("PostCompact", "post-compact", { control: "continue" }),
		event("SubagentStart", "subagent-start", { modelContext: true }),
		event("SubagentStop", "subagent-stop", { control: "continue", modelContext: true }),
		event("Interrupt", "other", { background: true }),
	],
});

export const COPILOT_CLI_CAPABILITIES = defineCapabilities({
	project_hook_path: ".github/hooks/hooks.json",
	hook_trust: "implicit",
	status_line: "custom-command",
	events: [
		event("sessionStart", "session-start"),
		event("sessionEnd", "session-end"),
		event("userPromptSubmitted", "user-prompt"),
		event("preToolUse", "pre-tool", {
			control: "deny",
			missingRuntime: "fail_closed",
		}),
		event("postToolUse", "post-tool"),
		event("errorOccurred", "error"),
		event("agentStop", "stop", { controls: ["continue"], control: "continue" }),
		event("notification", "notification", { controls: ["context", "wake"], modelContext: true }),
		event("permissionRequest", "permission-request", { controls: ["deny"], control: "permission", missingRuntime: "fail_closed" }),
		event("postToolUseFailure", "post-tool", { controls: [], install: false }),
		event("preCompact", "pre-compact", { controls: [] }),
		event("subagentStart", "subagent-start", { controls: ["context"], modelContext: true }),
		event("subagentStop", "subagent-stop", { controls: ["continue", "replace_result"], control: "continue" }),
		event("userPromptTransformed", "other", { controls: ["rewrite_input"], install: false }),
	],
});

export const GEMINI_CLI_CAPABILITIES = defineCapabilities({
	project_hook_path: ".gemini/settings.json",
	hook_trust: "definition-review",
	status_line: "none",
	events: [
		event("SessionStart", "session-start"),
		event("SessionEnd", "session-end"),
		event("BeforeAgent", "user-prompt"),
		event("AfterAgent", "stop", { controls: ["continue"], control: "continue" }),
		event("BeforeTool", "pre-tool", {
			control: "deny",
			missingRuntime: "fail_closed",
		}),
		event("AfterTool", "post-tool"),
		event("AfterModel", "post-model"),
		event("PreCompress", "pre-compact"),
		event("Notification", "notification"),
		event("BeforeModel", "pre-model", { controls: ["deny", "rewrite_input", "replace_result"], install: false }),
		event("BeforeToolSelection", "tool-selection", { controls: ["rewrite_input"], install: false }),
	],
});

export const CURSOR_CAPABILITIES = defineCapabilities({
	project_hook_path: ".cursor/hooks.json",
	hook_trust: "provider-managed",
	status_line: "none",
	events: [
		event("sessionStart", "session-start"),
		event("sessionEnd", "session-end"),
		event("stop", "stop", { control: "continue" }),
		event("preCompact", "pre-compact"),
		event("beforeSubmitPrompt", "user-prompt"),
		event("beforeShellExecution", "pre-tool", {
			control: "ask",
			missingRuntime: "fail_closed",
		}),
		event("afterShellExecution", "post-tool"),
		event("beforeMCPExecution", "pre-tool", {
			control: "ask",
			missingRuntime: "fail_closed",
		}),
		event("beforeMcpToolExecution", "pre-tool", {
			control: "ask",
			missingRuntime: "fail_closed",
		}),
		event("afterMCPExecution", "post-tool"),
		event("afterMcpToolExecution", "post-tool"),
		event("beforeReadFile", "pre-tool", {
			control: "deny",
			missingRuntime: "fail_closed",
		}),
		event("afterFileEdit", "post-tool"),
		event("preToolUse", "pre-tool", {
			control: "deny",
			missingRuntime: "fail_closed",
		}),
		event("postToolUse", "post-tool", { modelContext: true }),
		event("postToolUseFailure", "post-tool"),
		event("subagentStart", "pre-tool", {
			control: "deny",
			missingRuntime: "fail_closed",
		}),
		event("subagentStop", "subagent-stop", { control: "continue" }),
	],
});

export const OPENCODE_CAPABILITIES = defineCapabilities({
	project_hook_path: ".opencode/plugins/interlinked.ts",
	hook_trust: "implicit",
	status_line: "none",
	events: [
		event("chat.message", "user-prompt", { control: "deny" }),
		event("tool.execute.before", "pre-tool", {
			control: "deny",
			modelContext: true,
			missingRuntime: "fail_closed",
		}),
		event("tool.execute.after", "post-tool", {
			control: "continue",
			modelContext: true,
		}),
		event("permission.ask", "permission-request", {
			install: false,
			control: "permission",
			missingRuntime: "fail_closed",
		}),
		event("experimental.session.compacting", "pre-compact", {
			control: "continue",
			modelContext: true,
		}),
		event("event:session.created", "session-start"),
		event("event:session.deleted", "session-end"),
		event("event:session.idle", "stop"),
		event("event:session.error", "error"),
		event("event:session.compacted", "post-compact"),
		event("event:permission.updated", "permission-request"),
		event("event:permission.replied", "other"),
	],
});

export const PI_CAPABILITIES = defineCapabilities({
	project_hook_path: ".pi/extensions/interlinked.js",
	hook_trust: "definition-review",
	status_line: "none",
	events: [
		event("session_start", "session-start"),
		event("session_shutdown", "session-end"),
		event("input", "user-prompt", { control: "ask" }),
		event("tool_call", "pre-tool", {
			control: "ask",
			modelContext: true,
			missingRuntime: "fail_closed",
		}),
		event("tool_result", "post-tool", {
			control: "continue",
			modelContext: true,
		}),
		event("user_bash", "pre-tool", {
			control: "ask",
			missingRuntime: "fail_closed",
		}),
		event("before_agent_start", "other", { modelContext: true }),
		event("agent_start", "other"),
		event("agent_end", "other"),
		event("agent_settled", "stop"),
		event("session_before_compact", "pre-compact"),
		event("session_compact", "post-compact"),
		event("session_compact_failed", "error"),
	],
});
