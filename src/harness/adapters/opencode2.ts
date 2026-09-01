// ===========================================
// OpenCode v2 (opencode2) adapter (as of 2026-08-31)
// ===========================================
// Opencode v2 (`opencode2` binary) does not spawn stdin hook processes.
// Integration is an in-process plugin (`tool.execute.before` / `after`,
// session events) that posts Claude-shaped HarnessEvent JSON to
// `.interlinked/harness.sock`.
//
// This adapter still exists so `install-hooks --runner opencode2` and the
// unified event path stay consistent with the other runners. The plugin
// itself talks to the legacy socket; encodeDecision is used if hook-entry
// is ever invoked with --runner opencode2.

import { mapOpencode2Tool } from "../../lib/opencode-tool-map.js";
import { isOpenCodeV2Env, opencodeUserPluginRelPath } from "../../lib/opencode-runtime.js";
import { buildOpencodePluginSource, OPENCODE_PLUGIN_FILENAME } from "../../lib/opencode-plugin-source.js";
import type { JsonObject } from "../../lib/json-types.js";
import {
	type ClassifierOverrides,
	classifyFromToolName,
} from "../tool-class-classifier.js";
import type { UnifiedPhase } from "../unified-event.js";
import { makeEventId } from "../unified-event.js";
import { installedEventNames, OPENCODE2_CAPABILITIES } from "./provider-capabilities.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = installedEventNames(OPENCODE2_CAPABILITIES);

const PHASE_MAP: Record<string, UnifiedPhase> = {
	"tool.execute.before": "pre-tool",
	"tool.execute.after": "post-tool",
	"session.created": "session-start",
	"session.deleted": "session-end",
	"session.idle": "stop",
	PreToolUse: "pre-tool",
	PostToolUse: "post-tool",
	SessionStart: "session-start",
	SessionEnd: "session-end",
	Stop: "stop",
};

export interface OpencodeAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createOpencode2Adapter(opts: OpencodeAdapterOptions = {}): RunnerAdapter {
	return {
		id: "opencode2",
		label: "OpenCode v2",
		experimental: true,
		capabilities: OPENCODE2_CAPABILITIES,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return isOpenCodeV2Env(env);
		},

		parseHookInput(nativeJson, nativeEventName) {
			const raw = isObject(nativeJson) ? nativeJson : {};
			const phase = PHASE_MAP[nativeEventName] ?? "other";
			const session_id =
				readString(raw.session_id) ?? readString(raw.sessionID) ?? readString(raw.sessionId) ?? "unknown";
			const cwd = readString(raw.cwd) ?? process.cwd();
			const ts = new Date().toISOString();
			const tool = readString(raw.tool) ?? readString(raw.tool_name) ?? "";
			const args = raw.args ?? raw.tool_input ?? {};
			const mapped = tool ? mapOpencode2Tool(tool, args) : null;
			const toolName = mapped?.tool_name ?? tool;
			const toolInput = mapped?.tool_input ?? args;
			const action =
				phase === "pre-tool" || phase === "post-tool"
					? {
							kind: "tool_call" as const,
							tool_name: toolName,
							tool_class: classifyFromToolName(
								toolName,
								toolInput,
								opts.overrides ? { overrides: opts.overrides } : {},
							),
							tool_input: toolInput,
							tool_input_redacted: toolInput,
						}
					: { kind: "other" as const, subkind: nativeEventName, data: raw };

			return {
				schema_version: "1",
				event_id: makeEventId(),
				session_id,
				ts,
				runner: "opencode2",
				runner_native_event: nativeEventName,
				phase,
				action,
				context: { cwd },
				raw,
			};
		},

		classifyToolClass(toolName, toolInput) {
			return classifyFromToolName(
				toolName,
				toolInput,
				opts.overrides ? { overrides: opts.overrides } : {},
			);
		},

		renderSettingsFragment(_binaryPath, scope): SettingsFragment {
			const path =
				scope === "user"
					? opencodeUserPluginRelPath(OPENCODE_PLUGIN_FILENAME)
					: `.opencode/plugins/${OPENCODE_PLUGIN_FILENAME}`;
			return {
				path,
				fragment: {},
				mergeStrategy: "deep-merge",
				fileContent: buildOpencodePluginSource(),
			};
		},

		encodeDecision(decision): AdapterOutput {
			const stderr = (decision.warnings ?? []).join("\n");
			if (decision.decision === "block" || decision.decision === "ask") {
				return {
					stdout: JSON.stringify({
						decision: "block",
						reason: decision.reason ?? "Blocked by Interlinked",
					}),
					stderr: stderr || undefined,
					exit_code: 2,
				};
			}
			const payload: JsonObject = { decision: "allow" };
			if (decision.additional_context) payload.additional_context = decision.additional_context;
			return {
				stdout: JSON.stringify(payload),
				stderr: stderr || undefined,
				exit_code: 0,
			};
		},


	};
}

function isObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
