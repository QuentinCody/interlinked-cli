// ===========================================
// Collection v1 — Canonical Record Builder
// ===========================================
// Maps normalized activity events (LocalActivityEvent shape) into
// collection.v1 records. See docs/design/normalized-collection-layer.md.

import type { JsonObject } from "../json-types.js";
import type {
	CollectionAction,
	CollectionObservation,
	CollectionRecord,
	CompletenessValue,
	FidelityBlock,
	FieldFidelity,
	FileEditAction,
	GitContext,
	PrivacyBlock,
	ProviderRawBlock,
	ToolClass,
} from "./types.js";

// --- Tool class mapping ---

const TOOL_CLASS_SETS: ReadonlyArray<readonly [ReadonlySet<string>, ToolClass]> = [
	[new Set(["Bash", "Shell", "shell", "run_command"]), "shell_exec"],
	[new Set(["Read", "ReadFile", "read_file", "view"]), "file_read"],
	[new Set(["Edit", "EditFile", "edit_file", "MultiEdit", "str_replace", "apply_patch"]), "file_edit"],
	[new Set(["Write", "WriteFile", "write_file", "CreateFile", "create_file"]), "file_write"],
	[new Set(["Grep", "grep", "SearchFiles", "search_files", "Glob", "glob", "ListFiles", "list_files"]), "search"],
	[new Set(["WebFetch", "web_fetch", "WebSearch", "web_search"]), "fetch"],
	[new Set(["TaskCreate", "TaskUpdate", "TaskStop"]), "task"],
	[new Set(["NotebookEdit", "notebook_edit"]), "notebook_edit"],
];

function classifyTool(toolName: string): ToolClass {
	if (toolName.startsWith("mcp__")) return "mcp_call";
	for (const [nameSet, toolClass] of TOOL_CLASS_SETS) {
		if (nameSet.has(toolName)) return toolClass;
	}
	return "other";
}

// --- Phase detection ---

/** Legacy activity `type`s the builder projects to a PRE-phase record (which the
 *  collection reader projects back as `tool_use_start`). Exported so the merge
 *  reader's identity dedup can normalize a raw type to its projected display type
 *  — `permission_request` ⇄ `tool_use_start` would otherwise never match across
 *  the two stores (imported, not mirrored: the hand-copied set is what drifted). */
export const PRE_EVENT_TYPES: ReadonlySet<string> = new Set(["tool_use_start", "permission_request"]);
const POST_EVENT_TYPES = new Set(["tool_use", "tool_use_error"]);
/** Every legacy activity `type` the collection builder CONSUMES (projects into
 *  collection.jsonl). Exported as the single source of truth for the merge reader:
 *  when collection.jsonl exists, a legacy row of one of these types is dropped
 *  exactly when its collection twin is present (identity dedup — finding 2026-06:
 *  type-level dropping erased pre-collection history and failed-append events). */
export const TOOL_EVENT_TYPES: ReadonlySet<string> = new Set([...PRE_EVENT_TYPES, ...POST_EVENT_TYPES]);

const GEMINI_HOOK_EVENTS = new Set(["BeforeTool", "AfterTool"]);
const DIRECT_PROVIDER_RUNNERS = new Set([
	"mcp-proxy",
	"codex",
	"copilot",
	"gemini-cli",
	"cursor",
	"opencode",
	"opencode2",
	"pi",
]);

function detectPhase(eventType: string): "pre" | "post" | null {
	if (PRE_EVENT_TYPES.has(eventType)) return "pre";
	if (POST_EVENT_TYPES.has(eventType)) return "post";
	return null;
}

// --- Provider detection ---

function detectProvider(event: JsonObject): string {
	if (typeof event.client_runner === "string" && DIRECT_PROVIDER_RUNNERS.has(event.client_runner)) {
		return event.client_runner;
	}
	const hookEvent = String(event.hook_event || "");
	if (GEMINI_HOOK_EVENTS.has(hookEvent)) return "gemini-cli";
	if (event.cursor_version || event.conversation_id) return "cursor";
	return "claude-code";
}

// --- Shared helpers ---

function strField(obj: JsonObject, ...keys: string[]): string | null {
	for (const k of keys) {
		if (typeof obj[k] === "string") return obj[k] as string;
	}
	return null;
}

function numField(obj: JsonObject, ...keys: string[]): number | null {
	for (const k of keys) {
		if (typeof obj[k] === "number") return obj[k] as number;
	}
	return null;
}

