// ===========================================
// Collection v1 record writer
// ===========================================
// Extracted from server.ts. Maps a `HarnessEvent` to the `JsonObject` shape
// the collection builder expects, builds a `collection.v1` record, and
// appends it. Fire-and-forget — never blocks the pipeline. Only called for
// tool events (pre/post).
//
// `mapEventToCollectionInput` is a pure transformation, split out so the
// mapping logic has a single source of truth (the collection-record test
// previously re-implemented it verbatim and drifted as a result).

import { buildCollectionRecord } from "../../lib/collection/builder.js";
import { appendCollection } from "../../lib/collection/writer.js";
import type { JsonObject } from "../../lib/json-types.js";
import { eventAttributionFields } from "../event-attribution-fields.js";
import type { AgentSource, HarnessEvent } from "../types.js";

/** Empty string = omit `client_runner` (Claude is default; Cursor uses `cursor_version`). */
const CLIENT_RUNNER_BY_AGENT_SOURCE: Record<AgentSource, string> = {
	claude: "",
	codex: "codex",
	copilot: "copilot",
	gemini: "gemini-cli",
	cursor: "",
	opencode: "opencode",
	opencode2: "opencode2",
	pi: "pi",
};

/** Map a `HarnessEvent` to the `JsonObject` the collection builder consumes.
 *  Pure — derives `event_type` from `hook_event`, detects the client runner
 *  from `agent_source`, and falls back to `fallbackCwd` when the event omits
 *  its own `cwd`. */
export function mapEventToCollectionInput(
	event: HarnessEvent,
	fallbackCwd: string,
): JsonObject {
	// Derive event_type from hook_event
	let eventType: string;
	if (event.hook_event === "PreToolUse" || event.hook_event === "BeforeTool") {
		eventType = "tool_use_start";
	} else if (event.hook_event === "PostToolUseFailure") {
		eventType = "tool_use_error";
	} else {
		// PostToolUse / AfterTool
		eventType = "tool_use";
	}

	// Detect client_runner from agent_source for non-Claude providers
	const clientRunner = event.agent_source
		? CLIENT_RUNNER_BY_AGENT_SOURCE[event.agent_source]
		: undefined;
	const cursorVersion = event.agent_source === "cursor" ? "1" : undefined;

	return {
		event_type: eventType,
		ts: event.timestamp,
		hook_event: event.hook_event,
		session: event.session_id,
		tool_name: event.tool_name ?? "",
		tool_input: event.tool_input ?? {},
		tool_response: event.tool_response as JsonObject | undefined,
		tool_use_id: event.tool_use_id,
		cwd: event.cwd ?? fallbackCwd,
		tool_response_sha256: event.tool_response_sha256,
		...(event.seq !== undefined ? { seq: event.seq } : {}),
		...(clientRunner ? { client_runner: clientRunner } : {}),
		...(cursorVersion ? { cursor_version: cursorVersion } : {}),
		...(event.agent_name ? { agent_name: event.agent_name } : {}),
		...eventAttributionFields(event),
	};
}

/** Build and append a `collection.v1` record for a tool event. Best-effort:
 *  any failure (mapping, build, or write) is swallowed so the pipeline never
 *  breaks on collection I/O. */
export function writeCollectionRecord(event: HarnessEvent, fallbackCwd: string): void {
	try {
		const mapped = mapEventToCollectionInput(event, fallbackCwd);
		const record = buildCollectionRecord(mapped);
		if (record) {
			appendCollection(record, event.cwd ?? fallbackCwd);
		}
	} catch {
		// collection is best-effort — never break the pipeline
	}
}
