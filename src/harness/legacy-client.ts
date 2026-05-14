// ===========================================
// Legacy harness socket client
// ===========================================
// Compatibility bridge for the repo-scoped `.interlinked/harness.sock`
// daemon. That daemon is implemented by `server.ts` and speaks raw
// newline-delimited HarnessEvent JSON, not the framed RPC envelope used by
// session-daemon.ts.

import { basename } from "node:path";
import { createConnection, type Socket } from "node:net";
import type { JsonObject } from "../lib/json-types.js";
import type { AgentSource, HarnessDecision, HarnessEvent } from "./types.js";
import type { UnifiedHookEvent } from "./unified-event.js";

export const LEGACY_HARNESS_SOCKET_BASENAME = "harness.sock";
export const DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS = 5000;

const LEGACY_NATIVE_EVENTS = new Set<HarnessEvent["hook_event"]>([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"Stop",
	"SubagentStart",
	"SubagentStop",
	"Notification",
	"PreCompact",
	"TaskCompleted",
	"TeammateIdle",
	"PermissionRequest",
	"BeforeTool",
	"AfterTool",
	"AfterModel",
	"PreCompress",
]);

export interface LegacyHarnessCallOptions {
	timeout_ms?: number;
}

export function isLegacyHarnessSocket(socketPath: string): boolean {
	return basename(socketPath) === LEGACY_HARNESS_SOCKET_BASENAME;
}

export function callLegacyHarness(
	socketPath: string,
	event: UnifiedHookEvent,
	opts: LegacyHarnessCallOptions = {},
): Promise<HarnessDecision> {
	const timeoutMs = opts.timeout_ms ?? DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS;
	const payload = toLegacyHarnessEvent(event);
	return new Promise((resolve, reject) => {
		let socket: Socket | null = null;
		let settled = false;
		let buffer = "";
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (socket) socket.destroy();
			fn();
		};
		const timer = setTimeout(() => {
			finish(() => reject(new Error("timeout")));
		}, timeoutMs);

		socket = createConnection(socketPath, () => {
			(socket as Socket).write(`${JSON.stringify(payload)}\n`);
		});

		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const newlineIdx = buffer.indexOf("\n");
			if (newlineIdx === -1) return;
			const line = buffer.slice(0, newlineIdx);
			try {
				const parsed = JSON.parse(line) as HarnessDecision;
				finish(() => resolve(parsed));
			} catch (err) {
				finish(() =>
					reject(
						err instanceof Error
							? err
							: new Error(`invalid legacy harness response: ${String(err)}`),
					),
				);
			}
		});

		socket.on("error", (err: Error) => {
			finish(() => reject(err));
		});
		socket.on("close", () => {
			if (!settled) finish(() => reject(new Error("socket closed")));
		});
	});
}

export function toLegacyHarnessEvent(event: UnifiedHookEvent): HarnessEvent {
	const raw = isJsonObject(event.raw) ? event.raw : {};
	const out: HarnessEvent = {
		hook_event: legacyHookEventName(event),
		session_id: event.session_id,
		agent_source: mapAgentSource(event.runner),
		cwd: event.context.cwd,
		timestamp: event.ts,
	};

	const agentName = event.context.agent?.id ?? readString(raw.agent_name);
	if (agentName) out.agent_name = agentName;
	// Recursion guard sentinel — copied through explicitly because the legacy
	// converter only forwards known fields. Without this, the framed adapter
	// path strips the sentinel before `server.ts` can see it. Plan §2.5.
	if (event.metacoder_subprocess === true) out.metacoder_subprocess = true;
	copyString(raw, out, "model");
	copyString(raw, out, "transcript_path");
	copyString(raw, out, "tool_use_id");
	copyString(raw, out, "parent_agent");
	copyString(raw, out, "subagent_id");
	copyString(raw, out, "agent_type");
	const filesModified = readStringArray(raw.files_modified);
	if (filesModified) out.files_modified = filesModified;

	const action = event.action;
	switch (action.kind) {
		case "tool_call":
			out.tool_name = legacyToolName(event, raw, action.tool_name);
			out.tool_input = asJsonObject(action.tool_input) ?? {};
			if (action.tool_response !== undefined) out.tool_response = action.tool_response;
			break;
		case "shell_command":
			out.tool_name = "Bash";
			out.tool_input = compactJson({
				command: action.command,
				cwd: action.cwd,
			});
			break;
		case "file_operation":
			out.tool_name = fileOpToToolName(action.operation);
			out.tool_input = fileOpToToolInput(action);
			break;
		case "user_prompt":
			out.prompt = action.text;
			break;
		case "session_lifecycle":
		case "other":
			break;
	}

	if (out.tool_input === undefined) {
		const rawToolInput = asJsonObject(raw.tool_input) ?? asJsonObject(raw.toolInput);
		if (rawToolInput) out.tool_input = rawToolInput;
	}
	if (out.tool_response === undefined && raw.tool_response !== undefined) {
		out.tool_response = raw.tool_response;
	}
	if (out.tool_response === undefined && raw.toolResponse !== undefined) {
		out.tool_response = raw.toolResponse;
	}
	if (out.prompt === undefined) {
		const prompt = readString(raw.prompt) ?? readString(raw.message) ?? readString(raw.userPrompt);
		if (prompt) out.prompt = prompt;
	}

	return out;
}

