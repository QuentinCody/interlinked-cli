import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import { adapterToolClassifier } from "./adapter-tool-class.js";
import type { AdapterOutput, RunnerAdapter, RunnerCapabilities } from "./types.js";
import type { HarnessDecision } from "../types.js";
import type { UnifiedHookEvent } from "../unified-event.js";
import { encodeCoworkVerdict, type CoworkVerdict } from "../../lib/cowork/native.js";
import { COWORK_EVENTS } from "../../lib/cowork/capabilities.js";
import type { HookControl } from "./hook-contract.js";

const PHASES = { SessionStart: "session-start", SessionEnd: "session-end", UserPromptSubmit: "user-prompt", PreToolUse: "pre-tool", PostToolUse: "post-tool", Stop: "stop" } as const;
export const COWORK_CAPABILITIES: RunnerCapabilities = {
    project_hook_path: "hooks/hooks.json", hook_trust: "provider-managed", status_line: "none",
    events: COWORK_EVENTS.map(name => ({ name, phase: PHASES[name], install: true,
        control: name === "PreToolUse" ? "deny" : "observe", controls: name === "PreToolUse" ? ["deny", "ask", "rewrite_input", "context"] : name === "PostToolUse" ? ["context"] : [],
        model_context: name === "PreToolUse" || name === "PostToolUse", missing_runtime: "warn_open" })),
};

function portableVerdict(decision: HarnessDecision): CoworkVerdict {
    return { decision: decision.decision === "block" ? "deny" : decision.decision, updatedInput: decision.updated_input, checks: [], unmeasured: [],
        reason: decision.reason ?? "Cowork policy requires review.",
        context: [...(decision.warnings ?? []), decision.additional_context ?? ""].filter(Boolean).join("\n") };
}

function encodeDecision(decision: HarnessDecision, event: UnifiedHookEvent): AdapterOutput {
    const verdict = portableVerdict(decision);
    const body = encodeCoworkVerdict(event.runner_native_event, verdict);
    const requested: HookControl[] = [];
    if (decision.decision !== "allow") requested.push(decision.decision === "block" ? "deny" : "ask");
    if (decision.updated_input) requested.push("rewrite_input");
    if (verdict.context) requested.push("context");
    const encoded = requested.filter(control => {
        if (control === "context") return event.phase === "pre-tool" || event.phase === "post-tool";
        return event.phase === "pre-tool" && (control !== "rewrite_input" || decision.decision === "allow");
    });
    return { stdout: body ? JSON.stringify(body) : undefined, stderr: verdict.context || undefined, exit_code: 0,
        translation: { status: encoded.length === requested.length ? "encoded" : "degraded", requested, encoded } };
}

/** Plugin packaging owns installation. Never writes Claude Code settings. */
export function createCoworkAdapter(): RunnerAdapter {
    return {
        id: "cowork", label: "Claude Cowork (experimental)", experimental: true, installByDefault: false,
        capabilities: COWORK_CAPABILITIES, nativeEventNames: COWORK_EVENTS,
        detectFromEnv: env => env.INTERLINKED_RUNNER === "cowork",
        classifyToolClass: adapterToolClassifier(undefined),
        parseHookInput: (nativeJson, nativeEventName) => normalizeNativeHookEvent({ runner: "cowork", capabilities: COWORK_CAPABILITIES, nativeJson, nativeEventName,
            buildAction: ({ raw, phase }) => buildStandardAction({ raw, phase, nativeEventName }) }),
        renderSettingsFragment: () => { throw new Error("Cowork uses an uploaded plugin: run interlinked cowork package --output <directory>"); },
        encodeDecision,
    };
}
