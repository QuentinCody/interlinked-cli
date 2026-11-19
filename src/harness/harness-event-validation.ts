import type { HarnessEvent } from "./types.js";
import type { WorkspaceChangeSet, WorkspaceFileEffect } from "./workspace-effects.js";
import { isJsonObject } from "../lib/json-types.js";
import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireOptional, wireString, wireUnknown } from "../lib/value-validation.js";

const isFileEffect = wireObject<WorkspaceFileEffect>({
	path: wireString, kind: wireLiteral("created", "modified", "deleted"),
	before_sha256: wireNullable(wireString), after_sha256: wireNullable(wireString),
	before_mode: wireAbsentOptional(wireNullable(wireNumber)), after_mode: wireAbsentOptional(wireNullable(wireNumber)),
	attribution: wireAbsentOptional(wireLiteral("declared-target", "observed-in-window", "shadow")),
	shadow_reason: wireAbsentOptional(wireLiteral("read-only-tool", "not-declared-target", "in-flight-target-of-other-actor", "attributed-to-other-actor", "changed-before-call")),
});
const isChangeSet = wireObject<WorkspaceChangeSet>({
	source: wireLiteral("filesystem-observation"), complete: wireBoolean,
	before_captured_at: wireString, after_captured_at: wireString, files: wireArray(isFileEffect),
	attributed_to_other_sessions: wireAbsentOptional(wireNumber),
});

/** Live and captured records may carry future provider names and extra evidence fields.
 * Every field this build exposes through HarnessEvent must have its real type. */
export const isHarnessEvent = wireObject<HarnessEvent>({
	hook_event: wireString, session_id: wireString, agent_source: wireString,
	agent_name: wireAbsentOptional(wireString), timestamp: wireString,
	tool_name: wireAbsentOptional(wireOptional(wireString)), tool_input: wireAbsentOptional(wireOptional(isJsonObject)),
	tool_response: wireAbsentOptional(wireUnknown), tool_use_id: wireAbsentOptional(wireOptional(wireString)),
	write_attribution: wireAbsentOptional(wireLiteral("declared-target", "observed-workspace")),
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

/** Older raw clients omit observational metadata. Preserve their live-clock fallback,
 * while rejecting malformed identity, tool and control fields before dispatch. */
export function parseLiveHarnessEvent(value: unknown): HarnessEvent | null {
	if (!isJsonObject(value)) return null;
	const event: Record<string, unknown> = {
		...value,
		agent_source: value.agent_source === undefined ? "unknown" : value.agent_source,
		timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
	};
	// The self-contained generated hook serializes these absent fields as null.
	// Normalize only this known wire convention; flags, identities and collections
	// still have to satisfy their declared shape. Captured replay records stay strict.
	for (const key of ["agent_name", "tool_name", "tool_input", "tool_use_id", "cwd", "model", "tool_outcome", "error_message", "exit_code", "stderr", "stdout", "tool_response_sha256"]) {
		if (event[key] === null) delete event[key];
	}
	return isHarnessEvent(event) ? event : null;
}
