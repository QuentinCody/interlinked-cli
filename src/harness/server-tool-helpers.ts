// ===========================================
// Server tool-event helpers
// ===========================================
// Extracted from server.ts. Pure functions — no module-level state.

import { nonNull } from "../lib/non-null.js";
import type { HarnessEvent } from "./types.js";

const APPLY_PATCH_FILE_LINE = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/m;
const APPLY_PATCH_MOVE_LINE = /^\*\*\* Move to:\s+(.+)$/m;
/** Global form of the "Move to:" header. Used to walk the patch in the same
 *  order Codex applies sections so we can pair each move with the immediately
 *  preceding file header. */
const APPLY_PATCH_SECTION_LINE =
	/^\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s+(.+)$/gm;

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function observedEffectPaths(event: HarnessEvent): string[] {
	return event.change_set?.files.map((effect) => effect.path) ?? [];
}

/** Pick the raw `apply_patch` payload text from a tool_input. The hook-side
 *  normalizer accepts the patch under any of `command`, `patch`, `content`,
 *  or `_raw_patch` (see `lib/hooks-template.ts` — `command || patch ||
 *  content || _raw_patch`); server-side code that reads only `command` will
 *  silently miss every Codex / Copilot patch event delivered under one of
 *  the alternate names. Keep this helper as the single source of truth so
 *  the two sides can't drift. */
function extractApplyPatchRaw(toolInput: HarnessEvent["tool_input"]): string {
	if (!toolInput) return "";
	return String(
		toolInput.command ||
			toolInput.patch ||
			toolInput.content ||
			toolInput._raw_patch ||
			"",
	);
}

/** Extract the destination file path from a raw apply_patch payload.
 *  Returns the first file referenced (or its move destination if present in
 *  the same section). For multi-file payloads, prefer
 *  {@link extractAllApplyPatchFilePaths}. */
export function extractApplyPatchFilePath(command: string): string | null {
	const movePath = nonEmptyString(command.match(APPLY_PATCH_MOVE_LINE)?.[1]);
	if (movePath) return movePath;
	return nonEmptyString(command.match(APPLY_PATCH_FILE_LINE)?.[1]);
}

/** Extract every destination file path from a raw apply_patch payload, in
 *  source order. Codex `apply_patch` payloads can carry multiple
 *  `*** Update File:` / `Add File:` / `Delete File:` sections in one call,
 *  optionally with a `*** Move to:` line that retargets the most recent
 *  section. We resolve each section to its final path so callers (e.g.
 *  PostToolUse quality / structural / TDD checks) can fan out across all
 *  files in the patch instead of only the first one. */
export function extractAllApplyPatchFilePaths(command: string): string[] {
	const paths: string[] = [];
	APPLY_PATCH_SECTION_LINE.lastIndex = 0;
	let match = APPLY_PATCH_SECTION_LINE.exec(command);
	while (match !== null) {
		const path = nonEmptyString(match[1]);
		const isMove = match[0].startsWith("*** Move to:");
		if (path) {
			if (isMove && paths.length > 0) {
				paths[paths.length - 1] = path;
			} else if (!isMove) {
				paths.push(path);
			}
		}
		match = APPLY_PATCH_SECTION_LINE.exec(command);
	}
	// Dedup while preserving order — a patch that updates and immediately
	// moves to the same path shouldn't run checks twice.
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const p of paths) {
		if (!seen.has(p)) {
			seen.add(p);
			deduped.push(p);
		}
	}
	return deduped;
}

/** Resolve the edited file path from a hook event when one exists. Returns
 *  the first path; for multi-file events prefer
 *  {@link extractAllEditedFilePaths}. */
export function extractEditedFilePath(event: HarnessEvent): string | null {
	const all = extractAllEditedFilePaths(event);
	return all.length > 0 ? nonNull(all[0]) : null;
}

/** Resolve every edited file path from a hook event, in order, with
 *  duplicates removed. Multi-file results currently come from Codex
 *  `apply_patch` payloads and from `files_modified` arrays the runner
 *  itself supplies. */
export function extractAllEditedFilePaths(event: HarnessEvent): string[] {
	const observedPaths = observedEffectPaths(event);
	if (observedPaths.length > 0) return [...new Set(observedPaths)];
	const explicitPath =
		nonEmptyString(event.tool_input?.file_path) ??
		nonEmptyString(event.tool_input?.filePath) ??
		nonEmptyString(event.tool_input?.path) ??
		nonEmptyString(event.tool_input?.target_file);
	const seen = new Set<string>();
	const paths: string[] = [];
	const push = (p: string | null) => {
		if (!p || seen.has(p)) return;
		seen.add(p);
		paths.push(p);
	};

	if (explicitPath) {
		push(explicitPath);
		return paths;
	}

	if (event.tool_name === "apply_patch") {
		const patchPaths = extractAllApplyPatchFilePaths(
			extractApplyPatchRaw(event.tool_input),
		);
		for (const p of patchPaths) push(p);
		if (paths.length > 0) return paths;
	}

	for (const modified of event.files_modified ?? []) {
		push(nonEmptyString(modified));
	}
	return paths;
}

/** Build a one-line summary of the tool being invoked. Used in log lines
 *  and error messages. Capped at 200 chars for commands/URLs. */
export function summarizeToolInput(event: HarnessEvent): string {
	if (!event.tool_input) return event.tool_name || "";
	const input = event.tool_input;
	if (event.tool_name === "apply_patch") {
		const patchPath = extractApplyPatchFilePath(extractApplyPatchRaw(input));
		if (patchPath) return patchPath;
	}
	if (input.command) return String(input.command).slice(0, 200);
	if (input.file_path) return String(input.file_path);
	if (input.url) return String(input.url).slice(0, 200);
	return event.tool_name || "";
}

/** True for Pre-tool-use events across all supported runners (Claude Code
 *  "PreToolUse" and Gemini CLI "BeforeTool"). */
export function isPreToolUse(event: HarnessEvent): boolean {
	return event.hook_event === "PreToolUse" || event.hook_event === "BeforeTool";
}

/** True for Post-tool-use events (including the failure variant) across
 *  all supported runners. */
export function isPostToolUse(event: HarnessEvent): boolean {
	return (
		event.hook_event === "PostToolUse" ||
		event.hook_event === "AfterTool" ||
		event.hook_event === "PostToolUseFailure"
	);
}
