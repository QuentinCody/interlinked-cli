import { existsSync } from "node:fs";
import { iterateFileLines } from "../lib/audit-chain-io.js";
import { appendCapturedData } from "../lib/data/capture.js";
import { interlinkedPath } from "../lib/interlinked-path.js";
import { isJsonObject } from "../lib/json-types.js";
import type { RecurrenceEvent } from "./recurrence.js";

const KINDS = new Set(["harness_caught", "harness_missed", "codebase_existing", "outcome_marker", "tool_failure"]);
function isRecurrenceEvent(value: unknown): value is RecurrenceEvent {
    return isJsonObject(value) && typeof value.ts === "string" && typeof value.kind === "string" && KINDS.has(value.kind);
}
export function recurrencesPath(cwd: string): string { return interlinkedPath(cwd, "recurrences.jsonl"); }

export function recordRecurrenceEvent(event: RecurrenceEvent, cwd: string): void {
    if (!appendCapturedData({ cwd, producer: "harness/recurrence" }, "recurrences", [event])) throw new Error("recurrence write failed; see capture-receipts.jsonl");
}

/** Streaming compatibility reader: memory is bounded by one line and the consumer's aggregate. */
export function* iterateRecurrenceEvents(cwd: string): Generator<RecurrenceEvent> {
    const path = recurrencesPath(cwd);
    if (!existsSync(path)) return;
    for (const line of iterateFileLines(path)) {
        if (!line.trim()) continue;
        try {
            const parsed: unknown = JSON.parse(line);
            if (isRecurrenceEvent(parsed)) yield parsed;
        } catch { /* Legacy best-effort reader; data health/index records parse diagnostics. */ }
    }
}

/** Compatibility for callers that explicitly need an array. CLI aggregation streams. */
export function loadRecurrenceEvents(cwd: string): RecurrenceEvent[] { return [...iterateRecurrenceEvents(cwd)]; }
