// ===========================================
// Tool Classification + Glob Matching Helpers
// ===========================================
//
// Small utilities shared across the evaluator split. Keeping these in a
// single module avoids forcing callers to remember which helper lives
// where when they classify tool names during guard evaluation.

import { existsSync, readFileSync } from "node:fs";
import type { JsonObject } from "../../lib/json-types.js";

/** Public API — consumed by evaluator sub-modules to detect Bash-family tool calls. */
export function isBash(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Bash", "Shell", "shell", "bash", "run_command"].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to detect browser-navigation tool calls. */
export function isBrowserNavigate(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return /^mcp__(?:playwright|chrome-devtools)__(?:browser_navigate|navigate_page|new_page)$/.test(
		toolName,
	);
}

/** Public API — consumed by evaluator sub-modules to detect any file-related tool (read + write). */
export function isFileOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Read",
		"Write",
		"Edit",
		"ReadFile",
		"WriteFile",
		"EditFile",
		"read_file",
		"write_file",
		"edit_file",
		"FileRead",
		"FileWrite",
		"FileEdit",
		"FileDelete",
		// Copilot CLI
		"view",
		"str_replace",
		"create",
		"apply_patch",
	].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to detect file-read tool calls. */
export function isReadOperation(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return ["Read", "ReadFile", "read_file", "FileRead", "view"].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to detect file-write tool calls. */
export function isFileWrite(toolName: string | undefined): boolean {
	if (!toolName) return false;
	return [
		"Write",
		"Edit",
		"Update",
		"MultiEdit",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"write",
		"edit",
		"multi_edit",
		"FileWrite",
		"FileEdit",
		"NotebookEdit",
		// Copilot CLI
		"str_replace",
		"create",
		"apply_patch",
	].includes(toolName);
}

/** Public API — consumed by evaluator sub-modules to estimate the line number of an Edit by
 *  finding old_string in the file. Returns undefined when file is missing or match fails. */
export function estimateEditLine(filePath: string, oldString: string): number | undefined {
	try {
		if (!existsSync(filePath)) return undefined;
		const content = readFileSync(filePath, "utf-8");
		const idx = content.indexOf(oldString);
		if (idx === -1) return undefined;
		// Count newlines before the match
		return content.slice(0, idx).split("\n").length;
	} catch {
		return undefined;
	}
}

/** Jupyter NotebookEdit is classified as a write despite its name containing "edit",
 *  because its semantics match Write for reservation + protected-file purposes. */
const NOTEBOOK_EDIT_TOOL = "notebookedit";

/** Public API — consumed by evaluator sub-modules to map a tool name to a canonical
 *  protected-file operation identifier (Read / Write / Edit / Delete). */
export function normalizeToolToOp(toolName: string): string {
	const lower = toolName.toLowerCase();
	if (lower.includes("read")) return "Read";
	if (lower.includes("write") || lower === NOTEBOOK_EDIT_TOOL) return "Write";
	if (lower.includes("edit")) return "Edit";
	if (lower.includes("delete")) return "Delete";
	return toolName;
}

// ===========================================
// Glob Matching (simple, no dependencies)
// ===========================================

/** Public API — consumed by evaluator sub-modules to match file paths against
 *  the subset of glob patterns used in guard-rules.json + file_reminders. */
export function globMatch(filePath: string, pattern: string): boolean {
	// Handle pipe-separated patterns: "**/*.pem|**/*.key"
	if (pattern.includes("|")) {
		return pattern.split("|").some((p) => globMatch(filePath, p.trim()));
	}

	// Exact match
	if (filePath === pattern) return true;

	// "**/*.ext" — match any file with that extension
	if (pattern.startsWith("**/")) {
		const rest = pattern.slice(3);
		if (rest.startsWith("*.")) {
			const suffix = rest.slice(1); // e.g., ".env*"
			if (suffix.endsWith("*")) {
				// "**/*.env*" — match files containing ".env" in the name
				const core = suffix.slice(0, -1); // ".env"
				return filePath.includes(core);
			}
			return filePath.endsWith(suffix);
		}
		return filePath.endsWith(`/${rest}`) || filePath === rest;
	}

	// "*.ext" — match files with that extension (any directory)
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1);
		if (suffix.endsWith("*")) {
			const core = suffix.slice(0, -1);
			return filePath.includes(core);
		}
		return filePath.endsWith(suffix);
	}

	// "dir/**" — match anything under dir
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return filePath.startsWith(`${prefix}/`) || filePath === prefix;
	}

	// "dir/*" — match direct children
	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -2);
		return (
			filePath.startsWith(`${prefix}/`) && !filePath.slice(prefix.length + 1).includes("/")
		);
	}

	return false;
}

