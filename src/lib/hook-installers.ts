// ===========================================
// Hook Installers — Per-Client install/uninstall barrel
// ===========================================
// Per-client hook installation logic for Claude Code, GitHub Copilot CLI,
// Gemini CLI, OpenAI Codex CLI, and Cursor IDE. The public `installAllHooks`
// / `uninstallAllHooks` orchestrators in `./hooks.ts` delegate to the
// functions re-exported here.
//
// This module was decomposed from a single 1250-line file into per-client
// siblings (`hook-installers-<client>.ts`) plus a shared-helpers module
// (`hook-installers-shared.ts`) and the cross-client statusline installer
// (`hook-installers-statusline.ts`). It now re-exports every public symbol
// so `CLIENT_INSTALL_REGISTRY` in `hooks.ts` and all importers/tests are
// unchanged. New per-client logic goes in the relevant sibling; shared
// machinery (JSON I/O, hook-entry upsert, shell command builder) goes in
// `hook-installers-shared.ts`.


// Claude Code.
export {
	CLAUDE_HOOK_EVENTS,
	installAllClaudeHooks,
	uninstallAllClaudeHooks,
} from "./hook-installers-claude.js";
// OpenAI Codex CLI.
export {
	CODEX_HOOK_EVENTS,
	installCodexHooks,
	uninstallCodexHooks,
} from "./hook-installers-codex.js";
// GitHub Copilot CLI.
export {
	COPILOT_HOOK_EVENTS,
	installCopilotHooks,
	uninstallCopilotHooks,
} from "./hook-installers-copilot.js";
// Cursor IDE.
export {
	CURSOR_FAIL_CLOSED_EVENTS,
	CURSOR_HOOK_EVENTS,
	installCursorHooks,
	uninstallCursorHooks,
} from "./hook-installers-cursor.js";

// Gemini CLI.
export {
	GEMINI_HOOK_EVENTS,
	installGeminiHooks,
	uninstallGeminiHooks,
} from "./hook-installers-gemini.js";
// OpenCode v2 (`opencode2` binary) — JS plugin, distinct from the v1 TS bridge.
export {
	OPENCODE2_HOOK_EVENTS,
	installOpencode2Hooks,
	uninstallOpencode2Hooks,
} from "./hook-installers-opencode.js";
// Shared helpers (also public API for `hooks.ts` and the Claude installer).
export { findParentWithHooks } from "./hook-installers-shared.js";
// Cross-client statusline installer.
export { installStatusLine } from "./hook-installers-statusline.js";
