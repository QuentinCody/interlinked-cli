import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import type { AdditionalClientId } from "./additional-client-capabilities.js";

function object(value: unknown): JsonObject { return isJsonObject(value) ? value : {}; }

/** Preserve native arguments while exposing the shared guard's well-defined fields. */
function antigravityInput(raw: JsonObject): JsonObject {
    const tool = object(raw.toolCall);
    const args = object(tool.args);
    // Native positional/chunk edits cannot be evaluated as Claude's global Edit.
    // Preserve their tool identity until a native post-image applier is measured.
    const names: Record<string, string> = { run_command: "Bash", write_to_file: "Write", view_file: "Read" };
    const toolName = typeof tool.name === "string" ? names[tool.name] ?? tool.name : "unknown";
    const input: JsonObject = { ...args };
    const fields = { command: "CommandLine", cwd: "Cwd", file_path: "TargetFile", content: "CodeContent", old_string: "TargetContent", new_string: "ReplacementContent" };
    for (const [canonical, native] of Object.entries(fields)) if (typeof args[native] === "string") input[canonical] = args[native];
    if (typeof args.AbsolutePath === "string") input.file_path = args.AbsolutePath;
    const roots = Array.isArray(raw.workspacePaths) ? raw.workspacePaths : [];
    const cwd = typeof args.Cwd === "string" ? args.Cwd : roots.length === 1 ? roots[0] : undefined;
    return { ...raw, session_id: raw.conversationId, cwd, model: raw.modelName, transcript_path: raw.transcriptPath, tool_name: toolName, tool_input: input, tool_error: raw.error };
}

function windsurfInput(raw: JsonObject, name: string): JsonObject {
    const info = object(raw.tool_info);
    const names: Record<string, string> = { pre_read_code: "Read", post_read_code: "Read", pre_write_code: "MultiEdit", post_write_code: "MultiEdit", pre_run_command: "Bash", post_run_command: "Bash" };
    let toolName = names[name];
    let input: JsonObject = { ...info, command: info.command_line };
    if (name.endsWith("mcp_tool_use")) {
        toolName = `mcp__${String(info.mcp_server_name ?? "unknown")}__${String(info.mcp_tool_name ?? "unknown")}`;
        input = object(info.mcp_tool_arguments);
    }
    return { ...raw, session_id: raw.trajectory_id, turn_id: raw.execution_id, model: raw.model_name, cwd: info.cwd ?? raw.cwd,
        tool_name: toolName, tool_input: input, tool_response: info.mcp_result, prompt: info.user_prompt };
}

export function additionalClientInput(id: AdditionalClientId, input: unknown, name: string): JsonObject {
    const raw = object(input);
    if (id === "antigravity") return antigravityInput(raw);
    if (id === "windsurf") return windsurfInput(raw, name);
    if (id === "factory-droid") {
        const names: Record<string, string> = { Execute: "Bash", Create: "Write", ApplyPatch: "apply_patch" };
        return { ...raw, tool_name: typeof raw.tool_name === "string" ? names[raw.tool_name] ?? raw.tool_name : "unknown" };
    }
    return raw;
}
