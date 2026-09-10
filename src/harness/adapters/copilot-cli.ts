// ===========================================
// GitHub Copilot CLI adapter
// ===========================================
// CLI command hooks use event-specific JSON decisions. Hosted Copilot jobs
// require a separate capability profile.

import { encodeCopilotDecision } from "./provider-decisions.js";
import { isJsonObject } from "../../lib/json-types.js";
import type { ClassifierOverrides } from "../tool-class-classifier.js";
import { adapterToolClassifier } from "./adapter-tool-class.js";
import type { JsonObject } from "../../lib/json-types.js";
import { buildHookCommand } from "./hook-command.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import {
	COPILOT_CLI_CAPABILITIES,
	installedEventNames,
} from "./provider-capabilities.js";
import type { RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = installedEventNames(COPILOT_CLI_CAPABILITIES);

interface CopilotCliAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createCopilotCliAdapter(opts: CopilotCliAdapterOptions = {}): RunnerAdapter {
	return {
		id: "copilot-cli",
		label: "GitHub Copilot CLI",
		capabilities: COPILOT_CLI_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(
				env.GH_COPILOT_CLI ||
					env.COPILOT_CLI ||
					env.GITHUB_COPILOT_CLI ||
					env.GH_COPILOT_VERSION,
			);
		},

		parseHookInput(nativeJson, nativeEventName) {
			return normalizeNativeHookEvent({
				runner: "copilot-cli",
				capabilities: COPILOT_CLI_CAPABILITIES,
				nativeEventName,
				nativeJson,
				buildAction: ({ raw, phase }) =>
					buildStandardAction({
						raw: copilotActionRaw(raw),
						phase,
						nativeEventName,
						toolNameKeys: ["toolName", "tool_name"],
						toolInputKeys: ["__interlinkedToolArgs", "toolInput", "tool_input"],
						toolResponseKeys: ["toolResult", "toolResponse", "tool_response"],
						toolErrorKeys: ["error", "toolError", "tool_error"],
						promptKeys: ["prompt", "userPrompt"],
						...(opts.overrides ? { overrides: opts.overrides } : {}),
					}),
			});
		},

		classifyToolClass: adapterToolClassifier(opts.overrides),

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			const hooks: Record<string, unknown[]> = {};
				for (const capability of COPILOT_CLI_CAPABILITIES.events.filter(item => item.install)) {
					const event = capability.name;
				// Missing-runtime policy: only Copilot's tool gate fails closed.
				const hookCommand = buildHookCommand(
					binaryPath,
					"copilot-cli",
					event,
						capability.missing_runtime,
				);
				hooks[event] = [{ type: "command", bash: hookCommand }];
			}
			return {
				path: scope === "user" ? "~/.copilot/hooks/interlinked.json" : ".github/hooks/hooks.json",
				fragment: { version: 1, hooks },
				mergeStrategy: "array-append",
			};
		},

		encodeDecision: encodeCopilotDecision,
	};
}

function copilotActionRaw(raw: JsonObject): JsonObject {
	if (isJsonObject(raw.toolArgs)) return { ...raw, __interlinkedToolArgs: raw.toolArgs };
	if (typeof raw.toolArgs !== "string") return raw;
	try {
		const parsed: unknown = JSON.parse(raw.toolArgs);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { ...raw, __interlinkedToolArgs: parsed };
		}
	} catch {
		// A malformed native payload must not fall back to a conflicting legacy
		// field. Classify it with an empty input and let the safe unknown path win.
	}
	return { ...raw, __interlinkedToolArgs: {} };
}
