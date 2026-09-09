import type { HookCapabilityReceipt, HookOutcome } from "./adapters/hook-contract.js";
import type { HookObservation } from "./adapters/hook-observation.js";
import type { UnifiedAction, UnifiedHookContext, UnifiedHookEvent } from "./unified-event.js";
import { wireAbsentOptional, wireArray, wireLiteral, wireNumber, wireObject, wireOptional, wireString, wireUnknown } from "../lib/value-validation.js";

const toolClass = wireLiteral("read", "modify", "side-effect", "long-running", "unknown");
const actionValidators = {
	tool_call: wireObject<Extract<UnifiedAction, { kind: "tool_call" }>>({
		kind: wireLiteral("tool_call"), tool_name: wireString, tool_class: toolClass,
		tool_input: wireUnknown, tool_input_redacted: wireUnknown,
		tool_response: wireAbsentOptional(wireUnknown), tool_error: wireAbsentOptional(wireOptional(wireString)),
	}),
	shell_command: wireObject<Extract<UnifiedAction, { kind: "shell_command" }>>({
		kind: wireLiteral("shell_command"), command: wireString,
		cwd: wireAbsentOptional(wireOptional(wireString)), tool_class: toolClass,
	}),
	file_operation: wireObject<Extract<UnifiedAction, { kind: "file_operation" }>>({
		kind: wireLiteral("file_operation"), operation: wireLiteral("read", "write", "edit", "delete"),
		path: wireString, old_string: wireAbsentOptional(wireString), new_string: wireAbsentOptional(wireString),
		content: wireAbsentOptional(wireString), tool_class: toolClass,
	}),
	user_prompt: wireObject<Extract<UnifiedAction, { kind: "user_prompt" }>>({ kind: wireLiteral("user_prompt"), text: wireString }),
	session_lifecycle: wireObject<Extract<UnifiedAction, { kind: "session_lifecycle" }>>({ kind: wireLiteral("session_lifecycle"), event: wireLiteral("start", "end", "stop") }),
	other: wireObject<Extract<UnifiedAction, { kind: "other" }>>({ kind: wireLiteral("other"), subkind: wireString, data: wireUnknown }),
};

function isAction(value: unknown): value is UnifiedAction {
	return Object.values(actionValidators).some((validate) => validate(value));
}

const context = wireObject<UnifiedHookContext>({
	cwd: wireString, workspace_root: wireAbsentOptional(wireOptional(wireString)), git_head: wireAbsentOptional(wireOptional(wireString)),
	branch: wireAbsentOptional(wireOptional(wireString)), model: wireAbsentOptional(wireOptional(wireString)), transcript_path: wireAbsentOptional(wireOptional(wireString)),
	permission_mode: wireAbsentOptional(wireOptional(wireString)),
	agent: wireAbsentOptional(wireOptional(wireObject({ id: wireAbsentOptional(wireOptional(wireString)), handle: wireAbsentOptional(wireOptional(wireString)), role: wireAbsentOptional(wireOptional(wireString)) }))),
});

const capability = wireObject<HookCapabilityReceipt>({
	schema_version: wireLiteral("1"), profile_digest: wireString, native_event: wireString,
	runtime: wireObject<HookCapabilityReceipt["runtime"]>({
		provider: wireString, host: wireLiteral("cli", "ide", "cloud", "sdk", "protocol", "unknown"),
		version: wireAbsentOptional(wireString), mode: wireLiteral("interactive", "headless", "unknown"),
	}),
	declaration: wireLiteral("known", "unknown"), subscription: wireLiteral("selected", "parse_only", "unknown"),
	controls: wireArray(wireLiteral("deny", "ask", "defer", "rewrite_input", "replace_result", "context", "continue", "cancel", "wake", "replace_operation")),
	controls_evidence: wireLiteral("explicit", "unmeasured"), emission: wireLiteral("observed", "unmeasured"), enforcement: wireLiteral("unmeasured"),
});

const outcome = wireObject<HookOutcome>({
	policy: wireLiteral("unmeasured", "allow", "deny", "ask", "defer", "substituted"),
	execution: wireLiteral("unknown", "not_started", "running", "succeeded", "failed", "cancelled"),
	tool_body_executed: wireLiteral(true, false, "unknown"),
});

const observationValidators = [
	wireObject<Extract<HookObservation, { kind: "filesystem" }>>({ kind: wireLiteral("filesystem"), path: wireString, operation: wireLiteral("add", "change", "unlink", "unknown"), writer: wireLiteral("unknown"), timing: wireLiteral("after") }),
	wireObject<Extract<HookObservation, { kind: "tool_batch" }>>({ kind: wireLiteral("tool_batch"), boundary: wireLiteral("before_model"), calls: wireArray(wireObject<{ tool_use_id?: string; tool_name?: string }>({ tool_use_id: wireAbsentOptional(wireString), tool_name: wireAbsentOptional(wireString) })) }),
	wireObject<Extract<HookObservation, { kind: "configuration" }>>({ kind: wireLiteral("configuration"), path: wireAbsentOptional(wireString), source: wireAbsentOptional(wireString), timing: wireLiteral("before_runtime_apply") }),
	wireObject<Extract<HookObservation, { kind: "model" }>>({ kind: wireLiteral("model"), boundary: wireLiteral("before_request", "after_response", "tool_selection") }),
];

function isObservation(value: unknown): value is HookObservation {
	return observationValidators.some((validate) => validate(value));
}

/** Keep wire values unknown until all fields the evaluator may consume are checked. */
export const isRpcHookEvent = wireObject<UnifiedHookEvent>({
	schema_version: wireLiteral("1"), event_id: wireString, session_id: wireString, ts: wireString,
	parent_event_id: wireAbsentOptional(wireOptional(wireString)), turn_id: wireAbsentOptional(wireOptional(wireString)), tool_use_id: wireAbsentOptional(wireOptional(wireString)),
	post_delivery_token: wireAbsentOptional(wireOptional(wireString)), post_delivery_pid: wireAbsentOptional(wireOptional(wireNumber)),
	runner: wireLiteral("cowork", "claude-code", "copilot-cli", "codex", "gemini-cli", "cursor", "opencode", "pi", "factory-droid", "windsurf", "antigravity", "crush", "unknown"),
	runner_version: wireAbsentOptional(wireOptional(wireString)), runner_native_event: wireString,
	capability: wireAbsentOptional(capability), outcome: wireAbsentOptional(outcome), observation: wireAbsentOptional(isObservation),
	phase: wireLiteral("pre-tool", "post-tool", "post-tool-batch", "file-change", "config-change", "cwd-change", "pre-model", "post-model", "tool-selection", "session-start", "session-end", "user-prompt", "permission-request", "worktree-create", "pre-compact", "post-compact", "stop", "subagent-start", "subagent-stop", "notification", "error", "other"),
	action: isAction, context, raw: wireUnknown,
});
