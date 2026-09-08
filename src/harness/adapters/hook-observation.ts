import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { UnifiedHookEvent } from "../unified-event.js";

/** Facts supplied by a native boundary; these do not prove who wrote a file. */
export type HookObservation =
    | { kind: "filesystem"; path: string; operation: "add" | "change" | "unlink" | "unknown"; writer: "unknown"; timing: "after" }
    | { kind: "tool_batch"; boundary: "before_model"; calls: Array<{ tool_use_id?: string; tool_name?: string }> }
    | { kind: "configuration"; path?: string; source?: string; timing: "before_runtime_apply" }
    | { kind: "model"; boundary: "before_request" | "after_response" | "tool_selection" };

function batchCalls(raw: JsonObject): Array<{ tool_use_id?: string; tool_name?: string }> {
    if (!Array.isArray(raw.tool_calls)) return [];
    return raw.tool_calls.filter(isJsonObject).map(call => ({
        ...(typeof call.tool_use_id === "string" ? { tool_use_id: call.tool_use_id } : {}),
        ...(typeof call.tool_name === "string" ? { tool_name: call.tool_name } : {}),
    }));
}

/** Phase comes from the provider declaration, never from a caller-supplied tag. */
export function observeNativeHook(event: UnifiedHookEvent, raw: JsonObject): HookObservation | undefined {
    switch (event.phase) {
        case "file-change": {
            if (typeof raw.file_path !== "string") return undefined;
            const operation = (["add", "change", "unlink"] as const).find(value => value === raw.event);
            return { kind: "filesystem", path: raw.file_path, operation: operation ?? "unknown", writer: "unknown", timing: "after" };
        }
        case "post-tool-batch": return { kind: "tool_batch", boundary: "before_model", calls: batchCalls(raw) };
        case "config-change": return { kind: "configuration", timing: "before_runtime_apply", ...(typeof raw.file_path === "string" ? { path: raw.file_path } : {}), ...(typeof raw.source === "string" ? { source: raw.source } : {}) };
        case "pre-model": return { kind: "model", boundary: "before_request" };
        case "post-model": return { kind: "model", boundary: "after_response" };
        case "tool-selection": return { kind: "model", boundary: "tool_selection" };
        default: return undefined;
    }
}
