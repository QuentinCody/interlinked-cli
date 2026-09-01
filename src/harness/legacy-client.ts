// ===========================================
// Legacy harness socket client
// ===========================================
// Compatibility bridge for the repo-scoped `.interlinked/harness.sock`
// daemon. That daemon is implemented by `server.ts` and speaks raw
// newline-delimited HarnessEvent JSON, not the framed RPC envelope used by
// session-daemon.ts.

import { createConnection, type Socket } from "node:net";
import { basename } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { JsonObject } from "../lib/json-types.js";
import type { AgentSource, HarnessDecision, HarnessEvent, ResolvedTarget } from "./types.js";
import type { UnifiedAction, UnifiedHookEvent } from "./unified-event.js";
import {
	asJsonObject,
	compactJson,
	readString,
	readStringArray,
} from "./legacy-client-json.js";

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
	"PostCompact",
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

const RESOLVED_TARGET_KINDS = new Set<ResolvedTarget["kind"]>([
	"file", "table", "url", "branch", "recipient", "package",
]);

function parseResolvedTarget(value: unknown): ResolvedTarget | null {
	if (!isJsonObject(value)) return null;
	const kind = value.kind;
	const v = value.value;
	if (typeof kind !== "string" || !RESOLVED_TARGET_KINDS.has(kind as ResolvedTarget["kind"])) return null;
	return typeof v === "string" ? { kind: kind as ResolvedTarget["kind"], value: v } : null;
}

/** Replaces `JSON.parse(line) as HarnessDecision` (unchecked ~24-field cast).
 *  Validates `decision` + the only other fields this bridge's one consumer
 *  reads (grep-verified: adapters/*.ts + last-check-writer.ts); the rest are
 *  never read off a legacy decision and are left unset, not deep-validated. */
function parseHarnessDecision(value: unknown): HarnessDecision | null {
	if (!isJsonObject(value)) return null;
	const { decision } = value;
	if (decision !== "allow" && decision !== "block" && decision !== "ask") return null;
	const reason = typeof value.reason === "string" ? value.reason : undefined;
	const rule_id = typeof value.rule_id === "string" ? value.rule_id : undefined;
	const additional_context =
		typeof value.additional_context === "string" ? value.additional_context : undefined;
	const warnings = Array.isArray(value.warnings)
		? value.warnings.filter((w): w is string => typeof w === "string")
		: undefined;
	const resolved_targets = Array.isArray(value.resolved_targets)
		? value.resolved_targets.map(parseResolvedTarget).filter((t): t is ResolvedTarget => t !== null)
		: undefined;
	return {
		decision,
		...(reason !== undefined ? { reason } : {}),
		...(rule_id !== undefined ? { rule_id } : {}),
		...(additional_context !== undefined ? { additional_context } : {}),
		...(warnings !== undefined ? { warnings } : {}),
		...(resolved_targets !== undefined ? { resolved_targets } : {}),
	};
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
				const parsed = parseHarnessDecision(JSON.parse(line));
				if (!parsed) throw new Error("malformed legacy harness decision");
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

/** G3: carry the framed path's per-delivery id so writers can persist it
 *  (raw hook payloads have none; the daemon-minted `seq` is the ordering key).
 *  A helper so `toLegacyHarnessEvent` stays under the cyclomatic cap. */
function copyDeliveryId(event: UnifiedHookEvent, out: HarnessEvent): void {
	if (event.event_id) out.event_id = event.event_id;
	if (event.post_delivery_token) out.post_delivery_token = event.post_delivery_token;
	if (event.post_delivery_pid) out.post_delivery_pid = event.post_delivery_pid;
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
	copyNormalizedContext(event, raw, out);
	copyDeliveryId(event, out);
	copySubagentContext(raw, out);
	const filesModified = readStringArray(raw.files_modified);
	if (filesModified) out.files_modified = filesModified;

	applyActionFields(event, raw, event.action, out);
	applyLegacyFieldFallbacks(raw, out);

	return out;
}

function copyNormalizedContext(
	event: UnifiedHookEvent,
	raw: JsonObject,
	out: HarnessEvent,
): void {
	if (event.context.model) out.model = event.context.model;
	else copyString(raw, out, "model");
	if (event.context.transcript_path) out.transcript_path = event.context.transcript_path;
	else copyString(raw, out, "transcript_path");
	if (event.tool_use_id) out.tool_use_id = event.tool_use_id;
	else copyString(raw, out, "tool_use_id");
	if (event.turn_id) out.prompt_id = event.turn_id;
}

/** Derive `tool_name` / `tool_input` / `tool_response` / `prompt` from the
 *  action's own kind — the one place that knows what each `UnifiedAction`
 *  variant contributes to the legacy wire shape. Split out of
 *  `toLegacyHarnessEvent` so the six-case switch doesn't count against the
 *  orchestrator's cyclomatic budget. */
function applyActionFields(
	event: UnifiedHookEvent,
	raw: JsonObject,
	action: UnifiedAction,
	out: HarnessEvent,
): void {
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
			break;
		case "other": {
			const scalars = pickLifecycleScalars(raw);
			if (scalars) out.tool_input = scalars;
			break;
		}
	}
}

