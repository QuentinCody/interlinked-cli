import type { HarnessEvent } from "../harness/types.js";
import type { WorkspaceChangeSet, WorkspaceFileEffect } from "../harness/workspace-effects.js";
import { isJsonObject } from "../lib/json-types.js";
import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireOptional, wireString, wireUnknown } from "../lib/value-validation.js";

const isFileEffect = wireObject<WorkspaceFileEffect>({
	path: wireString, kind: wireLiteral("created", "modified", "deleted"),
	before_sha256: wireNullable(wireString), after_sha256: wireNullable(wireString),
	before_mode: wireAbsentOptional(wireNullable(wireNumber)), after_mode: wireAbsentOptional(wireNullable(wireNumber)),
});
const isChangeSet = wireObject<WorkspaceChangeSet>({
	source: wireLiteral("filesystem-observation"), complete: wireBoolean,
	before_captured_at: wireString, after_captured_at: wireString, files: wireArray(isFileEffect),
	attributed_to_other_sessions: wireAbsentOptional(wireNumber),
});

/** Captured records may carry future provider names and extra evidence fields.
 * Every field this build exposes through HarnessEvent must have its real type. */
export const isReplayEvent = wireObject<HarnessEvent>({
	hook_event: wireString, session_id: wireString, agent_source: wireString,
	agent_name: wireAbsentOptional(wireString), timestamp: wireString,
	tool_name: wireAbsentOptional(wireOptional(wireString)), tool_input: wireAbsentOptional(wireOptional(isJsonObject)),
	tool_response: wireAbsentOptional(wireUnknown), tool_use_id: wireAbsentOptional(wireOptional(wireString)),
	post_delivery_token: wireAbsentOptional(wireOptional(wireString)), post_delivery_pid: wireAbsentOptional(wireOptional(wireNumber)),
	seq: wireAbsentOptional(wireNumber), event_id: wireAbsentOptional(wireString),
	files_modified: wireAbsentOptional(wireArray(wireString)), change_set: wireAbsentOptional(isChangeSet),
	sandbox_evidence: wireAbsentOptional(wireLiteral("attested", "configured", "disabled", "unknown")),
	tool_outcome: wireAbsentOptional(wireLiteral("success", "error", "interrupted")),
	error_message: wireAbsentOptional(wireString), exit_code: wireAbsentOptional(wireNumber),
	stderr: wireAbsentOptional(wireString), stdout: wireAbsentOptional(wireString),
	tool_response_sha256: wireAbsentOptional(wireString), cwd: wireAbsentOptional(wireString),
	model: wireAbsentOptional(wireString), dry_run: wireAbsentOptional(wireBoolean),
	parent_agent: wireAbsentOptional(wireString), subagent_id: wireAbsentOptional(wireString),
	agent_type: wireAbsentOptional(wireString), last_assistant_message: wireAbsentOptional(wireString),
	agent_transcript_path: wireAbsentOptional(wireString), parent_tool_use_id: wireAbsentOptional(wireString),
	prompt_id: wireAbsentOptional(wireString), effort: wireAbsentOptional(wireString),
	background_tasks: wireAbsentOptional(wireUnknown), prompt: wireAbsentOptional(wireString),
	agent_role: wireAbsentOptional(wireLiteral("lead", "worker", "subagent", "unknown")),
	transcript_path: wireAbsentOptional(wireString),
});