function extractFilePath(toolName: string, input: JsonObject): string {
	if (toolName === "apply_patch") {
		const raw = String(input.command || input.patch || input.content || input._raw_patch || "");
		const move = raw.match(/^\*\*\* Move to:\s+(.+)$/m);
		if (move?.[1]) return move[1].trim();
		const file = raw.match(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/m);
		return file?.[1]?.trim() ?? "";
	}
	return strField(input, "file_path", "filePath", "path") ?? "";
}

function parseMcpProviderTool(toolName: string): { server: string | null; tool: string } {
	if (!toolName.startsWith("mcp__")) {
		return { server: null, tool: toolName };
	}
	const rest = toolName.slice("mcp__".length);
	const delimiter = rest.indexOf("__");
	if (delimiter === -1) {
		return { server: null, tool: rest };
	}
	return {
		server: rest.slice(0, delimiter) || null,
		tool: rest.slice(delimiter + 2) || rest,
	};
}

function resolveSessionId(event: JsonObject): string | null {
	const session = strField(event, "session");
	if (session) return session;
	return strField(event, "session_id_hint");
}

// --- Mutation-result observation (shared by file_edit + file_write) ---

const FAILURE_PATTERN = /error|fail/i;

function buildMutationResultObservation(resp: unknown): CollectionObservation {
	const msg = typeof resp === "string" ? resp : null;
	return {
		applied: msg !== null ? !FAILURE_PATTERN.test(msg) : true,
		result_message: msg,
		provider_echo_ref: null,
	};
}

// --- Action builder context ---

interface ActionContext {
	toolClass: ToolClass;
	toolName: string;
	input: JsonObject;
	cwd: string | null;
	event: JsonObject;
}

const ACTION_BUILDERS: Record<ToolClass, (ctx: ActionContext) => CollectionAction | null> = {
	shell_exec: ({ input, cwd }) => ({
		command: String(input.command || input.cmd || ""),
		cwd,
	}),

	file_read: ({ input }) => ({
		path: extractFilePath("Read", input),
		offset: numField(input, "offset"),
		limit: numField(input, "limit"),
	}),

	file_edit: ({ toolName, input }) => {
		const path = extractFilePath(toolName, input);
		const hunks: FileEditAction["diff"]["hunks"] = [];

		if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
			for (const e of input.edits as JsonObject[]) {
				if (e && typeof e === "object") {
					hunks.push({ old: String(e.old_string || ""), new: String(e.new_string || "") });
				}
			}
		} else if (toolName === "apply_patch") {
			hunks.push({ old: "", new: String(input.command || input.patch || "") });
		} else {
			hunks.push({ old: String(input.old_string || ""), new: String(input.new_string || "") });
		}

		return { path, diff: { hunks, unified: null } };
	},

	file_write: ({ input, event }) => ({
		path: extractFilePath("Write", input),
		content: typeof input.content === "string" ? input.content : null,
		content_ref: null,
		is_new_file: event.is_new_file === true,
	}),

	file_delete: ({ toolName, input }) => ({
		path: extractFilePath(toolName, input),
	}),

	search: ({ input }) => ({
		pattern: String(input.pattern || input.query || input.glob || ""),
		path: strField(input, "path"),
		flags: null,
	}),

	fetch: ({ input }) => ({
		url: String(input.url || input.query || ""),
		prompt: strField(input, "prompt"),
	}),

	task: ({ input }) => ({
		task: String(input.subject || input.task || ""),
		params: input.description ?? null,
	}),

	notebook_edit: ({ input }) => ({
		path: extractFilePath("NotebookEdit", input),
		cell: strField(input, "cell"),
		diff: input.diff ?? null,
	}),

	mcp_call: ({ toolName, input }) => {
		const parsed = parseMcpProviderTool(toolName);
		return {
			server: strField(input, "server") ?? parsed.server,
			tool: String(input.tool || parsed.tool),
			params: input.params ?? input.arguments ?? input.args ?? input,
			params_ref: null,
		};
	},

	other: ({ input }) => ({
		provider_input: input,
		provider_input_ref: null,
	}),
};

// --- Observation builders ---