function legacyHookEventName(event: UnifiedHookEvent): HarnessEvent["hook_event"] {
	const native = event.runner_native_event;
	if (LEGACY_NATIVE_EVENTS.has(native)) return native;
	switch (event.phase) {
		case "pre-tool":
			return "PreToolUse";
		case "post-tool":
			return "PostToolUse";
		case "session-start":
			return "SessionStart";
		case "session-end":
			return "SessionEnd";
		case "user-prompt":
			return "UserPromptSubmit";
		case "pre-compact":
			return "PreCompact";
		case "stop":
			return "Stop";
		case "subagent-start":
			return "SubagentStart";
		case "subagent-stop":
			return "SubagentStop";
		default:
			return native;
	}
}

function mapAgentSource(runner: UnifiedHookEvent["runner"]): AgentSource {
	switch (runner) {
		case "claude-code":
			return "claude";
		case "copilot-cli":
			return "copilot";
		case "codex":
			return "codex";
		case "gemini-cli":
			return "gemini";
		case "cursor":
			return "cursor";
		default:
			return "claude";
	}
}

function legacyToolName(
	event: UnifiedHookEvent,
	raw: JsonObject,
	normalizedToolName: string,
): string {
	const rawTool =
		readString(raw.tool_name) ?? readString(raw.toolName) ?? readString(raw.name);
	if (rawTool) return rawTool;
	if (event.runner === "claude-code" || event.runner === "codex") {
		return claudeStyleToolName(normalizedToolName);
	}
	return normalizedToolName;
}

function claudeStyleToolName(toolName: string): string {
	switch (toolName) {
		case "edit":
			return "Edit";
		case "write":
			return "Write";
		case "multi_edit":
			return "MultiEdit";
		case "read":
			return "Read";
		case "bash":
			return "Bash";
		case "grep":
			return "Grep";
		case "glob":
			return "Glob";
		case "ls":
			return "LS";
		case "notebook_edit":
			return "NotebookEdit";
		case "web_fetch":
			return "WebFetch";
		case "web_search":
			return "WebSearch";
		case "todo_write":
			return "TodoWrite";
		case "task":
			return "Task";
		default:
			return toolName;
	}
}

function fileOpToToolName(op: "read" | "write" | "edit" | "delete"): string {
	switch (op) {
		case "read":
			return "Read";
		case "write":
			return "Write";
		case "edit":
			return "Edit";
		case "delete":
			return "Bash";
	}
}

function fileOpToToolInput(action: {
	operation: "read" | "write" | "edit" | "delete";
	path: string;
	old_string?: string;
	new_string?: string;
	content?: string;
}): JsonObject {
	if (action.operation === "delete") {
		return { command: `rm ${action.path}` };
	}
	return compactJson({
		file_path: action.path,
		old_string: action.old_string,
		new_string: action.new_string,
		content: action.content,
	});
}

function copyString(
	raw: JsonObject,
	out: HarnessEvent,
	key:
		| "model"
		| "transcript_path"
		| "tool_use_id"
		| "parent_agent"
		| "subagent_id"
		| "agent_type",
): void {
	const value = raw[key];
	if (typeof value !== "string") return;
	switch (key) {
		case "model":
			out.model = value;
			return;
		case "transcript_path":
			out.transcript_path = value;
			return;
		case "tool_use_id":
			out.tool_use_id = value;
			return;
		case "parent_agent":
			out.parent_agent = value;
			return;
		case "subagent_id":
			out.subagent_id = value;
			return;
		case "agent_type":
			out.agent_type = value;
			return;
	}
}

function compactJson(value: Record<string, unknown>): JsonObject {
	const out: JsonObject = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) out[key] = item;
	}
	return out;
}

function asJsonObject(value: unknown): JsonObject | null {
	return isJsonObject(value) ? value : null;
}

function isJsonObject(value: unknown): value is JsonObject {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const strings = value.filter((item): item is string => typeof item === "string");
	return strings.length > 0 ? strings : null;
}
