// OpenCode plugin adapter. OpenCode auto-loads project plugins from
// `.opencode/plugins/` and user plugins from `~/.config/opencode/plugins/`.

import {
	type ClassifierOverrides,
	classifyFromToolName,
} from "../tool-class-classifier.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import {
	encodeProviderBridgeDecision,
	renderProviderBridgePrelude,
} from "./provider-bridge-source.js";
import { installedEventNames, OPENCODE_CAPABILITIES } from "./provider-capabilities.js";
import type { RunnerAdapter, SettingsFragment } from "./types.js";
import { isOpenCodeV2Env } from "../../lib/opencode-runtime.js";

const NATIVE_EVENTS = installedEventNames(OPENCODE_CAPABILITIES);
const PROJECT_PLUGIN_PATH = ".opencode/plugins/interlinked.ts";
const USER_PLUGIN_PATH = "~/.config/opencode/plugins/interlinked.ts";

const OPENCODE_PLUGIN_HELPERS = `function openCodePayload(input, directory, worktree, extra = {}) {
    return {
        session_id: input && (input.sessionID || input.sessionId) || "unknown",
        cwd: directory,
        workspace_root: worktree || directory,
        ...extra,
    };
}

function openCodePrompt(parts) {
    if (!Array.isArray(parts)) return "";
    return parts
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\\n");
}

function openCodeSessionId(event) {
    const properties = event && event.properties || {};
    return properties.sessionID || properties.sessionId || properties.info && properties.info.id || "unknown";
}

function openCodeBusEventName(type) {
    const supported = new Set([
        "session.created",
        "session.deleted",
        "session.idle",
        "session.error",
        "session.compacted",
        "permission.updated",
        "permission.replied",
    ]);
    return supported.has(type) ? "event:" + type : undefined;
}

function openCodeDenyReason(decision) {
    const reason = interlinkedFeedback(decision) || "Blocked by Interlinked";
    if (decision.decision === "ask") {
        return reason + "\\n\\nOpenCode cannot open a native confirmation from tool.execute.before; approve the action outside this call, then retry.";
    }
    return reason;
}
`;

const OPENCODE_PLUGIN_TOOL_HOOKS = `        "tool.execute.before": async (input, output) => {
            const decision = await invokeInterlinked("tool.execute.before", openCodePayload(input, directory, worktree, {
                tool_use_id: input.callID,
                tool_name: input.tool,
                tool_input: output.args,
            }));
            if (decision.updated_input && output.args && typeof output.args === "object") {
                Object.assign(output.args, decision.updated_input);
            }
            if (decision.decision === "block" || decision.decision === "ask") {
                throw new Error(openCodeDenyReason(decision));
            }
            const feedback = interlinkedFeedback(decision);
            if (feedback) console.error("[interlinked] " + feedback);
        },
        "tool.execute.after": async (input, output) => {
            const decision = await observeInterlinked("tool.execute.after", openCodePayload(input, directory, worktree, {
                tool_use_id: input.callID,
                tool_name: input.tool,
                tool_input: input.args,
                tool_response: output.output,
                tool_metadata: output.metadata,
            }));
            if (!decision) return;
            const feedback = interlinkedFeedback(decision);
            if (feedback) {
                output.output = String(output.output || "") + "\\n\\n[interlinked]\\n" + feedback;
            }
        },
`;

const OPENCODE_PLUGIN_OTHER_HOOKS = `        "chat.message": async (input, output) => {
            const decision = await observeInterlinked("chat.message", openCodePayload(input, directory, worktree, {
                turn_id: input.messageID || output.message && output.message.id,
                prompt: openCodePrompt(output.parts),
                model: input.model && input.model.modelID,
            }));
            if (!decision) return;
            if (decision.decision === "block" || decision.decision === "ask") {
                throw new Error(openCodeDenyReason(decision));
            }
            const feedback = interlinkedFeedback(decision);
            if (feedback) console.error("[interlinked] " + feedback);
        },
        "experimental.session.compacting": async (input, output) => {
            const decision = await observeInterlinked("experimental.session.compacting", openCodePayload(input, directory, worktree));
            if (!decision) return;
            const feedback = interlinkedFeedback(decision);
            if (feedback) output.context.push(feedback);
        },
        event: async ({ event }) => {
            const eventName = openCodeBusEventName(event && event.type);
            if (!eventName) return;
            await observeInterlinked(eventName, {
                session_id: openCodeSessionId(event),
                cwd: directory,
                workspace_root: worktree || directory,
                provider_event: event,
            });
        },
`;

export interface OpenCodeAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createOpenCodeAdapter(opts: OpenCodeAdapterOptions = {}): RunnerAdapter {
	return {
		id: "opencode",
		label: "OpenCode",
		experimental: true,
		capabilities: OPENCODE_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			if (isOpenCodeV2Env(env)) return false;
			return Boolean(
				env.OPENCODE ||
					env.OPENCODE_CLI ||
					env.OPENCODE_SESSION_ID ||
					env.INTERLINKED_CLIENT === "opencode",
			);
		},

		parseHookInput(nativeJson, nativeEventName) {
			return normalizeNativeHookEvent({
				runner: "opencode",
				capabilities: OPENCODE_CAPABILITIES,
				nativeEventName,
				nativeJson,
				aliases: {
					sessionId: ["session_id", "sessionID", "sessionId"],
					toolUseId: ["tool_use_id", "callID", "callId"],
					turnId: ["turn_id", "messageID", "messageId"],
				},
				buildAction: ({ raw, phase }) =>
					buildStandardAction({
						raw,
						phase,
						nativeEventName,
						toolNameKeys: ["tool_name", "tool"],
						toolInputKeys: ["tool_input", "args", "input"],
						toolResponseKeys: ["tool_response", "output"],
						promptKeys: ["prompt", "text"],
						...(opts.overrides ? { overrides: opts.overrides } : {}),
					}),
			});
		},

		classifyToolClass(toolName, toolInput) {
			return classifyFromToolName(
				toolName,
				toolInput,
				opts.overrides ? { overrides: opts.overrides } : {},
			);
		},

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			return {
				path: scope === "user" ? USER_PLUGIN_PATH : PROJECT_PLUGIN_PATH,
				fragment: {},
				mergeStrategy: "deep-merge",
				fileContent: renderOpenCodeBridgeSource(binaryPath),
			};
		},

		encodeDecision: encodeProviderBridgeDecision,
	};
}

export function renderOpenCodeBridgeSource(binaryPath: string): string {
	return [
		renderProviderBridgePrelude("opencode", binaryPath),
		OPENCODE_PLUGIN_HELPERS,
		"function interlinkedIsOpenCodeV2() {",
		'    const env = typeof process === "undefined" ? {} : process.env;',
		'    return env.INTERLINKED_CLIENT === "opencode2" || Boolean(env.OPENCODE2);',
		"}",
		"export const InterlinkedPlugin = async ({ directory, worktree }) => {",
		"    if (interlinkedIsOpenCodeV2()) return {};",
		"    return {",
		OPENCODE_PLUGIN_TOOL_HOOKS,
		OPENCODE_PLUGIN_OTHER_HOOKS,
		"    };",
		"};",
		// v2's loader requires default.{id,setup}. No-op so this file can sit
		// next to interlinked-opencode2.ts without crashing opencode2 or double-gating.
		'export default { id: "interlinked", setup: async () => {} };',
		"",
	].join("\n");
}
