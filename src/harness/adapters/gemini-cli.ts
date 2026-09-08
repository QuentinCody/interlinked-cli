// ===========================================
// Gemini CLI adapter
// ===========================================
// Uses the documented command-hook contract. Native enforcement remains
// unmeasured until exercised against a versioned Gemini runtime.

import type { ClassifierOverrides } from "../tool-class-classifier.js";
import { adapterToolClassifier } from "./adapter-tool-class.js";
import { buildHookCommand } from "./hook-command.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import { GEMINI_CLI_CAPABILITIES, installedEventNames } from "./provider-capabilities.js";
import { encodeGeminiDecision } from "./provider-decisions.js";
import type { RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = installedEventNames(GEMINI_CLI_CAPABILITIES);

interface GeminiCliAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createGeminiCliAdapter(opts: GeminiCliAdapterOptions = {}): RunnerAdapter {
	return {
		id: "gemini-cli",
		label: "Gemini CLI",
		experimental: true,
		capabilities: GEMINI_CLI_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(env.GEMINI_CLI || env.GEMINI_API_KEY || env.GEMINI_CLI_VERSION);
		},

		parseHookInput(nativeJson, nativeEventName) {
			return normalizeNativeHookEvent({
				runner: "gemini-cli",
				capabilities: GEMINI_CLI_CAPABILITIES,
				nativeEventName,
				nativeJson,
				buildAction: ({ raw, phase }) =>
					buildStandardAction({
						raw,
						phase,
						nativeEventName,
						toolNameKeys: ["tool_name", "toolName"],
						toolInputKeys: ["tool_input", "toolInput", "arguments"],
						toolResponseKeys: ["tool_response", "response"],
						toolErrorKeys: ["tool_error", "error"],
						...(opts.overrides ? { overrides: opts.overrides } : {}),
					}),
			});
		},

		classifyToolClass: adapterToolClassifier(opts.overrides),

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			const path = scope === "user" ? "~/.gemini/settings.json" : ".gemini/settings.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				// Missing-runtime policy: only Gemini's tool gate fails closed.
				const hookCommand = buildHookCommand(
					binaryPath,
					"gemini-cli",
					event,
					event === "BeforeTool" ? "fail_closed" : "warn_open",
				);
				hooks[event] = [{ hooks: [{ type: "command", command: hookCommand }] }];
			}
			return { path, fragment: { hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision: encodeGeminiDecision,
	};
}
