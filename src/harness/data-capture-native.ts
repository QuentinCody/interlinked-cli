import { appendCapturedData } from "../lib/data/capture.js";
import { isJsonObject } from "../lib/json-types.js";
import { isOutcomeAttributable, observedOutput, parseTestSummary } from "./test-outcome-evidence.js";
import type { HarnessEvent } from "./types.js";
import { classifyVerificationCommand, type VerificationSignal } from "./verification-stop-checks-predicates.js";

function eventIdentity(event: HarnessEvent): object {
    return { ts: event.timestamp, session_id: event.session_id, agent: event.agent_name ?? null,
        provider: event.agent_source, model: event.model ?? null, subagent_id: event.subagent_id ?? null,
        parent_agent: event.parent_agent ?? null, tool_use_id: event.tool_use_id ?? null,
        event_id: event.event_id ?? null, seq: event.seq ?? null, tool: event.tool_name ?? null };
}
type VerificationOutcome = { outcome: string; basis: string; exit_code: number | null; exit_attributable: boolean };

/** `exit_code` is always the SHELL's status. It is the check's verdict only when
 *  `exit_attributable` is true: `vitest … | tail` exits with tail's status, so
 *  there the runner's own summary decides, and with no summary the outcome is
 *  unknown, in both directions (a hidden 0 is no pass, a hidden 1 is no fail). */
function verificationOutcome(event: HarnessEvent, kind: VerificationSignal, command: string): VerificationOutcome {
    const exit_attributable = isOutcomeAttributable(command, kind);
    if (event.tool_outcome === "interrupted") return { outcome: "interrupted", basis: "provider", exit_code: null, exit_attributable };
    const code = shellExitCode(event);
    return exit_attributable ? ownStatusOutcome(event, code) : hiddenStatusOutcome(event, kind, code);
}

function shellExitCode(event: HarnessEvent): number | null {
    const response = isJsonObject(event.tool_response) ? event.tool_response : {};
    const raw = event.exit_code ?? response.exit_code;
    return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
}

/** The shell's status belongs to the check: it is the verdict. */
function ownStatusOutcome(event: HarnessEvent, code: number | null): VerificationOutcome {
    if (code !== null) return { outcome: code === 0 ? "pass" : "fail", basis: "exit-code", exit_code: code, exit_attributable: true };
    if (event.tool_outcome === "error") return { outcome: "fail", basis: "provider", exit_code: null, exit_attributable: true };
    if (event.tool_outcome === "success") return { outcome: "pass", basis: "provider", exit_code: null, exit_attributable: true };
    return { outcome: "unknown", basis: "no-explicit-outcome", exit_code: null, exit_attributable: true };
}

/** A pipe or a later command owns the shell's status: only the runner's own
 *  summary can give a verdict. The shell's status is kept as a fact. */
function hiddenStatusOutcome(event: HarnessEvent, kind: VerificationSignal, code: number | null): VerificationOutcome {
    const verdict = kind === "test" ? parseTestSummary(observedOutput(event)) : null;
    if (verdict) return { outcome: verdict === "green" ? "pass" : "fail", basis: "runner-summary", exit_code: code, exit_attributable: false };
    return { outcome: "unknown", basis: "exit-status-not-attributable", exit_code: code, exit_attributable: false };
}

export function nativeVerificationRecord(event: HarnessEvent): object | null {
    const command = event.tool_input?.command ?? event.tool_input?.cmd;
    if (typeof command !== "string") return null;
    const kind = classifyVerificationCommand(command);
    if (!kind) return null;
    return { schema: "verification-command.v1", ...eventIdentity(event), kind, command,
        classification: "command-shape", ...verificationOutcome(event, kind, command),
        tool_response_sha256: event.tool_response_sha256 ?? null,
        ...verificationDuration(event) };
}

function verificationDuration(event: HarnessEvent): object {
    const response = isJsonObject(event.tool_response) ? event.tool_response : {};
    const duration = response.duration_ms ?? response.elapsed_ms;
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) return { duration_ms: duration, duration_status: "provider-reported" };
    return { duration_ms: null, duration_status: "not-reported" };
}

/** files-touched rows. An observed effect carries `attribution` and, when the
 *  call could not have made it (a sibling's write inside the call window),
 *  `shadow: true` + `shadow_reason` — rule in `touch-attribution.ts`. Shadow
 *  rows are kept so "the workspace changed during this call" stays visible;
 *  per-actor counts must filter `shadow != true`. */
export function nativeFileRecords(event: HarnessEvent): object[] {
    if (event.change_set) return event.change_set.files.map((effect) => ({
        schema: "file-touch.v1", ...eventIdentity(event), ...effect, file: effect.path,
        ...(effect.attribution ? { shadow: effect.attribution === "shadow" } : {}),
        evidence: "filesystem-observation", observation_complete: event.change_set?.complete,
        before_captured_at: event.change_set?.before_captured_at, after_captured_at: event.change_set?.after_captured_at,
        lines_added: null, lines_removed: null, line_counts_status: "not-measured",
    }));
    const files = [...new Set(event.files_modified ?? [])];
    return files.map((file) => ({ schema: "file-touch.v1", ...eventIdentity(event), file,
        evidence: "provider-declared", attribution: "declared-target", shadow: false, observation_complete: false,
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
