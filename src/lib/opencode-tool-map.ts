// ===========================================
// OpenCode v2 (opencode2) tool names → Interlinked (Claude-shaped) tool_input
// ===========================================
// Shared by the installed v2 plugin (inlined) and the runner adapter.
// OpenCode tools are lowercase (`edit`, `bash`); the harness evaluator matches
// on Claude-style names (`Edit`, `Bash`) plus snake_case file_path fields.
// v2 (`opencode2`) bridge.

import type { JsonObject } from "./json-types.js";

export interface MappedOpencodeTool {
	tool_name: string;
	tool_input: JsonObject;
}

function asRecord(value: unknown): JsonObject {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		return value as JsonObject;
	}
	return {};
}

function str(obj: JsonObject, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function pick(obj: JsonObject, from: string, to: string): JsonObject {
	const value = obj[from];
	return value === undefined ? {} : { [to]: value };
}

/** Map one OpenCode v2 tool invocation onto the harness's expected tool names. */
export function mapOpencode2Tool(tool: string, args: unknown): MappedOpencodeTool {
	const a = asRecord(args);
	switch (tool) {
		case "bash":
		case "shell":
			return {
				tool_name: "Bash",
				tool_input: {
					...pick(a, "command", "command"),
					...(str(a, "workdir", "cwd") ? { cwd: str(a, "workdir", "cwd") } : {}),
				},
			};
		case "edit":
			return {
				tool_name: "Edit",
				tool_input: {
					file_path: str(a, "filePath", "file_path", "path") ?? "",
					old_string: str(a, "oldString", "old_string") ?? "",
					new_string: str(a, "newString", "new_string") ?? "",
					...(a.replaceAll === true || a.replace_all === true ? { replace_all: true } : {}),
				},
			};
		case "write":
			return {
				tool_name: "Write",
				tool_input: {
					file_path: str(a, "filePath", "file_path", "path") ?? "",
					content: str(a, "content") ?? "",
				},
			};
		case "read":
			return {
				tool_name: "Read",
				tool_input: {
					file_path: str(a, "filePath", "file_path", "path") ?? "",
					...(a.offset !== undefined ? { offset: a.offset } : {}),
					...(a.limit !== undefined ? { limit: a.limit } : {}),
				},
			};
		case "apply_patch":
			return {
				tool_name: "apply_patch",
				tool_input: { patchText: str(a, "patchText", "patch_text") ?? "" },
			};
		case "grep":
			return {
				tool_name: "Grep",
				tool_input: {
					pattern: str(a, "pattern") ?? "",
					path: str(a, "path"),
					glob: str(a, "include", "glob"),
				},
			};
		case "glob":
			return {
				tool_name: "Glob",
				tool_input: { pattern: str(a, "pattern") ?? "", path: str(a, "path") },
			};
		case "webfetch":
			return {
				tool_name: "WebFetch",
				tool_input: { url: str(a, "url") ?? "" },
			};
		case "task":
			return {
				tool_name: "Task",
				tool_input: {
					description: str(a, "description") ?? "",
					prompt: str(a, "prompt") ?? "",
					subagent_type: str(a, "subagent_type", "agent") ?? "",
				},
			};
		default:
			return { tool_name: tool, tool_input: a };
	}
}

/** Recursive rm of / or ~. Matches `-rf` and `-fr` (and mixed clusters containing both). */
export const OPENCODE2_DESTRUCTIVE_RM = /\brm\s+-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)\b.*\s(\/|~)/;
const INSTALL_VERB =
	/\b(npm|pnpm|yarn|bun|pip|pip3|pipx|poetry|uv|cargo|gem|bundle|go)\s+(install|add|get)\b/;

/** Tiny fail-closed subset used when the daemon socket is unreachable (v2). */
export function opencode2ColdBlockReason(toolName: string, toolInput: JsonObject): string | null {
	if (toolName !== "Bash") return null;
	const command = typeof toolInput.command === "string" ? toolInput.command : "";
	if (OPENCODE2_DESTRUCTIVE_RM.test(command)) {
		return "BLOCKED: Recursive deletion of a filesystem root is not allowed (OpenCode cold fallback).";
	}
	if (INSTALL_VERB.test(command)) {
		return "BLOCKED: Package installs require the Interlinked daemon (allowlist). Start it with `interlinked harness start`.";
	}
	return null;
}
