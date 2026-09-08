import type { RunnerAdapter, SettingsFragment } from "./types.js";
import { ADDITIONAL_CLIENT_CAPABILITIES, type AdditionalClientId } from "./additional-client-capabilities.js";
import { additionalClientInput } from "./additional-client-input.js";
import { encodeAdditionalClientDecision } from "./additional-client-decisions.js";
import { adapterToolClassifier } from "./adapter-tool-class.js";
import { buildHookCommand } from "./hook-command.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import { installedEventNames } from "./provider-capabilities.js";
import type { UnifiedHookEvent } from "../unified-event.js";

const LABELS: Record<AdditionalClientId, string> = { "factory-droid": "Factory Droid", windsurf: "Windsurf Cascade", antigravity: "Google Antigravity", crush: "Crush" };
const USER_PATHS: Record<AdditionalClientId, string> = { "factory-droid": "~/.factory/hooks.json", windsurf: "~/.codeium/windsurf/hooks.json", antigravity: "~/.gemini/config/hooks.json", crush: "~/.config/crush/crush.json" };

function renderAdditionalSettings(id: AdditionalClientId, binaryPath: string, scope: "user" | "project" | "local"): SettingsFragment {
    if (binaryPath.endsWith("interlinked-activity.mjs")) throw new Error("Experimental client adapters require a built hook-entry runtime; run npm run build first.");
    const capabilities = ADDITIONAL_CLIENT_CAPABILITIES[id];
    const hooks: Record<string, unknown[]> = {};
    for (const event of capabilities.events.filter(event => event.install)) {
        const command = buildHookCommand(binaryPath, id, event.name, event.missing_runtime);
        const handler = { type: "command", command };
        if (id === "windsurf" || id === "crush") hooks[event.name] = [{ command }];
        else if (id === "antigravity" && !event.name.endsWith("ToolUse")) hooks[event.name] = [handler];
        else hooks[event.name] = [{ matcher: event.phase === "post-tool" ? postMatcher(id) : "", hooks: [handler] }];
    }
    const fragments = { "factory-droid": hooks, windsurf: { hooks }, antigravity: { interlinked: hooks }, crush: { hooks } };
    return { path: scope === "user" ? USER_PATHS[id] : capabilities.project_hook_path, fragment: fragments[id], mergeStrategy: "array-append" };
}

function postMatcher(id: AdditionalClientId): string {
    if (id === "factory-droid") return "Execute|Create|Edit|ApplyPatch|mcp__.*";
    return "run_command|write_to_file|replace_file_content|multi_replace_file_content|mcp_.*";
}

/** Explicit opt-in via install-hooks; documentation conformance is not native certification. */
export function createAdditionalClientAdapter(id: AdditionalClientId): RunnerAdapter {
    const capabilities = ADDITIONAL_CLIENT_CAPABILITIES[id];
    return {
        id, label: LABELS[id], experimental: true, installByDefault: false, capabilities, nativeEventNames: installedEventNames(capabilities),
        detectFromEnv: () => false,
        classifyToolClass: adapterToolClassifier(undefined),
        parseHookInput: (input, name) => parseAdditionalInput(id, input, name),
        renderSettingsFragment: (binary, scope) => renderAdditionalSettings(id, binary, scope),
        encodeDecision: (decision, event) => encodeAdditionalClientDecision(id, decision, event),
    };
}

function parseAdditionalInput(id: AdditionalClientId, input: unknown, name: string): UnifiedHookEvent {
    const event = normalizeNativeHookEvent({ runner: id, capabilities: ADDITIONAL_CLIENT_CAPABILITIES[id], nativeEventName: name, nativeJson: additionalClientInput(id, input, name), buildAction: ({ raw, phase }) => buildStandardAction({ raw, phase, nativeEventName: name }) });
    event.raw = input;
    return event;
}
