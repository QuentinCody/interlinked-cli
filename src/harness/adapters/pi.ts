// Pi extension adapter. Pi auto-loads project extensions from
// `.pi/extensions/` and user extensions from `~/.pi/agent/extensions/`.

import type { ClassifierOverrides } from "../tool-class-classifier.js";
import { adapterToolClassifier } from "./adapter-tool-class.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import {
	encodeProviderBridgeDecision,
	renderProviderBridgePrelude,
} from "./provider-bridge-source.js";
import { installedEventNames, PI_CAPABILITIES } from "./provider-capabilities.js";
import type { RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = installedEventNames(PI_CAPABILITIES);
const PROJECT_EXTENSION_PATH = ".pi/extensions/interlinked.js";
const USER_EXTENSION_PATH = "~/.pi/agent/extensions/interlinked.js";

const PI_EXTENSION_HELPERS = `import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

function piPayload(event, ctx, extra = {}) {
    return {
        session_id: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        workspace_root: ctx.cwd,
        model: ctx.model && ctx.model.id,
        ...extra,
    };
}

function piDecisionReason(decision) {
    return interlinkedFeedback(decision) || "Blocked by Interlinked";
}

async function piDecisionAllowed(decision, ctx) {
    if (decision.decision === "block") return false;
    if (decision.decision !== "ask") return true;
    if (!ctx.hasUI) return false;
    return ctx.ui.confirm("Interlinked approval required", piDecisionReason(decision));
}

function piNotifyFeedback(decision, ctx) {
    const feedback = interlinkedFeedback(decision);
    if (feedback && ctx.hasUI) ctx.ui.notify(feedback, "warning");
}

function piBlockedBashResult(reason) {
    return {
        result: {
            output: reason,
            exitCode: 1,
            cancelled: false,
            truncated: false,
        },
    };
}
`;

const PI_EXTENSION_INPUT_AND_TOOL = `    pi.on("input", async (event, ctx) => {
        const decision = await observeInterlinked("input", piPayload(event, ctx, {
            prompt: event.text,
            input_source: event.source,
        }));
        if (!decision) return { action: "continue" };
        if (!(await piDecisionAllowed(decision, ctx))) {
            if (ctx.hasUI) ctx.ui.notify(piDecisionReason(decision), "error");
            return { action: "handled" };
        }
        piNotifyFeedback(decision, ctx);
        if (decision.updated_input && typeof decision.updated_input.text === "string") {
            return { action: "transform", text: decision.updated_input.text, images: event.images };
        }
        return { action: "continue" };
    });

    pi.on("tool_call", async (event, ctx) => {
        let decision;
        try {
            decision = await invokeInterlinked("tool_call", piPayload(event, ctx, {
                tool_use_id: event.toolCallId,
                tool_name: event.toolName,
                tool_input: event.input,
            }));
        } catch (error) {
            return { block: true, reason: "Interlinked tool gate unavailable: " + interlinkedErrorText(error) };
        }
        if (!(await piDecisionAllowed(decision, ctx))) {
            return { block: true, reason: piDecisionReason(decision) };
        }
        if (decision.updated_input && event.input && typeof event.input === "object") {
            Object.assign(event.input, decision.updated_input);
        }
        piNotifyFeedback(decision, ctx);
        return undefined;
    });

    pi.on("tool_result", async (event, ctx) => {
        const decision = await observeInterlinked("tool_result", piPayload(event, ctx, {
            tool_use_id: event.toolCallId,
            tool_name: event.toolName,
            tool_input: event.input,
            tool_response: event.content,
            tool_error: event.isError ? "tool returned an error" : undefined,
        }));
        if (!decision) return undefined;
        const feedback = interlinkedFeedback(decision);
        if (!feedback) return undefined;
        return {
            content: [...event.content, { type: "text", text: "[interlinked]\\n" + feedback }],
        };
    });
`;

const PI_EXTENSION_USER_BASH = `    pi.on("user_bash", async (event, ctx) => {
        let decision;
        try {
            decision = await invokeInterlinked("user_bash", piPayload(event, ctx, {
                cwd: event.cwd,
                tool_name: "Bash",
                tool_input: { command: event.command },
            }));
        } catch (error) {
            return piBlockedBashResult("Interlinked shell gate unavailable: " + interlinkedErrorText(error));
        }
        if (!(await piDecisionAllowed(decision, ctx))) {
            return piBlockedBashResult(piDecisionReason(decision));
        }
        if (decision.updated_input && typeof decision.updated_input.command === "string") {
            try {
                const local = createLocalBashOperations();
                const rewrittenCommand = decision.updated_input.command;
                piNotifyFeedback(decision, ctx);
                return {
                    operations: {
                        exec(_command, cwd, options) {
                            return local.exec(rewrittenCommand, cwd, options);
                        },
                    },
                };
            } catch (error) {
                return piBlockedBashResult("Interlinked could not apply the safe shell rewrite: " + interlinkedErrorText(error));
            }
        }
        piNotifyFeedback(decision, ctx);
        return undefined;
    });
`;

const PI_EXTENSION_LIFECYCLE = `    pi.on("before_agent_start", async (event, ctx) => {
        const decision = await observeInterlinked("before_agent_start", piPayload(event, ctx, {
            prompt: event.prompt,
        }));
        if (!decision) return undefined;
        const feedback = interlinkedFeedback(decision);
        if (!feedback) return undefined;
        return { message: { customType: "interlinked", content: feedback, display: true } };
    });

    for (const eventName of [
        "session_start",
        "session_shutdown",
        "agent_start",
        "agent_end",
        "agent_settled",
        "session_before_compact",
        "session_compact",
        "session_compact_failed",
    ]) {
        pi.on(eventName, async (event, ctx) => {
            await observeInterlinked(eventName, piPayload(event, ctx, { provider_event: event }));
        });
    }
`;

interface PiAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createPiAdapter(opts: PiAdapterOptions = {}): RunnerAdapter {
	return {
		id: "pi",
		label: "Pi",
		experimental: true,
		capabilities: PI_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(
				env.PI_CODING_AGENT ||
					env.PI_SESSION_ID ||
					env.PI_AGENT_VERSION ||
					env.INTERLINKED_CLIENT === "pi",
			);
		},

		parseHookInput(nativeJson, nativeEventName) {
			return normalizeNativeHookEvent({
				runner: "pi",
				capabilities: PI_CAPABILITIES,
				nativeEventName,
				nativeJson,
				aliases: {
					sessionId: ["session_id", "sessionId"],
					toolUseId: ["tool_use_id", "toolCallId"],
				},
				buildAction: ({ raw, phase }) =>
					buildStandardAction({
						raw,
						phase,
						nativeEventName,
						toolNameKeys: ["tool_name", "toolName"],
						toolInputKeys: ["tool_input", "input"],
						toolResponseKeys: ["tool_response", "content"],
						promptKeys: ["prompt", "text"],
						...(opts.overrides ? { overrides: opts.overrides } : {}),
					}),
			});
		},

		classifyToolClass: adapterToolClassifier(opts.overrides),

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			return {
				path: scope === "user" ? USER_EXTENSION_PATH : PROJECT_EXTENSION_PATH,
				fragment: {},
				mergeStrategy: "deep-merge",
				fileContent: renderPiBridgeSource(binaryPath),
			};
		},

		encodeDecision: encodeProviderBridgeDecision,
	};
}

export function renderPiBridgeSource(binaryPath: string): string {
	return [
		renderProviderBridgePrelude("pi", binaryPath),
		PI_EXTENSION_HELPERS,
		"export default function interlinkedPiExtension(pi) {",
		PI_EXTENSION_INPUT_AND_TOOL,
		PI_EXTENSION_USER_BASH,
		PI_EXTENSION_LIFECYCLE,
		"}",
		"",
	].join("\n");
}
