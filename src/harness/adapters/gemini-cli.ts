// ===========================================
// Gemini CLI adapter (experimental)
// ===========================================
// Gemini CLI is pre-1.0 as of 2026-04-23. Native events observed:
//   BeforeTool, AfterTool, AfterModel, PreCompress
// Payload shape is provisional. When Gemini CLI ships 1.0 this adapter needs
// a revisit — see docs/design/cli-hook-normalization.md.

import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import { buildHookCommand } from "./hook-command.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import { GEMINI_CLI_CAPABILITIES, installedEventNames } from "./provider-capabilities.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

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

		classifyToolClass(toolName, toolInput) {
			return classifyFromToolName(
				toolName,
				toolInput,
				opts.overrides ? { overrides: opts.overrides } : {},
			);
		},

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
				hooks[event] = [{ command: hookCommand }];
			}
			return { path, fragment: { hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision(decision, event): AdapterOutput {
			// Gemini CLI's decision protocol is provisional; match Cursor-style
			// stdout JSON until the native shape is settled.
			const stderr = (decision.warnings ?? []).join("\n");
			if (decision.decision === "block") {
				return {
					stdout: JSON.stringify({
						allow: false,
						reason:
							decision.reason ??
							"Blocked by the interlinked harness, but no reason was attached — likely a " +
								"harness bug; re-run, or run `interlinked harness restart`, then report it.",
					}),
					stderr: stderr || undefined,
					exit_code: 2,
				};
			}
			if (decision.decision === "ask") {
				return {
					stdout: JSON.stringify({
						ask: true,
						reason: decision.reason ?? "Confirmation required",
					}),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			if (event.runner_native_event === "AfterTool") {
				// Gemini parses exit-0 stdout as JSON and its hook contract requires
				// a valid JSON document even for a no-op. Therefore true zero-byte
				// silence is not portable here; emit the smallest valid no-op (`{}`)
				// instead of a redundant allow envelope on every clean tool result.
				return {
					stdout: "{}",
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			return {
				stdout: JSON.stringify({ allow: true }),
				stderr: stderr || undefined,
				exit_code: 0,
			};
		},
	};
}
