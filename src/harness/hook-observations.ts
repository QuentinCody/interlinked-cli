import { appendCapturedData } from "../lib/data/capture.js";
import type { HarnessEvent } from "./types.js";

export interface HookObservation {
    kind: "scheduled" | "metric" | "trajectory" | "advisory";
    check: string;
    message: string;
    file?: string;
    delivered?: boolean;
    related_tool_use_ids?: string[];
}

/** Retain non-actionable evidence without presenting it as a check verdict. */
export function recordHookObservations(event: HarnessEvent, observations: readonly HookObservation[]): void {
    if (event.dry_run || observations.length === 0) return;
    appendCapturedData(
        { cwd: event.cwd || process.cwd(), producer: "harness/hook-observations", session: event.session_id },
        "check-executions",
        observations.map((observation) => ({
            schema: "hook-observation.v1", ts: event.timestamp, session_id: event.session_id,
            tool_use_id: event.tool_use_id ?? null, hook_event: event.hook_event,
            ...observation, delivered: observation.delivered ?? false,
        })),
    );
}
