import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import type { AdapterOutput } from "./types.js";

const WATCH_BOUNDARIES = new Set(["SessionStart", "CwdChanged", "FileChanged"]);
const OBSERVERS = new Set(["FileChanged", "CwdChanged", "InstructionsLoaded", "DirectoryAdded", "WorktreeRemove", "PostCompact"]);

function observerOutput(decision: HarnessDecision, name: string): AdapterOutput {
    const body: JsonObject = {};
    if (WATCH_BOUNDARIES.has(name) && decision.watch_paths) body.watchPaths = decision.watch_paths;
    const feedback = [...(decision.warnings ?? []), decision.additional_context, decision.reason].filter(Boolean).join("\n");
    const output: AdapterOutput = { stdout: Object.keys(body).length ? JSON.stringify(body) : undefined, stderr: feedback || undefined, exit_code: 0 };
    if (decision.decision !== "allow") output.translation = { status: "unsupported", requested: [decision.decision === "ask" ? "ask" : "deny"], encoded: [], reason: `${name} observes an already completed change.` };
    return output;
}

function batchCancellation(decision: HarnessDecision): AdapterOutput {
    return {
        stdout: JSON.stringify({ decision: "block", reason: decision.reason ?? "Verification pending" }),
        stderr: (decision.warnings ?? []).join("\n") || undefined, exit_code: 0,
        translation: { status: "degraded", requested: ["deny"], encoded: ["cancel"], reason: "Stops the loop before the next model call; tool execution is already complete." },
    };
}

/** Return undefined for existing boundaries, whose encoder retains ownership. */
export function encodeClaudeAdditionalBoundary(decision: HarnessDecision, event: UnifiedHookEvent | undefined): AdapterOutput | undefined {
    if (!event?.runner_native_event) return undefined;
    if (isManagedPolicyChange(event)) return observerOutput(decision, "Managed ConfigChange");
    return encodeAdditionalDecision(decision, event.runner_native_event);
}

function isManagedPolicyChange(event: UnifiedHookEvent): boolean {
    return event.runner_native_event === "ConfigChange" && isJsonObject(event.raw) && event.raw.source === "policy_settings";
}

function encodeAdditionalDecision(decision: HarnessDecision, name: string): AdapterOutput | undefined {
    if (OBSERVERS.has(name)) return observerOutput(decision, name);
    const body: JsonObject = {};
    const specific: JsonObject = { hookEventName: name };
    if (name === "SessionStart" && decision.watch_paths) body.watchPaths = decision.watch_paths;
    if (name === "PreToolUse" && decision.decision === "allow" && decision.updated_input) specific.updatedInput = decision.updated_input;
    if (name === "PostToolBatch" && decision.decision !== "allow") return batchCancellation(decision);
    if (!Object.keys(body).length && Object.keys(specific).length === 1) return undefined;
    const feedback = [...(decision.warnings ?? []), decision.additional_context].filter(Boolean).join("\n");
    if (feedback) specific.additionalContext = feedback;
    if (Object.keys(specific).length > 1) body.hookSpecificOutput = specific;
    return { stdout: JSON.stringify(body), stderr: (decision.warnings ?? []).join("\n") || undefined, exit_code: 0 };
}
