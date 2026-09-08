import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import type { AdapterOutput } from "./types.js";
import type { AdditionalClientId } from "./additional-client-capabilities.js";

function antigravityDecision(decision: HarnessDecision, event: UnifiedHookEvent): JsonObject {
    if (event.phase === "pre-tool") {
        if (decision.decision === "allow") return {}; // Abstain; do not bypass the native permission policy.
        return { decision: decision.decision === "ask" ? "force_ask" : "deny", reason: decision.reason };
    }
    if (event.phase === "stop" && decision.decision !== "allow") return { decision: "continue", reason: decision.reason };
    if ((event.phase === "pre-model" || event.phase === "post-model") && decision.additional_context) return { injectSteps: [{ ephemeralMessage: decision.additional_context }] };
    return {};
}

function factoryDecision(decision: HarnessDecision, event: UnifiedHookEvent): JsonObject {
    const name = event.runner_native_event;
    if (event.phase === "pre-tool") return factoryPreTool(decision, name);
    if (["post-tool", "user-prompt", "stop", "subagent-stop"].includes(event.phase) && decision.decision !== "allow") return { decision: "block", reason: decision.reason };
    if (event.phase === "user-prompt" && decision.additional_context) return { additionalContext: decision.additional_context };
    if (["post-tool", "session-start"].includes(event.phase) && decision.additional_context) return { hookSpecificOutput: { hookEventName: name, additionalContext: decision.additional_context } };
    return {};
}

function factoryPreTool(decision: HarnessDecision, name: string): JsonObject {
    const output: JsonObject = { hookEventName: name };
    if (decision.decision !== "allow") { output.permissionDecision = decision.decision === "ask" ? "ask" : "deny"; output.permissionDecisionReason = decision.reason; }
    if (decision.updated_input) output.updatedInput = decision.updated_input;
    return Object.keys(output).length > 1 ? { hookSpecificOutput: output } : {};
}

function refusedRewrite(id: AdditionalClientId, decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput | undefined {
    if (!decision.updated_input || event.phase !== "pre-tool" || (id !== "antigravity" && id !== "windsurf")) return undefined;
    const reason = "This native hook cannot apply the required input rewrite.";
    return { exit_code: id === "windsurf" ? 2 : 0, stdout: id === "antigravity" ? JSON.stringify({ decision: "deny", reason }) : undefined, stderr: reason,
        translation: { status: "degraded", requested: ["rewrite_input"], encoded: ["deny"], reason } };
}

function crushDecision(decision: HarnessDecision, event: UnifiedHookEvent): JsonObject {
    if (event.phase !== "pre-tool") return {};
    const body: JsonObject = {};
    if (decision.decision !== "allow") { body.decision = "deny"; body.reason = decision.reason; }
    if (decision.updated_input) body.updated_input = decision.updated_input;
    if (decision.additional_context) body.context = decision.additional_context;
    return body;
}

export function encodeAdditionalClientDecision(id: AdditionalClientId, decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput {
    const rewrite = refusedRewrite(id, decision, event);
    if (rewrite) return rewrite;
    const feedback = [...(decision.warnings ?? []), decision.additional_context, decision.reason, inputMeasurementWarning(id, event)].filter(Boolean).join("\n");
    if (id === "windsurf") {
        const deny = (event.phase === "pre-tool" || event.phase === "user-prompt") && decision.decision !== "allow";
        return { exit_code: deny ? 2 : 0, stderr: feedback || undefined };
    }
    const encoders = { "factory-droid": factoryDecision, antigravity: antigravityDecision, crush: crushDecision };
    return { stdout: JSON.stringify(encoders[id](decision, event)), stderr: feedback || undefined, exit_code: 0 };
}

function inputMeasurementWarning(id: AdditionalClientId, event: UnifiedHookEvent): string | undefined {
    if (id !== "antigravity" || event.phase !== "pre-tool" || !isJsonObject(event.raw)) return undefined;
    const tool = event.raw.toolCall;
    if (!isJsonObject(tool)) return undefined;
    if (tool.name === "replace_file_content" || tool.name === "multi_replace_file_content") return "[interlinked:content-overlay] NOT MEASURED: native positional/chunk edit semantics have no certified post-image applier; checks requiring the proposed file cannot certify this edit.";
    return undefined;
}
