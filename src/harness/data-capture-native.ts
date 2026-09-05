import { appendCapturedData } from "../lib/data/capture.js";
import { isJsonObject } from "../lib/json-types.js";
import type { HarnessEvent } from "./types.js";
import { classifyVerificationCommand } from "./verification-stop-checks-predicates.js";

function eventIdentity(event: HarnessEvent): object {
    return { ts: event.timestamp, session_id: event.session_id, agent: event.agent_name ?? null,
        provider: event.agent_source, model: event.model ?? null, subagent_id: event.subagent_id ?? null,
        parent_agent: event.parent_agent ?? null, tool_use_id: event.tool_use_id ?? null,
        event_id: event.event_id ?? null, seq: event.seq ?? null, tool: event.tool_name ?? null };
}
function verificationOutcome(event: HarnessEvent): { outcome: string; basis: string; exit_code: number | null } {
    const response = isJsonObject(event.tool_response) ? event.tool_response : {};
    const code = event.exit_code ?? response.exit_code;
    if (event.tool_outcome === "interrupted") return { outcome: "interrupted", basis: "provider", exit_code: null };
    if (typeof code === "number" && Number.isInteger(code)) return { outcome: code === 0 ? "pass" : "fail", basis: "exit-code", exit_code: code };
    if (event.tool_outcome === "error") return { outcome: "fail", basis: "provider", exit_code: null };
    if (event.tool_outcome === "success") return { outcome: "pass", basis: "provider", exit_code: null };
    return { outcome: "unknown", basis: "no-explicit-outcome", exit_code: null };
}

export function nativeVerificationRecord(event: HarnessEvent): object | null {
    const command = event.tool_input?.command ?? event.tool_input?.cmd;
    if (typeof command !== "string") return null;
    const kind = classifyVerificationCommand(command);
    if (!kind) return null;
    return { schema: "verification-command.v1", ...eventIdentity(event), kind, command,
        classification: "command-shape", ...verificationOutcome(event),
        tool_response_sha256: event.tool_response_sha256 ?? null,
        ...verificationDuration(event) };
}

function verificationDuration(event: HarnessEvent): object {
    const response = isJsonObject(event.tool_response) ? event.tool_response : {};
    const duration = response.duration_ms ?? response.elapsed_ms;
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) return { duration_ms: duration, duration_status: "provider-reported" };
    return { duration_ms: null, duration_status: "not-reported" };
}

export function nativeFileRecords(event: HarnessEvent): object[] {
    if (event.change_set) return event.change_set.files.map((effect) => ({
        schema: "file-touch.v1", ...eventIdentity(event), ...effect, file: effect.path,
        evidence: "filesystem-observation", observation_complete: event.change_set?.complete,
        before_captured_at: event.change_set?.before_captured_at, after_captured_at: event.change_set?.after_captured_at,
        lines_added: null, lines_removed: null, line_counts_status: "not-measured",
    }));
    const files = [...new Set(event.files_modified ?? [])];
    return files.map((file) => ({ schema: "file-touch.v1", ...eventIdentity(event), file,
        evidence: "provider-declared", observation_complete: false,
        lines_added: null, lines_removed: null, line_counts_status: "not-measured" }));
}

/** The completed daemon event owns these feeds, including shell/MCP file effects. */
export function captureNativeToolData(cwd: string, event: HarnessEvent): void {
    if (event.dry_run) return;
    if (!["PostToolUse", "AfterTool", "PostToolUseFailure"].includes(event.hook_event)) return;
    const context = { cwd, producer: "harness/data-capture-native", session: event.session_id, provider: event.agent_source };
    const verification = nativeVerificationRecord(event);
    if (verification) appendCapturedData(context, "tests", [verification]);
    appendCapturedData(context, "files-touched", nativeFileRecords(event));
}
