import { CLAUDE_CODE_CAPABILITIES } from "../../harness/adapters/provider-capabilities.js";
import { CLAUDE_CODE_WRITE_TOOLS } from "../write-tool-registry.js";
import { DEVICE_BASH } from "./native.js";

const POST_TOOL_MUTATIONS = `^(?:${[...CLAUDE_CODE_WRITE_TOOLS, DEVICE_BASH].join("|")})$`;

export const COWORK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const;
export const COWORK_PROBE_EVENTS = [...new Set([...COWORK_EVENTS, ...CLAUDE_CODE_CAPABILITIES.events.map(event => event.name)])];
const OBSERVED = new Set(["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "MessageDisplay", "PostToolBatch", "PostToolUseFailure", "TaskCreated", "PermissionRequest", "Notification", "TaskCompleted", "SubagentStart", "SubagentStop"]);

/** A dated native observation never certifies the user's current installation. */
export function coworkCapabilities() {
    return {
        provider: "cowork", experimental: true, desktopChatHooks: "unsupported", currentInstallation: "unmeasured",
        priorProbe: { date: "2026-09-08", desktopVersion: "1.49585.0 (41ad1d)", execution: "cloud", source: "scratch/2026-09-08-cowork-probe/REPORT.md" },
        extendedProbe: { source: "docs/cowork.md", records: 115, distinctEvents: 12, hookCrash: "fail_open_observed", hookTimeout: "fail_open_observed", ask: "native_prompt_observed", rewriteInput: "rewritten_file_verified" },
        events: CLAUDE_CODE_CAPABILITIES.events.map(event => ({
            event: event.name, claudeCode: { installed: event.install, declaredControls: event.controls ?? [] },
            cowork: { installed: COWORK_EVENTS.some(name => name === event.name), observation: OBSERVED.has(event.name) ? "observed_in_prior_probe" : "unmeasured",
                measuredControls: event.name === "PreToolUse" ? ["deny", "ask", "rewrite_input"] : event.name === "PostToolUse" ? ["context"] : [] },
        })),
        surfaces: ["cloud_write", "cloud_bash", "device_bash"].map(surface => ({ surface, priorProbe: "deny_effect_verified", currentInstallation: "unmeasured" })),
        unmeasured: ["browser", "computer_use", "external_connector_mutations", "device_stage_commit", "replace_result", "restart", "local_mode", "public_bridge_reachability"],
        guardLimitations: ["Launcher converts child failure/missing Node/internal deadline to deny. Provider termination of the launcher or missing hook registration remains fail-open.", "Host input rewrites are conservatively denied until cross-runtime path translation is certified."],
    };
}

export function coworkHookSettings(runtimePath = '${CLAUDE_PLUGIN_ROOT}/scripts/cowork-hook.js', probe = false): Record<string, unknown> {
    const events: readonly string[] = probe ? COWORK_PROBE_EVENTS : COWORK_EVENTS;
    const hooks = Object.fromEntries(events.map(event => [event, [{ matcher: !probe && event === "PostToolUse" ? POST_TOOL_MUTATIONS : "", hooks: [{ type: "command",
        command: probe ? `node "${runtimePath}" --event ${event}` : `sh "${runtimePath.replace(/\.js$/, ".sh")}" ${event}`, timeout: 15,
    }] }]]));
    return { hooks };
}