// ===========================================
// Tool Externality Classification
// ===========================================
//
// A coarse-grained "blast radius" axis for the side effects a tool call can
// have. Distinct from the existing read/write predicates, which only model
// local file-system semantics:
//
//   pure_read       — observation only. No mutation; no network. Safe to
//                     repeat, safe to run in parallel, no rollback needed.
//   local_write     — mutates state confined to this machine (files, local
//                     processes, scratch state). Reversible with diff /
//                     filesystem snapshot.
//   external_action — escapes the machine: network request, remote API,
//                     publish/deploy, `git push`, email, etc. Effect is
//                     not locally reversible; policy authors typically
//                     want the strictest gating tier here.
//
// Policy authors can target a guard rule at one or more externality tiers
// via `GuardRule.tool_externality` (see `src/harness/types/rules.ts`). The
// rule-matching pipeline gates by this axis after `tool_match` succeeds —
// see `passesToolExternalityGate` in `rule-matching.ts`.
//
// IMPORTANT: When in doubt, default to `local_write`. The mid-tier is
// deliberately the cautious fallback so unknown tools don't bypass
// strict-tier policies (`external_action`) by failing-open *and* don't
// noisy-trigger read-only policies (`pure_read`).

export type ToolExternality = "pure_read" | "local_write" | "external_action";

/** Names (case-sensitive) of read-only tools. */
const PURE_READ_TOOL_NAMES = new Set<string>([
	"Read",
	"ReadFile",
	"read_file",
	"FileRead",
	"view",
	"Glob",
	"Grep",
	"grep",
	"NotebookRead",
	"ListFiles",
	"TodoRead",
]);

/** Names (case-sensitive) of tools that write to the local filesystem / local state. */
const LOCAL_WRITE_TOOL_NAMES = new Set<string>([
	"Write",
	"WriteFile",
	"write_file",
	"Edit",
	"EditFile",
	"edit_file",
	"MultiEdit",
	"multi_edit",
	"NotebookEdit",
	"FileWrite",
	"FileEdit",
	"FileDelete",
	"str_replace",
	"create",
	"apply_patch",
]);

/** Names (case-sensitive) of tools whose side effects reach beyond the local machine. */
const EXTERNAL_ACTION_TOOL_NAMES = new Set<string>([
	"WebFetch",
	"web_fetch",
	"WebSearch",
	"web_search",
]);

/** MCP tool-name prefixes that imply read-only semantics. Matched after the `mcp__<server>__` prefix. */
const MCP_PURE_READ_VERB_PREFIXES = [
	"list_",
	"get_",
	"search_",
	"read_",
	"describe_",
] as const;

/** MCP tool-name prefixes that imply external side effects. Matched after the `mcp__<server>__` prefix. */
const MCP_EXTERNAL_ACTION_VERB_PREFIXES = [
	"send_",
	"publish_",
	"deploy_",
	"create_pull_request",
	"post_",
	"push_",
	"email_",
] as const;

/** Bash subcommands that escape the local machine. Kept in one regex so the
 *  Bash-refinement path is a single test against the command line. Word
 *  boundaries ensure we don't match `curling` or `subprocess.ssh` substrings.
 *  `gh\s+pr` matches `gh pr create/review/merge/...`; `git push` is handled
 *  separately by a prefix check so a `# git push` comment in a script
 *  doesn't fire. */
const BASH_EXTERNAL_ACTION_REGEX =
	/\b(curl|wget|scp|rsync|ssh|mail|gh\s+pr|docker\s+push|kubectl\s+apply|terraform\s+apply|npm\s+publish|yarn\s+publish|pnpm\s+publish)\b/;

/** Public API — coarse-grained externality classifier for guard-rule gating.
 *  See module header for the externality tiers. Unknown tools default to
 *  `local_write` (cautious mid-tier). */
export function classifyToolExternality(
	toolName: string,
	toolInput?: JsonObject,
): ToolExternality {
	if (!toolName) return "local_write";

	// Bash-family tools refine by inspecting the command string.
	if (isBash(toolName)) {
		const command = typeof toolInput?.command === "string" ? toolInput.command : "";
		if (!command) return "local_write";
		// `git push origin main`, `git push --force`, etc. — handled as a
		// dedicated prefix check (case-sensitive on `git`; the action is
		// always the lowercase verb).
		const trimmed = command.trim();
		if (/^git\s+push\b/.test(trimmed)) return "external_action";
		if (BASH_EXTERNAL_ACTION_REGEX.test(command)) return "external_action";
		return "local_write";
	}

	if (PURE_READ_TOOL_NAMES.has(toolName)) return "pure_read";
	if (LOCAL_WRITE_TOOL_NAMES.has(toolName)) return "local_write";
	if (EXTERNAL_ACTION_TOOL_NAMES.has(toolName)) return "external_action";

	// MCP tools: `mcp__<server>__<verb>`. The server name itself can contain
	// hyphens (e.g. `chrome-devtools`) and the verb may include further
	// underscores (e.g. `list_issues`, `create_pull_request`). Split on the
	// final `__` separator — server is the prefix, verb is the remainder.
	if (toolName.startsWith("mcp__")) {
		const sep = toolName.lastIndexOf("__");
		if (sep > "mcp__".length - 2) {
			const verb = toolName.slice(sep + 2);
			for (const prefix of MCP_PURE_READ_VERB_PREFIXES) {
				if (verb.startsWith(prefix)) return "pure_read";
			}
			for (const prefix of MCP_EXTERNAL_ACTION_VERB_PREFIXES) {
				if (verb.startsWith(prefix)) return "external_action";
			}
		}
	}

	return "local_write";
}
