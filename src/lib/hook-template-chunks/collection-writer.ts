// Extracted from collection/builder.ts + collection/writer.ts.
// This is DATA — a self-contained JavaScript string embedded into the
// generated `.interlinked/hooks/interlinked-activity.mjs`. It provides
// `buildCollectionRecord` and `appendCollectionRecord` so the hook script
// writes collection.v1 records alongside activity.jsonl without depending
// on CLI module imports.
//
// Invariants:
// - Pure JavaScript (no TypeScript, no imports)
// - Guard records (schema_version 3) are excluded
// - Fire-and-forget: never throws, never blocks the hook pipeline

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const COLLECTION_WRITER_CHUNK = `// --- Collection v1 writer (self-contained) ---
// Mirrors src/lib/collection/builder.ts + writer.ts logic for the hook
// script. Writes .interlinked/collection.jsonl alongside activity.jsonl.

const COLLECTION_TOOL_CLASS_MAP = [
    [new Set(["Bash", "Shell", "shell", "run_command"]), "shell_exec"],
    [new Set(["Read", "ReadFile", "read_file", "view"]), "file_read"],
    [new Set(["Edit", "EditFile", "edit_file", "MultiEdit", "str_replace", "apply_patch"]), "file_edit"],
    [new Set(["Write", "WriteFile", "write_file", "CreateFile", "create_file"]), "file_write"],
    [new Set(["Grep", "grep", "SearchFiles", "search_files", "Glob", "glob", "ListFiles", "list_files"]), "search"],
    [new Set(["WebFetch", "web_fetch", "WebSearch", "web_search"]), "fetch"],
    [new Set(["TaskCreate", "TaskUpdate", "TaskStop"]), "task"],
    [new Set(["NotebookEdit", "notebook_edit"]), "notebook_edit"],
];

function collectionClassifyTool(toolName) {
    if (toolName.startsWith("mcp__")) return "mcp_call";
    for (const [nameSet, toolClass] of COLLECTION_TOOL_CLASS_MAP) {
        if (nameSet.has(toolName)) return toolClass;
    }
    return "other";
}

const COLLECTION_PRE_EVENTS = new Set(["tool_use_start", "permission_request"]);
const COLLECTION_POST_EVENTS = new Set(["tool_use", "tool_use_error"]);
const COLLECTION_TOOL_EVENTS = new Set([...COLLECTION_PRE_EVENTS, ...COLLECTION_POST_EVENTS]);
const COLLECTION_DIRECT_PROVIDER_RUNNERS = new Set([
    "mcp-proxy",
    "codex",
    "copilot",
    "gemini-cli",
    "cursor",
    "opencode",
    "opencode2",
    "pi",
]);

function collectionDetectPhase(eventType) {
    if (COLLECTION_PRE_EVENTS.has(eventType)) return "pre";
    if (COLLECTION_POST_EVENTS.has(eventType)) return "post";
    return null;
}

function collectionDetectProvider(event) {
    if (typeof event.client_runner === "string" && COLLECTION_DIRECT_PROVIDER_RUNNERS.has(event.client_runner)) {
        return event.client_runner;
    }
    const hookEvt = String(event.hook_event || "");
    if (hookEvt === "BeforeTool" || hookEvt === "AfterTool") return "gemini-cli";
    if (event.cursor_version || event.conversation_id) return "cursor";
    return "claude-code";
}

function collectionStrField(obj) {
    for (let i = 1; i < arguments.length; i++) {
        const k = arguments[i];
        if (typeof obj[k] === "string") return obj[k];
    }
    return null;
}

function collectionNumField(obj) {
    for (let i = 1; i < arguments.length; i++) {
        const k = arguments[i];
        if (typeof obj[k] === "number") return obj[k];
    }
    return null;
}

function collectionExtractPath(toolName, input) {
    if (toolName === "apply_patch") {
        const raw = String(input.command || input.patch || input.content || input._raw_patch || "");
        const move = raw.match(/^\\*\\*\\* Move to:\\s+(.+)$/m);
        if (move && move[1]) return move[1].trim();
        const file = raw.match(/^\\*\\*\\* (?:Update|Add|Delete) File:\\s+(.+)$/m);
        return file && file[1] ? file[1].trim() : "";
    }
    return collectionStrField(input, "file_path", "filePath", "path") || "";
}

function collectionParseMcpProviderTool(toolName) {
    if (!toolName.startsWith("mcp__")) return { server: null, tool: toolName };
    const rest = toolName.slice("mcp__".length);
    const delimiter = rest.indexOf("__");
    if (delimiter === -1) return { server: null, tool: rest };
    return {
        server: rest.slice(0, delimiter) || null,
        tool: rest.slice(delimiter + 2) || rest,
    };
}

function collectionBuildAction(toolClass, toolName, input, cwd, event) {
    switch (toolClass) {
        case "shell_exec": return { command: String(input.command || input.cmd || ""), cwd: cwd };
        case "file_read": return { path: collectionExtractPath("Read", input), offset: collectionNumField(input, "offset"), limit: collectionNumField(input, "limit") };
        case "file_edit": {
            const path = collectionExtractPath(toolName, input);
            const hunks = [];
            if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
                for (const e of input.edits) {
                    if (e && typeof e === "object") hunks.push({ old: String(e.old_string || ""), new: String(e.new_string || "") });
                }
            } else if (toolName === "apply_patch") {
                hunks.push({ old: "", new: String(input.command || input.patch || "") });
            } else {
                hunks.push({ old: String(input.old_string || ""), new: String(input.new_string || "") });
            }
            return { path: path, diff: { hunks: hunks, unified: null } };
        }
        case "file_write": return { path: collectionExtractPath("Write", input), content: typeof input.content === "string" ? input.content : null, content_ref: null, is_new_file: event.is_new_file === true };
        case "search": return { pattern: String(input.pattern || input.query || input.glob || ""), path: collectionStrField(input, "path"), flags: null };
        case "fetch": return { url: String(input.url || input.query || ""), prompt: collectionStrField(input, "prompt") };
        case "task": return { task: String(input.subject || input.task || ""), params: input.description || null };
        case "notebook_edit": return { path: collectionExtractPath("NotebookEdit", input), cell: collectionStrField(input, "cell"), diff: input.diff || null };
        case "mcp_call": {
            const parsed = collectionParseMcpProviderTool(toolName);
            return {
                server: collectionStrField(input, "server") || parsed.server,
                tool: String(input.tool || parsed.tool),
                params: input.params !== undefined ? input.params : (input.arguments !== undefined ? input.arguments : (input.args !== undefined ? input.args : input)),
                params_ref: null,
            };
        }
        default: return { provider_input: input, provider_input_ref: null };
    }
}

function collectionBuildObservation(toolClass, resp) {
    if (resp === null || resp === undefined) return null;
    switch (toolClass) {
        case "shell_exec": {
            if (resp && typeof resp === "object" && !Array.isArray(resp)) {
                return { stdout: collectionStrField(resp, "stdout"), stderr: collectionStrField(resp, "stderr"), exit_code: collectionNumField(resp, "exitCode", "exit_code", "returncode"), duration_ms: collectionNumField(resp, "duration_ms") };
            }
            if (typeof resp === "string") return { stdout: resp, stderr: null, exit_code: null, duration_ms: null, combined_output: true };
            return { stdout: null, stderr: null, exit_code: null, duration_ms: null };
        }
        case "file_read": {
            let content = null;
            if (typeof resp === "string") content = resp;
            else if (resp && typeof resp === "object") {
                if (resp.file && typeof resp.file === "object") content = collectionStrField(resp.file, "content");
                else content = collectionStrField(resp, "content");
            }
            return { content: content, content_ref: null, line_count: content !== null ? content.split("\\n").length : null, byte_count: null };
        }
        case "file_edit":
        case "file_write": {
            const msg = typeof resp === "string" ? resp : null;
            return { applied: msg !== null ? !/error|fail/i.test(msg) : true, result_message: msg, provider_echo_ref: null };
        }
        case "search": return { matches: null, match_count: null, result_text: typeof resp === "string" ? resp : null };
        case "fetch": {
            if (resp && typeof resp === "object" && !Array.isArray(resp)) {
                return { status: collectionNumField(resp, "status"), result: resp.result || resp.content || null, result_ref: null, bytes: collectionNumField(resp, "bytes") };
            }
            if (typeof resp === "string") return { status: null, result: resp, result_ref: null, bytes: null };
            return { status: null, result: null, result_ref: null, bytes: null };
        }
        case "task": return { result: resp };
        case "notebook_edit": return { applied: true, result_message: typeof resp === "string" ? resp : null };
        case "mcp_call": return { result: resp, result_ref: null };
        default: return { provider_output: resp, provider_output_ref: null };
    }
}

const COLLECTION_FIDELITY_FIELD_MAP = {
    shell_exec: ["observation.stdout", "observation.stderr"],
    file_read: ["observation.content"],
    search: ["observation.result_text"],
    fetch: ["observation.result"],
};

function collectionComputeCapturedBytes(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === "string") return Buffer.byteLength(val, "utf8");
    return Buffer.byteLength(JSON.stringify(val), "utf8");
}

function collectionBuildFidelity(phase, toolClass, observation, resp, event) {
    const fields = {};
    const capped = resp && typeof resp === "object" && !Array.isArray(resp) && "_interlinked_truncated_bytes" in resp;
    const payloadBytes = typeof event.tool_output_bytes === "number" ? event.tool_output_bytes : 0;

    if (phase === "post" && observation !== null) {
        const fieldKeys = COLLECTION_FIDELITY_FIELD_MAP[toolClass];
        if (fieldKeys) {
            for (const fk of fieldKeys) {
                const shortKey = fk.replace("observation.", "");
                const val = observation[shortKey];
                if (val !== undefined && val !== null) {
                    fields[fk] = {
                        source: "provider_hook",
                        provider_truncated: "unknown",
                        interlinked_capped: !!capped,
                        provider_payload_bytes: payloadBytes,
                        captured_bytes: collectionComputeCapturedBytes(val),
                        completeness: capped ? "interlinked_capped" : "complete",
                    };
                }
            }
        }
    }

    const worstCompleteness = Object.values(fields).some(function(f) { return f.completeness === "interlinked_capped"; })
        ? "interlinked_capped"
        : "complete";

    return { record: { source: "provider_hook", completeness: worstCompleteness }, fields: fields };
}

function buildCollectionRecord(event) {
    const eventType = String(event.event_type || event.type || "");
    // Guard telemetry (guard_allow/guard_warn/guard_block) is local-only and is
    // never collected — keyed on record TYPE (either discriminator field), not
    // schema_version (the version is the log-format version, shared across families).
    if (eventType.startsWith("guard_") || String(event.type || "").startsWith("guard_")) return null;
    if (!COLLECTION_TOOL_EVENTS.has(eventType)) return null;

    const toolName = String(event.tool_name || event.tool || "");
    if (!toolName) return null;

    const phase = collectionDetectPhase(eventType);
    if (!phase) return null;

    const toolClass = collectionClassifyTool(toolName);
    const input = (event.tool_input && typeof event.tool_input === "object") ? event.tool_input : {};
    const cwd = collectionStrField(event, "cwd");
    const resp = phase === "post" ? (event.tool_response || null) : null;

    const action = collectionBuildAction(toolClass, toolName, input, cwd, event);
    const observation = phase === "post" ? collectionBuildObservation(toolClass, resp) : null;

    const head = collectionStrField(event, "git_head");
    const branch = collectionStrField(event, "git_branch");
    const git = (head || branch) ? { head: head, branch: branch } : null;

    return {
        schema: "collection.v1",
        kind: "tool_event",
        ts: String(event.ts || new Date().toISOString()),
        session_id: collectionStrField(event, "session") || collectionStrField(event, "session_id_hint") || null,
        turn_id: collectionStrField(event, "turn_id"),
        tool_use_id: collectionStrField(event, "tool_use_id"),
        provider: collectionDetectProvider(event),
        phase: phase,
        tool_class: toolClass,
        provider_tool: toolName,
        cwd: cwd,
        git: git,
        action: action,
        observation: observation,
        fidelity: collectionBuildFidelity(phase, toolClass, observation, resp, event),
        privacy: { redaction_status: phase === "post" && observation !== null ? "unscanned" : "not_required", redaction_passes: [], sensitivity: "unknown", contains_sensitive: "unknown", allowed_for_training: false, allowed_for_cloud_upload: false },
        provider_raw: { tool_input_ref: null, tool_response_ref: null, tool_input_sha256: collectionStrField(event, "content_sha256"), tool_response_sha256: collectionStrField(event, "tool_response_sha256") },
    };
}

function appendCollectionRecord(event, dataDir) {
    try {
        const record = buildCollectionRecord(event);
        if (!record) return;
        const collectionPath = join(dataDir, "collection.jsonl");
        const dir = dirname(collectionPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileWithMutationLock(collectionPath, JSON.stringify(record) + "\\n");
    } catch (_err) { void 0; /* intentional: collection write is best-effort */ }
}`;
