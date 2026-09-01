// ===========================================
// GitHub Copilot CLI adapter
// ===========================================
// Native events (camelCase): sessionStart, sessionEnd, userPromptSubmitted,
// preToolUse, postToolUse, errorOccurred. Payload shape based on Copilot CLI
// docs as of 2026-04-23. Decision protocol: PreToolUse reads a stdout JSON
// `permissionDecision`; process exit codes are not the decision channel.
// "ask" semantics are limited, so Interlinked collapses it to deny.

import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import type { JsonObject } from "../../lib/json-types.js";
import { buildHookCommand } from "./hook-command.js";
import { buildStandardAction, normalizeNativeHookEvent } from "./normalization.js";
import {
	COPILOT_CLI_CAPABILITIES,
	installedEventNames,
} from "./provider-capabilities.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

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
						toolResponseKeys: ["toolResponse", "tool_response"],
						toolErrorKeys: ["toolError", "tool_error"],
						promptKeys: ["prompt", "userPrompt"],
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

		renderSettingsFragment(binaryPath, _scope): SettingsFragment {
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				// Missing-runtime policy: only Copilot's tool gate fails closed.
				const hookCommand = buildHookCommand(
					binaryPath,
					"copilot-cli",
					event,
					event === "preToolUse" ? "fail_closed" : "warn_open",
				);
				hooks[event] = [{ type: "command", bash: hookCommand }];
			}
			return {
				path: ".github/hooks/hooks.json",
				fragment: { version: 1, hooks },
				mergeStrategy: "array-append",
			};
		},

		encodeDecision(decision, _event): AdapterOutput {
			const stderr = (decision.warnings ?? []).join("\n");
			if (decision.decision === "block") {
				// Append resolved targets to the deny reason when present so
				// the human sees the concrete file/URL/branch instead of just
				// the rule description.
				const baseReason =
					decision.reason ??
					"Blocked by the interlinked harness, but no reason was attached — likely a harness " +
						"bug; re-run, or run `interlinked harness restart`, then report it.";
				const reason = formatAskReasonWithTargets(baseReason, decision.resolved_targets);
				return copilotDeny(reason, stderr);
			}
			if (decision.decision === "ask") {
				// Copilot has no "ask" primitive — collapse to deny so destructive
				// rules (curl DELETE, GraphQL mutations, etc.) actually require
				// user intervention rather than silently proceeding. This mirrors
				// the .mjs `formatCopilotResponse` path in
				// hook-template-chunks/provider-responses.ts. Surfacing as exit 0
				// + stderr note (the previous behaviour) let an ask rule's match
				// proceed unchecked, defeating the purpose of the gate.
				//
				// Resolved targets are appended to the deny reason so the human
				// hitting the prompt sees what would have happened.
				const baseReason = decision.reason ?? "Confirmation required";
				const reason = formatAskReasonWithTargets(baseReason, decision.resolved_targets);
				return copilotDeny(reason, stderr);
			}
			// allow
			let out = stderr;
			if (decision.additional_context) {
				out = out ? `${out}\n${decision.additional_context}` : decision.additional_context;
			}
			return { stderr: out || undefined, exit_code: 0 };
		},
	};
}

function copilotActionRaw(raw: JsonObject): JsonObject {
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

function copilotDeny(reason: string, stderr: string): AdapterOutput {
	return {
		stdout: JSON.stringify({
			permissionDecision: "deny",
			permissionDecisionReason: reason,
		}),
		stderr: stderr || undefined,
		exit_code: 0,
	};
}