/** Backfill wire-format field-name variants (`tool_input`/`toolInput`,
 *  `tool_response`/`toolResponse`, `prompt`/`message`/`userPrompt`) that
 *  `applyActionFields` left unset — some adapters carry these top-level on
 *  the raw payload instead of inside the normalized action. Split out of
 *  `toLegacyHarnessEvent` for the same cyclomatic-budget reason. */
function applyLegacyFieldFallbacks(raw: JsonObject, out: HarnessEvent): void {
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
		case "post-compact":
			return "PostCompact";
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

const AGENT_SOURCE_BY_RUNNER: Partial<Record<UnifiedHookEvent["runner"], AgentSource>> = {
	"claude-code": "claude",
	"copilot-cli": "copilot",
	codex: "codex",
	"gemini-cli": "gemini",
	cursor: "cursor",
	opencode: "opencode",
	opencode2: "opencode2",
	pi: "pi",
};

function mapAgentSource(runner: UnifiedHookEvent["runner"]): AgentSource {
	return AGENT_SOURCE_BY_RUNNER[runner] ?? "claude";
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

/** Lifecycle payload scalars worth carrying for `other`-kind events
 *  (TaskCompleted, TeammateIdle, PermissionRequest, ...): task/teammate
 *  identity plus subagent parent-session linkage. The adapter path otherwise
 *  drops these — the native payload keeps them top-level, not in tool_input. */
const LIFECYCLE_SCALAR_KEYS = [
	"task_id",
	"task_subject",
	"task_description",
	"teammate_name",
	"team_name",
	"parent_session_id",
	"agent_id",
] as const;

/** Pick the present lifecycle scalars off a native payload; null when none. */
function pickLifecycleScalars(raw: JsonObject): JsonObject | null {
	const out: JsonObject = {};
	for (const key of LIFECYCLE_SCALAR_KEYS) {
		const value = raw[key];
		if (typeof value === "string" && value) out[key] = value;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** Copy the subagent-lifecycle context fields onto the legacy event, mapping
 *  Claude Code's native names (`agent_id`, `parent_agent_name`) to the
 *  harness's canonical `subagent_id` / `parent_agent` when the canonical keys
 *  are absent — without the fallback, the daemon's cohort linkage and
 *  agent-event capture see undefined for claude-code Subagent* events. */
function copySubagentContext(raw: JsonObject, out: HarnessEvent): void {
	copyString(raw, out, "parent_agent");
	copyString(raw, out, "subagent_id");
	copyString(raw, out, "agent_type");
	copyString(raw, out, "last_assistant_message");
	copyString(raw, out, "agent_transcript_path");
	// Per-tool-call agent attribution when the runner sends it — a subagent's
	// own tool events otherwise arrive indistinguishable from the parent's.
	copyString(raw, out, "parent_tool_use_id");
	copyTurnContext(raw, out);
	if (out.subagent_id === undefined) {
		const agentId = readString(raw.agent_id);
		if (agentId) out.subagent_id = agentId;
	}
	if (out.parent_agent === undefined) {
		const parentName = readString(raw.parent_agent_name);
		if (parentName) out.parent_agent = parentName;
	}
}

/** Turn-level context the runner sends on most events and the background-agent
 *  roster it sends on Stop / SubagentStop. `effort` arrives as `{level}`; the
 *  roster is carried through untyped and parsed by `background-task-log.ts`.
 *  All three were dropped until the payload-key census surfaced them. */
function copyTurnContext(raw: JsonObject, out: HarnessEvent): void {
	const promptId = readString(raw.prompt_id);
	if (promptId) out.prompt_id = promptId;
	const effort = raw.effort;
	if (typeof effort === "string" && effort) out.effort = effort;
	else if (effort && typeof effort === "object" && !Array.isArray(effort)) {
		// SAFETY: narrowed to a non-array object; `level` is guarded by readString.
		const level = readString((effort as JsonObject).level);
		if (level) out.effort = level;
	}
	if (Array.isArray(raw.background_tasks)) out.background_tasks = raw.background_tasks;
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
		| "agent_type"
		| "last_assistant_message"
		| "agent_transcript_path"
		| "parent_tool_use_id",
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
		case "last_assistant_message":
			out.last_assistant_message = value;
			return;
		case "agent_transcript_path":
			out.agent_transcript_path = value;
			return;
		case "parent_tool_use_id":
			out.parent_tool_use_id = value;
			return;
	}
}
