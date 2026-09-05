import { appendCapturedData, recordCaptureReceipt } from "../lib/data/capture.js";
import { dataRecordHash } from "../lib/data/normalize.js";
import { updateCaptureState } from "../lib/data/state.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

function warningIdentity(message: string): string {
    // Numeric changes retain identity; their complete new text is recorded as changed.
    return dataRecordHash(message.replace(/\b\d+\b/g, "#"));
}
function priorWarnings(state: JsonObject): Map<string, JsonObject> {
    const rows = Array.isArray(state.warnings) ? state.warnings.filter(isJsonObject) : [];
    return new Map(rows.map((row) => [String(row.warning_id), row]));
}
function occurrence(message: string, previous: Map<string, JsonObject>, identity: JsonObject): JsonObject {
    const id = warningIdentity(message);
    const old = previous.get(id);
    const hash = dataRecordHash(message);
    const count = typeof old?.repeat_count === "number" ? old.repeat_count + 1 : 1;
    const kind = old ? old.message_hash === hash ? "repeat" : "changed" : "first";
    return { ...identity, warning_id: id, message_hash: hash, kind, repeat_count: count,
        first_seen: old?.first_seen ?? identity.ts, message: kind === "repeat" ? null : message,
        check: /^\[interlinked:([^\] ]+)/.exec(message)?.[1] ?? null };
}
function disappeared(previous: Map<string, JsonObject>, rows: JsonObject[], identity: JsonObject): JsonObject[] {
    const current = new Set(rows.map((row) => row.warning_id));
    return [...previous.values()].filter((row) => !current.has(row.warning_id)).map((row) => ({
        ...identity, warning_id: row.warning_id, message_hash: row.message_hash, kind: "not-reported",
        basis: "absent from next matching evaluation; no causal resolution claim", repeat_count: row.repeat_count,
    }));
}
function projectedWarning(message: string, row: JsonObject | undefined): string {
    if (row?.kind !== "repeat") return message;
    return `[interlinked:repeat] ${row.warning_id} occurrence ${row.repeat_count}; message SHA256 ${row.message_hash}; text retained in warning-occurrences.jsonl`;
}

/** Preserve full first/changed messages and every occurrence, shortening only the activity mirror. */
export function captureGuardWarnings(cwd: string, event: HarnessEvent, decision: HarnessDecision): string[] | null {
    const warnings = decision.warnings ?? [];
    if (event.dry_run) return warnings;
    const context = { cwd, producer: "harness/warning-evidence", session: event.session_id };
    try {
        const file = event.tool_input?.file_path ?? event.tool_input?.path ?? null;
        const scope = JSON.stringify([event.session_id, event.subagent_id, event.hook_event, event.tool_name, file]);
        return updateCaptureState(cwd, `warnings:${scope}`, (state) => {
            const previous = priorWarnings(state);
            const identity = { ts: event.timestamp, session_id: event.session_id, tool_use_id: event.tool_use_id ?? null, file };
            const rows = warnings.map((message) => occurrence(message, previous, identity));
            const removed = disappeared(previous, rows, identity);
            if (!appendCapturedData(context, "warning-occurrences", [...rows, ...removed])) throw new Error("warning-write-failed");
            return { state: { warnings: rows }, result: warnings.map((message, index) => projectedWarning(message, rows[index])) };
        });
    } catch {
        recordCaptureReceipt(context, { source: "warning-occurrences", status: "failed", error: "state-or-append-failed" });
        return warnings;
    }
}
