// ===========================================
// GitHub Copilot CLI — Install/Uninstall
// ===========================================
// Per-client hook installation for GitHub Copilot CLI's
// `.github/hooks/hooks.json`. Copilot's entry shape is a flat
// `{ type, bash }` object keyed by camelCase event name.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHookCommand, hookEventEntries, isPlainObject } from "./hook-installers-shared.js";
import { isInterlinkedHookEntry } from "./hook-ownership.js";
import { CLIENT_COPILOT, INTERLINKED_MARKER } from "./hook-types.js";
import type { JsonObject } from "./json-types.js";

// GitHub Copilot CLI hook events (camelCase — Copilot convention)
/** Public API — consumed by `src/lib/hooks.ts`. */
export const COPILOT_HOOK_EVENTS = [
	"sessionStart",
	"sessionEnd",
	"userPromptSubmitted",
	"preToolUse",
	"postToolUse",
	"errorOccurred",
] as const;

function getCopilotHooksPath(cwd: string): string {
	return join(cwd, ".github", "hooks", "hooks.json");
}

// Narrow shape of the Copilot hooks.json we read/write.
interface CopilotConfig {
	version: number;
	hooks: JsonObject;
}

/**
 * Schema parser for Copilot hooks.json — kept separate from the file read
 * so cold readers can see exactly which fields we trust at the JSON
 * boundary. Returns null for any shape that isn't a plain object; coerces
 * a missing/non-object `hooks` to an empty record.
 */
function parseCopilotConfigShape(raw: unknown): CopilotConfig | null {
	if (!isPlainObject(raw)) return null;
	const hooks = isPlainObject(raw.hooks) ? raw.hooks : {};
	return { version: 1, hooks };
}

function safeReadCopilotConfig(path: string): CopilotConfig | null {
	if (!existsSync(path)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		/* intentional: malformed hooks.json — caller starts over */
		return null;
	}
	return parseCopilotConfigShape(raw);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into GitHub Copilot CLI's `.github/hooks/hooks.json`.
 */
export function installCopilotHooks(cwd: string, hookScriptPath: string): void {
	const hooksPath = getCopilotHooksPath(cwd);
	const dir = dirname(hooksPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_COPILOT);

	// Read existing config or start fresh
	const config = safeReadCopilotConfig(hooksPath) || { version: 1, hooks: {} };

	for (const eventName of COPILOT_HOOK_EVENTS) {
		const entries = hookEventEntries(config.hooks, eventName);

		// Check if already installed — update if stale
		const existing = entries.filter(isPlainObject).find((entry) =>
			typeof entry.bash === "string" && entry.bash.includes(INTERLINKED_MARKER));
		if (existing) {
			if (existing.bash !== hookCommand) {
				existing.bash = hookCommand;
			}
			continue;
		}

		entries.push({
			type: "command",
			bash: hookCommand,
		});
	}

	config.version = 1;
	writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Copilot CLI's hooks.json. Deletes the file
 * entirely if no other hooks remain.
 */
export function uninstallCopilotHooks(cwd: string): boolean {
	const hooksPath = getCopilotHooksPath(cwd);
	const config = safeReadCopilotConfig(hooksPath);
	if (!config?.hooks) return false;

	let changed = false;
	for (const eventName of Object.keys(config.hooks)) {
		const entries = config.hooks[eventName];
		if (!Array.isArray(entries)) continue;

		const filtered = entries.filter((e) => !isInterlinkedHookEntry(e));
		if (filtered.length !== entries.length) {
			config.hooks[eventName] = filtered.length > 0 ? filtered : [];
			changed = true;
		}
	}

	if (changed) {
		// Remove file entirely if no hooks remain
		const hasHooks = Object.values(config.hooks).some(
			(arr) => Array.isArray(arr) && arr.length > 0,
		);
		if (!hasHooks) {
			rmSync(hooksPath, { force: true });
		} else {
			writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
		}
	}

	return changed;
}
