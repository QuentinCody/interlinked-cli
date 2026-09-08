// ===========================================
// Gemini CLI — Install/Uninstall
// ===========================================
// Per-client hook installation for Gemini CLI's `.gemini/settings.json`.
// Gemini's entry shape matches Claude's `{ matcher, hooks: [...] }` form,
// so install/uninstall reuse the shared `installHookEntry` / `cleanJsonHookFile`.

import { join } from "node:path";
import {
	buildHookCommand,
	cleanJsonHookFile,
	installHookEntry,
	isPlainObject,
	readJsonFile,
	writeJsonFile,
} from "./hook-installers-shared.js";
import { CLIENT_GEMINI } from "./hook-types.js";

// Gemini CLI hook events (official hooks API, project/user settings.json).
// Keep to the high-signal lifecycle + tool events that Interlinked currently
// understands well. Skip model-level hooks to avoid noisy per-request traffic.
/** Public API — consumed by `src/lib/hooks.ts`. */
export const GEMINI_HOOK_EVENTS = [
	"SessionStart",
	"SessionEnd",
	"BeforeAgent",
	"AfterAgent",
	"BeforeTool",
	"AfterTool",
	"PreCompress",
	"Notification",
] as const;

function getGeminiSettingsPath(cwd: string): string {
	return join(cwd, ".gemini", "settings.json");
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Gemini CLI's `.gemini/settings.json`.
 */
export function installGeminiHooks(cwd: string, hookScriptPath: string): void {
	const settingsPath = getGeminiSettingsPath(cwd);
	const settings = readJsonFile(settingsPath) || {};

	const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
	settings.hooks = hooks;
	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_GEMINI);

	for (const eventName of GEMINI_HOOK_EVENTS) {
		installHookEntry(hooks, eventName, hookCommand);
	}

	writeJsonFile(settingsPath, settings);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Gemini CLI settings.
 */
export function uninstallGeminiHooks(cwd: string): boolean {
	return cleanJsonHookFile(getGeminiSettingsPath(cwd));
}