function buildShellObservation(resp: unknown): CollectionObservation {
	if (resp && typeof resp === "object" && !Array.isArray(resp)) {
		const r = resp as JsonObject;
		return {
			stdout: strField(r, "stdout"),
			stderr: strField(r, "stderr"),
			exit_code: numField(r, "exitCode", "exit_code", "returncode"),
			duration_ms: numField(r, "duration_ms"),
		};
	}
	if (typeof resp === "string") {
		return { stdout: resp, stderr: null, exit_code: null, duration_ms: null, combined_output: true };
	}
	return { stdout: null, stderr: null, exit_code: null, duration_ms: null };
}

function buildFileReadObservation(resp: unknown): CollectionObservation {
	let content: string | null = null;
	if (typeof resp === "string") {
		content = resp;
	} else if (resp && typeof resp === "object") {
		const r = resp as JsonObject;
		if (r.file && typeof r.file === "object") {
			content = strField(r.file as JsonObject, "content");
		} else {
			content = strField(r, "content");
		}
	}
	return {
		content,
		content_ref: null,
		line_count: content !== null ? content.split("\n").length : null,
		byte_count: content !== null ? Buffer.byteLength(content, "utf8") : null,
	};
}

function buildSearchObservation(resp: unknown): CollectionObservation {
	return { matches: null, match_count: null, result_text: typeof resp === "string" ? resp : null };
}

function buildFetchObservation(resp: unknown): CollectionObservation {
	if (resp && typeof resp === "object" && !Array.isArray(resp)) {
		const r = resp as JsonObject;
		return {
			status: numField(r, "status"),
			result: r.result ?? r.content ?? null,
			result_ref: null,
			bytes: numField(r, "bytes"),
		};
	}
	if (typeof resp === "string") {
		return { status: null, result: resp, result_ref: null, bytes: null };
	}
	return { status: null, result: null, result_ref: null, bytes: null };
}

const OBSERVATION_BUILDERS: Record<ToolClass, (resp: unknown) => CollectionObservation> = {
	shell_exec: buildShellObservation,
	file_read: buildFileReadObservation,
	file_edit: buildMutationResultObservation,
	file_write: buildMutationResultObservation,
	search: buildSearchObservation,
	fetch: buildFetchObservation,
	task: (resp) => ({ result: resp }),
	notebook_edit: (resp) => ({ applied: true, result_message: typeof resp === "string" ? resp : null }),
	file_delete: (resp) => ({ deleted: true, result_message: typeof resp === "string" ? resp : null }),
	mcp_call: (resp) => ({ result: resp, result_ref: null }),
	other: (resp) => ({ provider_output: resp, provider_output_ref: null }),
};

function buildObservation(toolClass: ToolClass, resp: unknown): CollectionObservation | null {
	if (resp === null || resp === undefined) return null;
	return OBSERVATION_BUILDERS[toolClass](resp);
}

// --- Fidelity ---

function isInterlinkedCapped(resp: unknown): boolean {
	if (resp && typeof resp === "object" && !Array.isArray(resp)) {
		return "_interlinked_truncated_bytes" in (resp as JsonObject);
	}
	return false;
}

function computeCapturedBytes(fieldValue: unknown): number {
	if (fieldValue === null || fieldValue === undefined) return 0;
	if (typeof fieldValue === "string") return Buffer.byteLength(fieldValue, "utf8");
	return Buffer.byteLength(JSON.stringify(fieldValue), "utf8");
}

function buildFieldFidelity(fieldValue: unknown, payloadBytes: number, capped: boolean): FieldFidelity {
	return {
		source: "provider_hook",
		provider_truncated: "unknown",
		interlinked_capped: capped,
		provider_payload_bytes: payloadBytes,
		captured_bytes: computeCapturedBytes(fieldValue),
		completeness: capped ? "interlinked_capped" : "complete",
	};
}

const FIDELITY_FIELD_MAP: Record<string, string[]> = {
	shell_exec: ["observation.stdout", "observation.stderr"],
	file_read: ["observation.content"],
	search: ["observation.result_text"],
	fetch: ["observation.result"],
};

