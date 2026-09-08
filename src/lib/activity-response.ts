import type { ActivityEvent } from "./activity-utils.js";
import type { EventAttribution, TokenUsage } from "./local-activity-types.js";
import { wireAbsentOptional, parseWire, wireArray, wireBoolean, wireLiteral, wireNullable, wireNumber, wireObject, wireString } from "./value-validation.js";

export interface ActivityFeedResponse {
	events?: ActivityEvent[];
	activity?: ActivityEvent[];
	activities?: ActivityEvent[];
}

const maybeString = wireAbsentOptional(wireString);
const maybeNullableString = wireAbsentOptional(wireNullable(wireString));
const isActivityEvent = wireObject<ActivityEvent>({
	id: wireAbsentOptional(wireNumber), agent_name: maybeString, agent: maybeString,
	event_type: maybeString, type: maybeString, tool_name: maybeNullableString, tool: maybeNullableString,
	tool_input_summary: maybeNullableString, summary: maybeNullableString,
	occurred_at: maybeString, ts: maybeString, timestamp: maybeString, created_at: maybeString,
	duration_ms: wireAbsentOptional(wireNumber), _source: maybeString,
	schema_version: wireAbsentOptional(wireLiteral(2, 3, 4, 5)), trace_id: maybeString,
	parent_agent: maybeString, subagent_id: maybeString,
	tokens: wireAbsentOptional(wireObject<TokenUsage>({ input: wireAbsentOptional(wireNumber), output: wireAbsentOptional(wireNumber), cache_read: wireAbsentOptional(wireNumber), cache_creation: wireAbsentOptional(wireNumber) })),
	files_modified: wireAbsentOptional(wireArray(wireString)),
	attribution: wireAbsentOptional(wireObject<EventAttribution>({ agent_lines: wireAbsentOptional(wireNumber), human_lines: wireAbsentOptional(wireNumber) })),
	checkpoint_id: maybeString, scrubbed: wireAbsentOptional(wireBoolean),
});

const isActivityFeed = wireObject<ActivityFeedResponse>({
	events: wireAbsentOptional(wireArray(isActivityEvent)),
	activity: wireAbsentOptional(wireArray(isActivityEvent)),
	activities: wireAbsentOptional(wireArray(isActivityEvent)),
});

/** Preserve server aliases and extra evidence while checking every consumed field. */
export function parseActivityFeed(value: unknown): ActivityFeedResponse | undefined {
	return value == null ? undefined : parseWire(value, isActivityFeed, "activity feed response");
}
