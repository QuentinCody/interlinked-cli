// ===========================================
// Claude Code — Install/Uninstall
// ===========================================
// Per-client hook installation for Claude Code's `.claude/settings.json`.
// Claude Code merges hooks from every `.claude/settings.json` up the
// directory tree, so install refuses when an ancestor already has our hooks
// and uninstall cleans both the cwd and the git-root settings file.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	buildHookCommand,
	findParentWithHooks,
	hookSettingsObject,
	installHookEntry,
	isPlainObject,
	readJsonFile,
	writeJsonFile,
} from "./hook-installers-shared.js";
import { isInterlinkedHookEntry } from "./hook-ownership.js";
import { CLIENT_CLAUDE, findProjectRoot, type HookEntry } from "./hook-types.js";

// Claude Code hook events registered in settings.json.
// PostToolUseFailure is intentionally omitted — registering it causes Claude Code
// to display "2 PostToolUse hooks ran" since it counts both registrations.
// The hook script still handles PostToolUseFailure if received (via isPostTool check).
/** Public API — consumed by `src/lib/hooks.ts`. */
export const CLAUDE_HOOK_EVENTS = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"Stop",
	"PreToolUse",
	"PostToolUse",
	// PermissionRequest denies use its native permission envelope. Clean and
	// ask outcomes abstain so Claude's policy/user prompt remains authoritative.
	"PermissionRequest",
	// A failing WorktreeCreate hook replaces Claude's default Git creation and
	// enforces Interlinked's no-agent-created-worktrees policy.
	"WorktreeCreate",
	"SubagentStart",
	"SubagentStop",
	"Notification",
	"PreCompact",
	"TaskCompleted",
	"TeammateIdle",
] as const;

function getClaudeSettingsPath(cwd: string): string {
	return join(cwd, ".claude", "settings.json");
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Claude Code's `.claude/settings.json` for
 * the current working directory. Refuses to install if an ancestor already
 * has hooks (Claude Code merges hooks up the directory tree).
 */
export function installAllClaudeHooks(cwd: string, hookScriptPath: string): void {
	// Refuse to install if a parent directory already has interlinked hooks.
	// Claude Code merges hooks from all .claude/settings.json files in the path,
	// so duplicate registrations cause "2 PostToolUse hooks ran" and can swallow output.
	const parentWithHooks = findParentWithHooks(cwd, join(".claude", "settings.json"));
	if (parentWithHooks) {
		console.error(
			`\n⚠️  Skipping Claude hook installation — hooks already installed at ${parentWithHooks}/.claude/settings.json\n` +
				"   Claude Code merges hooks from all .claude/settings.json files in the path,\n" +
				"   so installing here would cause duplicate hooks.\n" +
				`   Run \`interlinked enable\` from ${parentWithHooks} instead.\n`,
		);
		return;
	}

	const settingsPath = getClaudeSettingsPath(cwd);
	const settings = readJsonFile(settingsPath) || {};

	const hooks = hookSettingsObject(settings);

	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_CLAUDE);

	for (const eventName of CLAUDE_HOOK_EVENTS) {
		installHookEntry(hooks, eventName, hookCommand);
	}

	writeJsonFile(settingsPath, settings);
}

function cleanClaudeHooksFromFile(settingsPath: string): boolean {
	if (!existsSync(settingsPath)) return false;

	const settings = readJsonFile(settingsPath);
	if (!settings || !isPlainObject(settings.hooks)) return false;

	const hooks = settings.hooks;
	let changed = false;
	// Iterate every event present, not a fixed list — the adapter installer
	// can register events the legacy CLAUDE_HOOK_EVENTS list omits (e.g.
	// PostToolUseFailure); uninstall must still remove all of them.
	for (const eventName of Object.keys(hooks)) {
		const entries = hooks[eventName];
		if (!Array.isArray(entries)) continue;

		const filtered = entries.filter((entry: HookEntry) => !isInterlinkedHookEntry(entry));

		if (filtered.length !== entries.length) {
			hooks[eventName] = filtered.length > 0 ? filtered : undefined;
			changed = true;
		}
	}

	// Clean up empty hooks object
	if (Object.values(hooks).every((v) => v === undefined)) {
		delete settings.hooks;
	}

	if (changed) {
		writeJsonFile(settingsPath, settings);
	}
	return changed;
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Claude Code settings at the cwd AND at the
 * git root (since Claude Code merges hooks up the tree).
 */
export function uninstallAllClaudeHooks(cwd: string): boolean {
	let changed = false;

	// Clean hooks from cwd's .claude/settings.json
	changed = cleanClaudeHooksFromFile(getClaudeSettingsPath(cwd)) || changed;

	// Also clean hooks from the git root's .claude/settings.json
	const projectRoot = findProjectRoot(cwd);
	if (projectRoot && projectRoot !== cwd) {
		changed = cleanClaudeHooksFromFile(getClaudeSettingsPath(projectRoot)) || changed;
	}

	return changed;
}
