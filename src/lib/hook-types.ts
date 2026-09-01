// ===========================================
// Hook Types — Shared types + tiny helpers for hook modules
// ===========================================
// Narrow types and one small path helper shared between `hooks.ts` (public
// orchestrators) and `hook-installers.ts` (per-client install/uninstall
// implementations). Split out so neither module needs to import from the
// other — avoids a circular dependency between `hooks.ts` and the
// per-client installers.

import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { ClientName } from "./settings.js";

/**
 * Public API — consumed by `src/lib/hooks.ts`, `src/lib/hook-installers.ts`,
 * `src/commands/init.ts`, and tests.
 *
 * Walk up from `startDir` looking for a directory containing `.git/`.
 * Returns the project root path, or null if not found.
 * Kept here (in the types/shared module) to avoid a circular import between
 * `hooks.ts` and `hook-installers.ts`.
 */
export function findProjectRoot(startDir: string): string | null {
	let dir = startDir;
	const { root } = parse(dir);
	while (dir !== root) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	// Check the filesystem root too
	if (existsSync(join(root, ".git"))) {
		return root;
	}
	return null;
}

/**
 * Public API — consumed by `src/lib/hooks.ts`, `src/lib/hook-installers.ts`.
 *
 * Shape of a hook entry in a client's settings file (claude/gemini).
 * `matcher` is the tool-name pattern for scoped events (PostToolUse/AfterTool);
 * empty string means match-all.
 */
export interface HookEntry {
	matcher: string;
	/** `timeout` is Claude Code's per-hook ceiling in SECONDS (default 60). */
	hooks: Array<{
		type: string;
		command: string;
		timeout?: number;
		/** Codex may launch observation-only handlers without blocking the event. */
		async?: boolean;
		/** Codex renders this while the hook is running. */
		statusMessage?: string;
		/** Maximum model-visible `additionalContext` accepted from this hook. */
		additionalContextLimit?: number;
	}>;
}

/**
 * Public API — consumed by `src/commands/{enable,disable,init}.ts`, tests,
 * and `src/lib/hook-installers.ts`.
 *
 * Result of installing (or uninstalling) hooks into a single client.
 */
export interface InstallResult {
	client: ClientName;
	installed: boolean;
	events: string[];
	error?: string;
}

// Named constants for client identity comparisons. Kept out of conditionals
// as bare string literals to avoid `magic_literal_in_conditional` warnings.
/** Public API — consumed by `src/lib/hook-installers.ts`. */
export const CLIENT_CLAUDE = "claude" as const;
/** Public API — consumed by `src/lib/hook-installers.ts`. */
export const CLIENT_COPILOT = "copilot" as const;
/** Public API — consumed by `src/lib/hook-installers.ts`. */
export const CLIENT_GEMINI = "gemini" as const;
/** Public API — consumed by `src/lib/hook-installers.ts`. */
export const CLIENT_CODEX = "codex" as const;
/** Public API — consumed by `src/lib/hook-installers.ts`. */
export const CLIENT_CURSOR = "cursor" as const;
/** Public API — consumed by `src/lib/hook-installers.ts`. OpenCode v2 (`opencode2` binary). */
export const CLIENT_OPENCODE2 = "opencode2" as const;

/**
 * Public API — consumed by `src/lib/hook-installers.ts`.
 *
 * Marker embedded in every hook command we install. Used to find and
 * remove our own entries without touching user-installed hooks.
 */
export const INTERLINKED_MARKER = "interlinked-activity";