function buildFidelity(
	opts: { phase: "pre" | "post"; toolClass: ToolClass; observation: CollectionObservation | null; resp: unknown; event: JsonObject },
): FidelityBlock {
	const fields: Record<string, FieldFidelity> = {};
	const capped = isInterlinkedCapped(opts.resp);
	const payloadBytes = typeof opts.event.tool_output_bytes === "number" ? opts.event.tool_output_bytes : 0;

	if (opts.phase === "post" && opts.observation !== null) {
		const obs = opts.observation as JsonObject;
		const fieldKeys = FIDELITY_FIELD_MAP[opts.toolClass];
		if (fieldKeys) {
			for (const fk of fieldKeys) {
				const shortKey = fk.replace("observation.", "");
				const val = obs[shortKey];
				if (val !== undefined && val !== null) {
					fields[fk] = buildFieldFidelity(val, payloadBytes, capped);
				}
			}
		}
	}

	const worstCompleteness: CompletenessValue =
		Object.values(fields).some((f) => f.completeness === "interlinked_capped")
			? "interlinked_capped"
			: "complete";

	return {
		record: { source: "provider_hook", completeness: worstCompleteness },
		fields,
	};
}

// --- Privacy ---

function buildPrivacy(phase: "pre" | "post", observation: CollectionObservation | null): PrivacyBlock {
	const hasObservation = phase === "post" && observation !== null;
	return {
		redaction_status: hasObservation ? "unscanned" : "not_required",
		redaction_passes: [],
		sensitivity: "unknown",
		contains_sensitive: "unknown",
		allowed_for_training: false,
		allowed_for_cloud_upload: false,
	};
}

// --- Provider raw ---

function buildProviderRaw(event: JsonObject): ProviderRawBlock {
	return {
		tool_input_ref: null,
		tool_response_ref: null,
		tool_input_sha256: strField(event, "content_sha256"),
		tool_response_sha256: strField(event, "tool_response_sha256"),
	};
}

// --- Git context ---

function buildGit(event: JsonObject): GitContext | null {
	const head = strField(event, "git_head");
	const branch = strField(event, "git_branch");
	if (!head && !branch) return null;
	return { head, branch };
}

// --- Public API ---

/**
 * Build a collection.v1 record from a normalized activity event.
 * Returns null for non-tool events (session lifecycle, guard telemetry, etc.).
 */
export function buildCollectionRecord(event: JsonObject): CollectionRecord | null {
	const eventType = String(event.event_type || event.type || "");
	// Guard telemetry (guard_allow/guard_warn/guard_block) is local-only and is
	// never collected — keyed on record TYPE (either discriminator field), not
	// schema_version (the version is the log-format version, shared across families).
	if (eventType.startsWith("guard_") || String(event.type || "").startsWith("guard_")) return null;
	if (!TOOL_EVENT_TYPES.has(eventType)) return null;

	const toolName = String(event.tool_name || event.tool || "");
	if (!toolName) return null;

	const phase = detectPhase(eventType);
	if (!phase) return null;

	// Preserve the success/failure discriminator on POST events so the canonical
	// round-trip can reconstruct `tool_use_error` rather than collapsing every post
	// event to `tool_use` (finding 5). Pre events carry no outcome yet.
	const outcome: "ok" | "error" | undefined =
		phase === "post" ? (eventType === "tool_use_error" ? "error" : "ok") : undefined;

	const toolClass = classifyTool(toolName);
	const input = (event.tool_input && typeof event.tool_input === "object"
		? event.tool_input
		: {}) as JsonObject;
	const cwd = strField(event, "cwd");
	const resp = phase === "post" ? (event.tool_response ?? null) : null;

	const actionBuilder = ACTION_BUILDERS[toolClass];
	const action = actionBuilder ? actionBuilder({ toolClass, toolName, input, cwd, event }) : null;
	const observation = phase === "post" ? buildObservation(toolClass, resp) : null;
	const fidelity = buildFidelity({ phase, toolClass, observation, resp, event });
	const privacy = buildPrivacy(phase, observation);

	return {
		schema: "collection.v1",
		kind: "tool_event",
		ts: String(event.ts || ""),
		session_id: resolveSessionId(event),
		agent_name: strField(event, "agent_name", "agent"),
		subagent_id: strField(event, "subagent_id"),
		parent_agent: strField(event, "parent_agent"),
		model: strField(event, "model"),
		turn_id: strField(event, "turn_id"),
		tool_use_id: strField(event, "tool_use_id"),
		...(typeof event.seq === "number" ? { seq: event.seq } : {}),
		provider: detectProvider(event),
		phase,
		...(outcome ? { outcome } : {}),
		tool_class: toolClass,
		provider_tool: toolName,
		cwd,
		git: buildGit(event),
		action,
		observation,
		fidelity,
		privacy,
		provider_raw: buildProviderRaw(event),
	};
}
