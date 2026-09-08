import { isJsonObject } from "../lib/json-types.js";
import { wireAbsentOptional, parseWire, wireArray, wireNullable, wireNumber, wireObject, wireOptional, wireString, wireUnknown } from "../lib/value-validation.js";
import type { ServerGitContext, ServerPushResult } from "./git-support.js";

const isCheckpoint = wireObject<NonNullable<ServerGitContext["latest_checkpoint"]>>({
	id: wireNumber, agent: wireString, trigger: wireAbsentOptional(wireString),
	summary: wireAbsentOptional(wireString), created_at: wireAbsentOptional(wireString),
});
const isBridgeEvent = wireObject<NonNullable<ServerGitContext["bridge_events"]>[number]>({
	id: wireNumber, event_type: wireString, checkpoint_id: wireNumber,
	checkpoint_summary: wireAbsentOptional(wireString), agent_name: wireAbsentOptional(wireString),
	branch_name: wireAbsentOptional(wireString), metadata: wireAbsentOptional(wireUnknown), pushed_at: wireAbsentOptional(wireString),
});
const isGitContext = wireObject<ServerGitContext>({
	latest_checkpoint: wireAbsentOptional(isCheckpoint), trailers: wireAbsentOptional(wireArray(wireString)),
	commit_sha: wireAbsentOptional(wireNullable(wireString)), message: wireAbsentOptional(wireString),
	bridge_events: wireAbsentOptional(wireArray(isBridgeEvent)),
});
const isPushResult = wireObject<ServerPushResult>({
	checkpoint_id: wireAbsentOptional(wireNumber), trailers: wireAbsentOptional(wireOptional(wireArray(wireString))), trailers_text: wireAbsentOptional(wireString),
	notes: wireAbsentOptional(wireOptional(isJsonObject)), notes_json: wireAbsentOptional(wireOptional(wireString)), instructions: wireAbsentOptional(wireString),
});

export function parseGitContext(value: unknown): ServerGitContext | null {
	return value == null ? null : parseWire(value, isGitContext, "get_git_context response");
}

export function parsePushResult(value: unknown): ServerPushResult | null {
	return value == null ? null : parseWire(value, isPushResult, "push_checkpoint_to_git response");
}
