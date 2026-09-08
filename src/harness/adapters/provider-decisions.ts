import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import type { JsonObject } from "../../lib/json-types.js";
import type { HookControl, HookTranslation } from "./hook-contract.js";
import type { AdapterOutput } from "./types.js";

function reasonOf(decision: HarnessDecision): string {
    const fallback = decision.decision === "ask" ? "Confirmation required" : "Blocked by the interlinked harness, but no reason was attached — likely a harness bug; run interlinked harness restart and report it.";
    return formatAskReasonWithTargets(decision.reason ?? fallback, decision.resolved_targets);
}

function refusalOutput(decision: HarnessDecision, payload: JsonObject | undefined, controls: HookControl[], reason?: string): AdapterOutput {
    const requested: HookControl = decision.decision === "ask" ? "ask" : "deny";
    let status: HookTranslation["status"] = "unsupported";
    if (controls.length) status = "degraded";
    if (controls.includes(requested)) status = "encoded";
    return {
        stdout: payload ? JSON.stringify(payload) : undefined,
        stderr: [...(decision.warnings ?? []), ...(reason ? [reason] : [])].join("\n") || undefined,
        exit_code: 0,
        translation: { status, requested: [requested], encoded: controls, ...(reason ? { reason } : {}) },
    };
}

function copilotRefusal(decision: HarnessDecision, name: string): AdapterOutput {
    const reason = reasonOf(decision);
    if (name === "preToolUse") {
        // Current CLI docs describe ask, but older runtimes ignore it. Until
        // this installation has a native approval receipt, preserve denial.
        return refusalOutput(decision, { permissionDecision: "deny", permissionDecisionReason: reason }, ["deny"]);
    }
    if (name === "permissionRequest" && decision.decision === "block") return refusalOutput(decision, { behavior: "deny", message: reason }, ["deny"]);
    if (name === "agentStop" || name === "subagentStop") return refusalOutput(decision, { decision: "block", reason }, ["continue"], "Stop refusal requests another iteration; it does not undo executed tools.");
    if (name === "postToolUse") return refusalOutput(decision, { additionalContext: [reason, decision.additional_context].filter(Boolean).join("\n") }, ["context"]);
    return refusalOutput(decision, undefined, [], `${name} cannot encode this decision: ${reason}`);
}

/** Copilot CLI command-hook protocol. Cloud jobs require a separate profile. */
export function encodeCopilotDecision(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput {
    const name = event.runner_native_event;
    if (decision.decision !== "allow") return copilotRefusal(decision, name);
    const body: JsonObject = {};
    if (name === "preToolUse" && decision.updated_input) body.modifiedArgs = decision.updated_input;
    if (["postToolUse", "subagentStart", "notification"].includes(name) && decision.additional_context) body.additionalContext = decision.additional_context;
    const feedback = [...(decision.warnings ?? [])];
    if (decision.additional_context && !body.additionalContext) feedback.push(decision.additional_context);
    return { stdout: Object.keys(body).length ? JSON.stringify(body) : undefined, stderr: feedback.join("\n") || undefined, exit_code: 0 };
}

const GEMINI_DENY_EVENTS = new Set(["BeforeTool", "BeforeAgent", "BeforeModel", "AfterAgent", "AfterModel", "AfterTool"]);
const GEMINI_CONTEXT_EVENTS = new Set(["BeforeTool", "AfterTool", "SessionStart", "BeforeAgent", "AfterAgent"]);

function geminiRefusal(decision: HarnessDecision, name: string): AdapterOutput {
    const reason = reasonOf(decision);
    if (!GEMINI_DENY_EVENTS.has(name)) return refusalOutput(decision, {}, [], `${name} is observational; decision not enforced: ${reason}`);
    const controls: HookControl[] = name === "AfterAgent" ? ["continue"] : name.startsWith("After") ? ["replace_result"] : ["deny"];
    const output = refusalOutput(decision, { decision: "deny", reason }, controls);
    if (decision.decision === "ask" && output.translation) output.translation.reason = "Gemini has no hook approval primitive; confirmation is conservatively denied.";
    return output;
}

/** Gemini requires valid JSON even for a no-op. An ask must never silently allow. */
export function encodeGeminiDecision(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput {
    const name = event.runner_native_event;
    if (decision.decision !== "allow") return geminiRefusal(decision, name);
    const body: JsonObject = {};
    const specific: JsonObject = { hookEventName: name };
    if (name === "BeforeTool" && decision.updated_input) specific.tool_input = decision.updated_input;
    if (GEMINI_CONTEXT_EVENTS.has(name) && decision.additional_context) specific.additionalContext = decision.additional_context;
    if (Object.keys(specific).length > 1) body.hookSpecificOutput = specific;
    return { stdout: JSON.stringify(body), stderr: (decision.warnings ?? []).join("\n") || undefined, exit_code: 0 };
}
