// ===========================================
// Latency-log record builder
// ===========================================
// Extracted from server.ts `evaluateEventLine`. Maps a raw event line plus the
// decision the daemon returned into the `LatencyLogEntry` shape appended to
// `latency.jsonl`. Pure — re-parses the line defensively (a malformed line
// yields all-null event fields rather than throwing) so the caller's logging
// path stays a single `appendLatencyLog(dir, buildLatencyRecord(...))` call.

import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { LatencyLogEntry } from "../latency-log.js";
import type { HarnessDecision } from "../types.js";

/** Build the latency-log entry for one evaluated event. Event metadata comes
 *  from re-parsing `line` (best-effort: unparseable → null fields); timing and
 *  decision metadata come from `decision`. Never throws. */
export function buildLatencyRecord(line: string, decision: HarnessDecision): LatencyLogEntry {
	let evt: JsonObject = {};
	try {
		const parsed: unknown = JSON.parse(line);
		if (isJsonObject(parsed)) evt = parsed;
	} catch (e) {
		void e;
	}
	return {
		hook_event: typeof evt.hook_event === "string" ? evt.hook_event : null,
		tool_name: typeof evt.tool_name === "string" ? evt.tool_name : null,
		session_id: typeof evt.session_id === "string" ? evt.session_id : null,
		agent_source: typeof evt.agent_source === "string" ? evt.agent_source : null,
		decision: decision.decision,
		checks_ran: decision.checks_ran ?? null,
		checks_timing_ms: decision.checks_timing_ms ?? null,
		tool_breakdown: decision.tool_breakdown ?? null,
		phase_breakdown: decision.phase_breakdown ?? null,
	};
}
