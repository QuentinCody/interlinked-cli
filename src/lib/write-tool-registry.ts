// ===========================================
// Write-capable tool names — the ONE registry
// ===========================================
// The inverse of `hook-read-only-tools.ts`: a tool listed here CAN change a
// file, and every surface that needs to know which tools those are derives its
// answer from this one table.
//
// Two surfaces used to answer it separately, by hand:
//
//   1. `harness/adapters/claude-code.ts` — the PostToolUse matcher it writes
//      into `.claude/settings.json`. A tool missing from the matcher never
//      reaches the daemon at all.
//   2. `harness/server/post-tool-pipeline-paths.ts` — the direct-edit list the
//      quality pipeline consults. A tool missing from it reaches the daemon and
//      is then treated as though it edited nothing.
//
// They drifted. `MultiEdit` sat in (1) and not in (2), so a MultiEdit was
// registered, delivered, and then dropped: with no ChangeSet it resolved to
// zero paths and `shouldRunChecks: false`, skipping the entire per-file quality
// pass; with a ChangeSet the paths came back but `isDirectFileEdit` stayed
// false, so the bash-edit OBLIGATION gate — which exists to police the ungated
// shell channel — opened an obligation against an edit that had already been
// judged pre-write, and that obligation blocks writes to other files until it
// is discharged.
//
// The duplication was the defect, not the missing entry. One table, derived
// views, and a drift test that fails if the two ever disagree again.
//
// **Read-only tools must never be listed here.** `isReadOnlyToolName` is the
// complement, and `write-tool-registry.test.ts` pins that the two sets are
// disjoint — so widening this registry cannot quietly re-admit a Read or a Grep
// to the per-file pipeline.

/**
 * How a write tool tells the daemon WHICH file it touched.
 *
 * - `direct` — the tool input names the file (`file_path` / `path` / an
 *   `apply_patch` body). The content gates judged it BEFORE it reached disk.
 * - `shell` — the payload is a command; its effects are only knowable from the
 *   post-call filesystem comparison. This is the channel the bash-edit
 *   obligation gate polices, which is exactly why a `direct` tool must never be
 *   classified here by accident.
 */
export type WriteToolChannel = "direct" | "shell";

/** One write-capable tool name and how the pipeline should treat it. */
export interface WriteToolEntry {
	/** Tool name as the daemon sees it (`evaluator-unified.ts::nativeToolName`
	 *  restores Claude Code's casing; other runners deliver lowercase_snake). */
	readonly name: string;
	readonly channel: WriteToolChannel;
	/** True when Claude Code itself spells the tool this way — i.e. it belongs
	 *  in the adapter's PostToolUse matcher. Names other runners use (Codex
	 *  `apply_patch`, Copilot `str_replace`, Gemini `write_file`) are false:
	 *  Claude Code would never emit them, and padding its matcher regex with
	 *  names that cannot occur only makes the settings file harder to check. */
	readonly claudeCodeNative: boolean;
	/** True when Codex emits this name for a write-capable tool. This drives
	 * Codex's PostToolUse matcher so read-only and coordination calls never
	 * pay the hook/daemon cost. */
	readonly codexNative?: boolean;
}

/**
 * Every tool name the harness treats as write-capable.
 *
 * Claude-native entries come first, in matcher order — `CLAUDE_CODE_WRITE_TOOLS`
 * joins them into the regex alternation the adapter installs, so reordering
 * them rewrites a user's settings file for no reason.
 */
export const WRITE_TOOLS: readonly WriteToolEntry[] = [
	// --- Claude Code native ---
	{ name: "Write", channel: "direct", claudeCodeNative: true },
	{ name: "Edit", channel: "direct", claudeCodeNative: true },
	{ name: "MultiEdit", channel: "direct", claudeCodeNative: true },
	{ name: "NotebookEdit", channel: "direct", claudeCodeNative: true },
	// Bash is the shell channel: not a direct edit, but very much a writer, so
	// it stays in the matcher and keeps its observed ChangeSet.
	{ name: "Bash", channel: "shell", claudeCodeNative: true, codexNative: true },
	// --- Other runners / generic spellings ---
	{ name: "Update", channel: "direct", claudeCodeNative: false },
	{ name: "WriteFile", channel: "direct", claudeCodeNative: false },
	{ name: "EditFile", channel: "direct", claudeCodeNative: false },
	{ name: "write_file", channel: "direct", claudeCodeNative: false },
	{ name: "edit_file", channel: "direct", claudeCodeNative: false },
	{ name: "write", channel: "direct", claudeCodeNative: false },
	{ name: "edit", channel: "direct", claudeCodeNative: false },
	// Copilot CLI / Codex patch verbs.
	{ name: "apply_patch", channel: "direct", claudeCodeNative: false, codexNative: true },
	{ name: "str_replace", channel: "direct", claudeCodeNative: false },
	{ name: "create", channel: "direct", claudeCodeNative: false },
];

/**
 * Tool names the quality pipeline treats as a direct file edit — the declared
 * path is authoritative and the content gates already judged the write.
 * Consumed by `harness/server/post-tool-pipeline-paths.ts`.
 */
export const DIRECT_FILE_EDIT_TOOLS: readonly string[] = WRITE_TOOLS.filter(
	(tool) => tool.channel === "direct",
).map((tool) => tool.name);

/**
 * Claude Code tool names that can change a file — the PostToolUse matcher the
 * adapter installs. Consumed by `harness/adapters/claude-code.ts`.
 */
export const CLAUDE_CODE_WRITE_TOOLS: readonly string[] = WRITE_TOOLS.filter(
	(tool) => tool.claudeCodeNative,
).map((tool) => tool.name);

/** Codex-native write tools admitted to its PostToolUse hook. */
export const CODEX_WRITE_TOOLS: readonly string[] = WRITE_TOOLS.filter(
	(tool) => tool.codexNative === true,
).map((tool) => tool.name);

const WRITE_TOOLS_BY_NAME: ReadonlyMap<string, WriteToolEntry> = new Map(
	WRITE_TOOLS.map((tool) => [tool.name, tool]),
);

/** The registry entry for a tool name, or `undefined` when it is not a known
 *  writer. Exact-match on purpose: an unknown name is handled by the pipeline's
 *  "unknown tools keep their ChangeSet" rule, not by guessing here. */
export function writeToolEntry(name: string | null | undefined): WriteToolEntry | undefined {
	if (!name) return undefined;
	return WRITE_TOOLS_BY_NAME.get(name);
}

/** True when this tool declares the file it edits (see {@link WriteToolChannel}). */
export function isDirectFileEditTool(name: string | null | undefined): boolean {
	return writeToolEntry(name)?.channel === "direct";
}
