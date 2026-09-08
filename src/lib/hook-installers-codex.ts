// ===========================================
// OpenAI Codex CLI — Install/Uninstall
// ===========================================
// Codex's `.codex/hooks.json` shape is identical to Claude Code's
// `.claude/settings.json` `hooks` field: `{ matcher, hooks: [{ type, command }] }`
// per event. Hooks are gated behind a feature flag in `.codex/config.toml`
// (`[features] hooks = true`; legacy `codex_hooks` auto-migrated); we add it
// idempotently when missing so `interlinked enable` is a one-step setup.

import { join } from "node:path";
import {
	CODEX_CAPABILITIES,
	eventCapability,
	installedEventNames,
} from "../harness/adapters/provider-capabilities.js";
import { ensureCodexFeatureFlag as ensureCodexFlag } from "./codex-feature-flag.js";
import {
	buildHookCommand,
	cleanJsonHookFile,
	hookSettingsObject,
	installHookEntry,
	readJsonFile,
	writeJsonFile,
} from "./hook-installers-shared.js";
import { CLIENT_CODEX } from "./hook-types.js";

// One provider capability catalog drives both the adapter installer and this
// established `interlinked enable` path. Keeping a second handwritten event
// list here previously left Codex six events behind its native surface.
/** Public API — consumed by `src/lib/hooks.ts`. */
export const CODEX_HOOK_EVENTS = installedEventNames(CODEX_CAPABILITIES);

function getCodexHooksPath(cwd: string): string {
	return join(cwd, ".codex", "hooks.json");
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Install Interlinked hooks into Codex CLI's `.codex/hooks.json` and ensure
 * `[features] hooks = true` is set in `.codex/config.toml` (gating feature
 * flag — without it Codex silently ignores hooks.json; legacy `codex_hooks`
 * key still recognized but auto-migrated). Feature-flag logic lives in
 * `./codex-feature-flag.ts` and is also called from the modern adapter's
 * `postInstall` so both install paths are equivalent.
 */
export function installCodexHooks(cwd: string, hookScriptPath: string): void {
	const settingsPath = getCodexHooksPath(cwd);
	const settings = readJsonFile(settingsPath) || {};

	const hooks = hookSettingsObject(settings);
	const hookCommand = buildHookCommand(hookScriptPath, CLIENT_CODEX);

	for (const eventName of CODEX_HOOK_EVENTS) {
		installHookEntry(hooks, eventName, hookCommand, codexHookOptions(eventName));
	}

	writeJsonFile(settingsPath, settings);
	// `"refused"` (duplicate [features] tables) is a FAILURE: Codex rejects the
	// whole TOML and no hook fires. Throw so the legacy install path cannot
	// report success over an inert install (Grok 2026-08-28 issue 5).
	if (ensureCodexFlag(cwd) === "refused") {
		throw new Error(
			".codex/config.toml has duplicate [features] tables — Codex rejects the whole file, so hooks cannot fire. Merge the duplicate tables, then re-run enable.",
		);
	}
}

function codexHookOptions(eventName: string): {
	timeout?: number;
	async?: boolean;
	statusMessage: string;
	additionalContextLimit?: number;
} {
	const capability = eventCapability(CODEX_CAPABILITIES, eventName);
	return {
		...(eventName === "SessionEnd" ? { timeout: 3 } : {}),
		...(capability?.background ? { async: true } : {}),
		statusMessage: codexStatusMessage(eventName),
		...(capability?.model_context ? { additionalContextLimit: 2_500 } : {}),
	};
}

function codexStatusMessage(eventName: string): string {
	if (eventName === "PreToolUse" || eventName === "PermissionRequest") {
		return "Interlinked policy check";
	}
	if (eventName === "PostToolUse") return "Interlinked quality review";
	return "Interlinked lifecycle check";
}

/**
 * Public API — consumed by `src/lib/hooks.ts` (registered in CLIENT_INSTALL_REGISTRY).
 * Remove Interlinked hooks from Codex CLI settings. Leaves `.codex/config.toml`
 * untouched — disabling hooks is reversible by removing the flag manually,
 * and we don't want to clobber user-managed Codex configuration.
 */
export function uninstallCodexHooks(cwd: string): boolean {
	return cleanJsonHookFile(getCodexHooksPath(cwd));
}
