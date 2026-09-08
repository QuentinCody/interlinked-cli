import type { UnifiedPhase } from "../unified-event.js";
import type { HookControl } from "./hook-contract.js";
import { defineCapabilities } from "./provider-capabilities.js";
import type { NativeHookEventCapability, RunnerCapabilities } from "./types.js";

export type AdditionalClientId = "factory-droid" | "windsurf" | "antigravity" | "crush";
function boundary(name: string, phase: UnifiedPhase, controls: HookControl[], install = true): NativeHookEventCapability {
    return { name, phase, controls, install, control: controls.includes("deny") ? "deny" : "observe", model_context: controls.includes("context"), missing_runtime: phase === "pre-tool" ? "fail_closed" : "warn_open" };
}
export const ADDITIONAL_CLIENT_CAPABILITIES: Record<AdditionalClientId, RunnerCapabilities> = {
    "factory-droid": defineCapabilities({ project_hook_path: ".factory/hooks.json", hook_trust: "definition-review", status_line: "none", events: [
        boundary("PreToolUse", "pre-tool", ["deny", "ask", "rewrite_input"]), boundary("PostToolUse", "post-tool", ["context", "continue"]),
        boundary("UserPromptSubmit", "user-prompt", ["deny", "context"]), boundary("Notification", "notification", []), boundary("Stop", "stop", ["continue"]),
        boundary("SubagentStop", "subagent-stop", ["continue"]), boundary("PreCompact", "pre-compact", []), boundary("SessionStart", "session-start", ["context"]), boundary("SessionEnd", "session-end", []),
    ] }),
    windsurf: defineCapabilities({ project_hook_path: ".windsurf/hooks.json", hook_trust: "provider-managed", status_line: "none", events: [
        boundary("pre_read_code", "pre-tool", ["deny"]), boundary("post_read_code", "post-tool", [], false), boundary("pre_write_code", "pre-tool", ["deny"]), boundary("post_write_code", "post-tool", []),
        boundary("pre_run_command", "pre-tool", ["deny"]), boundary("post_run_command", "post-tool", []), boundary("pre_mcp_tool_use", "pre-tool", ["deny"]), boundary("post_mcp_tool_use", "post-tool", []),
        boundary("pre_user_prompt", "user-prompt", ["deny"]), boundary("post_cascade_response", "stop", []), boundary("post_cascade_response_with_transcript", "stop", [], false), boundary("post_setup_worktree", "other", []),
    ] }),
    antigravity: defineCapabilities({ project_hook_path: ".agents/hooks.json", hook_trust: "provider-managed", status_line: "none", events: [
        boundary("PreToolUse", "pre-tool", ["deny", "ask"]), boundary("PostToolUse", "post-tool", []), boundary("PreInvocation", "pre-model", ["context"]), boundary("PostInvocation", "post-model", ["context", "continue", "cancel"]), boundary("Stop", "stop", ["continue"]),
    ] }),
    crush: defineCapabilities({ project_hook_path: "crush.json", hook_trust: "implicit", status_line: "none", events: [boundary("PreToolUse", "pre-tool", ["deny", "rewrite_input", "context"])] }),
};
