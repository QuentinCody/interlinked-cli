// ===========================================
// Hook Management — orchestration only
// ===========================================
// Public surface for hook lifecycle: write the generated `.mjs` script,
// install/uninstall it into each detected client, manage `.gitignore`,
// and detect colocated git-hook managers.
//
// JSON-settings client cleanup lives in `./hook-installers.ts`; managed
// plugin/extension clients use the adapter installer manifest below. This
// module orchestrates both lifecycle shapes through CLIENT_INSTALL_REGISTRY.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	installedEventNames as installedCapabilityEventNames,
	OPENCODE_CAPABILITIES,
	PI_CAPABILITIES,
} from "../harness/adapters/provider-capabilities.js";
import {
	installHooks,
	installedEventsFor,
	manifestPath,
	readManifest,
	uninstallHooks as uninstallInstalledHooks,
} from "../harness/installer.js";
import {
	getModePreset,
	type HarnessModePreset,
	migrateLegacyMode,
	QUALITY_MODE,
} from "../harness/rules/modes.js";
import type { RunnerId } from "../harness/unified-event.js";
import { readSharedConfig } from "./config.js";
import {
	CLAUDE_HOOK_EVENTS,
	CODEX_HOOK_EVENTS,
	COPILOT_HOOK_EVENTS,
	CURSOR_HOOK_EVENTS,
	findParentWithHooks,
	GEMINI_HOOK_EVENTS,
	installStatusLine as installStatusLineImpl,
	uninstallAllClaudeHooks,
	uninstallCodexHooks,
	uninstallCopilotHooks,
	uninstallCursorHooks,
	uninstallGeminiHooks,
	OPENCODE2_HOOK_EVENTS,
	uninstallOpencode2Hooks,
} from "./hook-installers.js";
import { fileURLToPath } from "node:url";
import { detectHookManagers, type HookManagerInfo } from "./hook-manager-detection.js";
import { CLIENT_CLAUDE } from "./hook-types.js";
import { HOOK_SCRIPT_VERSION } from "./hook-version.js";
import { buildHookScript } from "./hooks-template.js";
import { nonNull } from "./non-null.js";
import { type ClientName, CLIENT_TO_RUNNER } from "./settings.js";

export { findProjectRoot } from "./hook-types.js";
export { ensureGitignore } from "./hooks-gitignore.js";
export { detectHookManagers, type HookManagerInfo };

/**
 * Public API — consumed by `src/commands/enable.ts`.
 * Write the statusline script and configure it in user-level settings for
 * clients that support it (Claude Code, Copilot CLI). Returns the path to
 * the script, or null if no clients were configured.
 *
 * Thin wrapper over `installStatusLineImpl` from `./hook-installers.ts` so
 * the dependency between modules is explicit (the dead-export check
 * doesn't follow bare `export { ... } from` re-exports as usages).
 */
export function installStatusLine(clients: ClientName[]): string | null {
	return installStatusLineImpl(clients);
}

// Hook script version — ONE source of truth, resolved by `hook-version.ts`,
// which walks ancestors looking for the package.json whose `name` is actually
// `interlinked-cli`.
//
// The duplicate implementation that lived here read
// `new URL("../../package.json", import.meta.url)` directly. In the dev tree
// that happens to hit the repo's own package.json, which is why it looked
// correct — but after bundling, `dist/index.js` makes `../../package.json`
// resolve to the parent of the REPO (a user's home directory, or a containing
// monorepo). On this machine that file exists and declares version 1.0.0, so
// the BUILT CLI told every user their 0.1.0 hook was stale against an
// "expected" 1.0.0 that came from an unrelated package — and `enable` stamped
// that foreign version into the generated hook. `hook-version.ts` was written
// to fix exactly this and even documents it; this module simply never adopted
// it. Re-exported so existing importers are unaffected.
export { HOOK_SCRIPT_VERSION };

// ===========================================
// Path Helpers
// ===========================================

/**
 * Get the path to the hook script inside .interlinked/hooks/.
 */
export function getHookScriptPath(cwd: string): string {
	return join(cwd, ".interlinked", "hooks", "interlinked-activity.mjs");
}

// ===========================================
// Hook Script Generation
// ===========================================

/**
 * Resolve the operational tier preset (budget / quality / ci) for the
 * generated hook. Reads `.interlinked/config.json`'s `mode` field, applies
 * legacy migration (`balanced` → `budget` on Copilot CLI / `quality`
 * elsewhere) using the active runner from installer-manifest.json, and
 * defaults to QUALITY_MODE when nothing is configured. Phase C; see
 * src/harness/rules/modes.ts for the preset definitions.
 */
function resolveHarnessModePreset(cwd: string): HarnessModePreset {
	const shared = readSharedConfig(cwd);
	const rawMode = typeof shared?.mode === "string" ? shared.mode : undefined;
	let activeRunner: string | undefined;
	const mfPath = manifestPath(cwd);
	if (existsSync(mfPath)) {
		const entries = readManifest(mfPath);
		activeRunner = entries.length > 0 ? nonNull(entries[0]).runner : undefined;
	}
	const resolved = migrateLegacyMode(rawMode, activeRunner);
	return getModePreset(resolved);
}

/**
 * Write the universal hook script to .interlinked/hooks/interlinked-activity.mjs.
 * This script reads config from .interlinked/config.local.json and
 * normalizes events from any supported AI coding client.
 *
 * Bakes the active harness mode's `HARNESS_POST_TIMEOUT_MS` literal into
 * the generated .mjs so subsequent edits to `.interlinked/config.json`'s
 * `mode` field require re-rendering this file (typically via
 * `interlinked harness mode <name>`).
 */
export function writeHookScript(cwd: string): string {
	const scriptPath = getHookScriptPath(cwd);
	const hookDir = dirname(scriptPath);
	if (!existsSync(hookDir)) {
		mkdirSync(hookDir, { recursive: true });
	}

	const preset = resolveHarnessModePreset(cwd);
	// Default to QUALITY_MODE if resolveHarnessModePreset somehow returned
	// undefined (it shouldn't — getModePreset throws on unknown). The
	// fallback keeps the generated script renderable on a brand-new install
	// before any config file has been written.
	const activePreset = preset ?? QUALITY_MODE;
	// Bake the mode name into the version string so the
	// `interlinked-hook-version: <v>` sentinel embedded in the .mjs visibly
	// changes when the user toggles `interlinked harness mode budget|quality|ci`.
	// Without this, out-of-band staleness checks (e.g., `interlinked doctor`,
	// re-runs of `interlinked enable`) read the unchanged version literal and
	// skip the rewrite — leaving the .mjs's `HARNESS_POST_TIMEOUT_MS` baked
	// at the previous mode's value. (`harnessModeCommand` writes directly so
	// the mode-toggle path is unaffected; this guards every other rewrite path.)
	const versioned = `${HOOK_SCRIPT_VERSION}+mode-${activePreset.name}`;
	const script = buildHookScript(versioned, activePreset);

	writeFileSync(scriptPath, script);
	chmodSync(scriptPath, 0o755);
	return scriptPath;
}

/**
 * Delete the hook script from .interlinked/hooks/.
 */
export function deleteHookScript(cwd: string): boolean {
	const scriptPath = getHookScriptPath(cwd);
	if (existsSync(scriptPath)) {
		unlinkSync(scriptPath);
		return true;
	}
	return false;
}

/**
 * Delete the entire .interlinked/ directory.
 */
export function deleteConfigDir(cwd: string): boolean {
	const configDir = join(cwd, ".interlinked");
	if (existsSync(configDir)) {
		rmSync(configDir, { recursive: true, force: true });
		return true;
	}
	return false;
}

// ===========================================
// Hook Binary Resolution
// ===========================================

/**
 * Resolve the hook binary that installed hooks should invoke. The canonical
 * binary is the compiled adapter hook; the generated self-contained `.mjs` is
 * the fallback for unbuilt source checkouts. Priority:
 *   1. `.interlinked/hooks/interlinked-hook` — a project-local compiled override
 *   2. the packaged `hook-entry.js` bundled beside `dist/index.js`
 *   3. the generated `.mjs` (written on demand when `writeFallback` is set)
 * The returned path always exists on disk.
 *
 * Public API — consumed by `src/commands/install-hooks.ts` and `installAllHooks`.
 */
export function resolveHookBinaryPath(
	cwd: string,
	opts: { writeFallback?: boolean; packagedPath?: () => string | null } = {},
): string {
	const compiled = join(cwd, ".interlinked", "hooks", "interlinked-hook");
	if (existsSync(compiled)) return compiled;
	// `packagedPath` is a seam for the UNBUILT-checkout case. Since the probe
	// became module-relative (correctly — see `packagedHookEntryPath`), a test
	// running inside this repo can no longer make `dist/` absent by
	// manipulating argv, and "what happens with no build" is a real branch that
	// must stay covered.
	const packaged = (opts.packagedPath ?? packagedHookEntryPath)();
	if (packaged && existsSync(packaged)) return packaged;
	const legacy = getHookScriptPath(cwd);
	if (existsSync(legacy)) return legacy;
	const writeFallback = opts.writeFallback ?? true;
	return writeFallback ? writeHookScript(cwd) : legacy;
}

/**
 * Locate the packaged `hook-entry.js`.
 *
 * TWO probes, because `process.argv[1]` answers "how was the CLI invoked",
 * not "is a packaged hook available" — and only the second question matters.
 * Running a BUILT checkout through tsx (`npx tsx src/index.ts enable`) made
 * the argv probe look for `src/hook-entry.js`, miss, and fall through to the
 * generated `.mjs` — the branch documented above as "the fallback for unbuilt
 * source checkouts" — even though `dist/hook-entry.js` existed. That silently
 * installed the legacy runtime, which is directly observable afterwards: the
 * `.mjs` connects to `harness.sock` while `hook-entry.ts` prefers
 * `harness-default.sock`, so every install done this way produced raw events
 * and a framed event count stuck at zero.
 *
 * The module-relative probe is the reliable one (this file ships beside the
 * bundle), and it keeps a genuinely unbuilt checkout on the `.mjs` fallback
 * because there is no `dist/` to find.
 */
function packagedHookEntryPath(): string | null {
	const invoked = process.argv[1];
	if (invoked) {
		try {
			const candidate = join(dirname(realpathSync(invoked)), "hook-entry.js");
			if (existsSync(candidate)) return candidate;
		} catch {
			/* intentional: argv[1] unreadable — fall through to the module probe */
		}
	}
	// Module-relative: `src/lib/hooks.ts` → `<repo>/dist/hook-entry.js`, and
	// bundled `dist/chunk-*.js` → `<pkg>/dist/hook-entry.js`. Both layouts are
	// covered by trying one and two levels up.
	for (const rel of ["../../dist/hook-entry.js", "../dist/hook-entry.js", "./hook-entry.js"]) {
		try {
			const candidate = fileURLToPath(new URL(rel, import.meta.url));
			if (existsSync(candidate)) return candidate;
		} catch {
			/* intentional: unresolvable URL — try the next layout */
		}
	}
	return null;
}

// ===========================================
// Hook Installation — All Clients
// ===========================================

interface InstallResult {
	client: ClientName;
	installed: boolean;
	events: string[];
	error?: string;
}

interface ClientInstallEntry {
	events: readonly string[];
	uninstall: (cwd: string) => boolean;
}

type ManagedClientRunner = "opencode" | "pi";
const OPENCODE_HOOK_EVENTS = installedCapabilityEventNames(OPENCODE_CAPABILITIES);
const PI_HOOK_EVENTS = installedCapabilityEventNames(PI_CAPABILITIES);

/** Managed provider bridges have no legacy settings-file cleanup path. Their
 * install and ownership hashes live in the canonical installer manifest, so
 * lifecycle removal must go through that same hash-aware uninstaller. */
function uninstallManagedClientHooks(cwd: string, runner: ManagedClientRunner): boolean {
	const result = uninstallInstalledHooks({ cwd, runners: [runner] });
	const preserved = result.remaining.find((entry) => entry.runner === runner);
	if (preserved !== undefined) {
		throw new Error(`managed bridge was modified; preserved ${preserved.settings_path} and its installer manifest row`);
	}
	return result.removed.some((entry) => entry.runner === runner);
}

/**
 * Per-client install/uninstall registry. The single source of truth for the
 * clients Interlinked knows how to wire up — their event lists and uninstall
 * closures.
 *
 * Installation always uses the adapter installer (`installHooks` in
 * `src/harness/installer.ts`), reached via `installAllHooks` below. JSON-based
 * legacy clients retain their recognizer-based cleanup functions; managed
 * plugin/extension clients use the manifest's hash-aware uninstaller.
 */
const CLIENT_INSTALL_REGISTRY: Record<ClientName, ClientInstallEntry> = {
	claude: {
		events: CLAUDE_HOOK_EVENTS,
		uninstall: uninstallAllClaudeHooks,
	},
	copilot: {
		events: COPILOT_HOOK_EVENTS,
		uninstall: uninstallCopilotHooks,
	},
	gemini: {
		events: GEMINI_HOOK_EVENTS,
		uninstall: uninstallGeminiHooks,
	},
	codex: {
		events: CODEX_HOOK_EVENTS,
		uninstall: uninstallCodexHooks,
	},
	cursor: {
		events: CURSOR_HOOK_EVENTS,
		uninstall: uninstallCursorHooks,
	},
	opencode: {
		events: OPENCODE_HOOK_EVENTS,
		uninstall: (cwd) => uninstallManagedClientHooks(cwd, "opencode"),
	},
	opencode2: {
		events: OPENCODE2_HOOK_EVENTS,
		uninstall: uninstallOpencode2Hooks,
	},
	pi: {
		events: PI_HOOK_EVENTS,
		uninstall: (cwd) => uninstallManagedClientHooks(cwd, "pi"),
	},
};

// The ClientName → RunnerId table now lives beside the client registry in
// `settings.ts`; `installAllHooks` translates through it before calling the
// adapter installer. Re-exported here for existing importers.
export { CLIENT_TO_RUNNER };

/**
 * Install hooks into all specified clients.
 *
 * Routes through the adapter installer (`installHooks` in
 * `src/harness/installer.ts`) — the canonical install path. That installer is
 * idempotent: it purges any prior Interlinked registration (legacy `.mjs` or
 * adapter) before inserting one canonical entry, so re-running `enable` never
 * stacks duplicates. The generated `.mjs` is kept only as the binary fallback
 * for unbuilt source checkouts (see `resolveHookBinaryPath`).
 *
 * Claude Code merges hooks from every `.claude/settings.json` up the directory
 * tree, so installing into a nested checkout when an ancestor already has hooks
 * would double-fire the harness — that client is skipped with a pointer to the
 * ancestor.
 */
export function installAllHooks(cwd: string, clients: ClientName[]): InstallResult[] {
	const binaryPath = resolveHookBinaryPath(cwd);
	const skipReason = new Map<ClientName, string>();
	const runners: RunnerId[] = [];

	for (const client of clients) {
		const entry = CLIENT_INSTALL_REGISTRY[client];
		if (!entry) {
			skipReason.set(client, `Unknown client: ${client}`);
			continue;
		}
		if (client === CLIENT_CLAUDE) {
			const ancestor = findParentWithHooks(cwd, join(".claude", "settings.json"));
			if (ancestor) {
				skipReason.set(
					client,
					`hooks already installed at ${ancestor}/.claude/settings.json — run \`interlinked enable\` from there`,
				);
				continue;
			}
		}
		runners.push(CLIENT_TO_RUNNER[client]);
	}

	const installed =
		runners.length > 0 ? installHooks({ cwd, binaryPath, runners, scope: "project" }) : null;

	return clients.map((client) => {
		const skip = skipReason.get(client);
		if (skip) return { client, installed: false, events: [], error: skip };
		const runner = CLIENT_TO_RUNNER[client];
		// `post_install === "failed"` is NOT an install: Codex ignores the hooks.json this run merged until `[features] hooks = true` reaches its config.toml, so reporting success would describe a runner that fires no hooks.
		const entry = installed?.entries.find((e) => e.runner === runner);
		// Adapter events, never the legacy list — see installedEventsFor (2026-08-28 P1).
		if (entry?.post_install === "ok") return { client, installed: true, events: installedEventsFor(runner) };
		const reason = entry?.post_install_error ?? installed?.skipped.find((s) => s.runner === runner)?.reason;
		return { client, installed: false, events: [], error: reason ?? "install failed" };
	});
}

/**
 * Uninstall hooks from all specified clients.
 * Uses CLIENT_INSTALL_REGISTRY — add new clients there, not here.
 */
export function uninstallAllHooks(cwd: string, clients: ClientName[]): InstallResult[] {
	return clients.map((client) => {
		const entry = CLIENT_INSTALL_REGISTRY[client];
		if (!entry) {
			return { client, installed: false, events: [], error: `Unknown client: ${client}` };
		}
		try {
			const removed = entry.uninstall(cwd);
			return { client, installed: false, events: removed ? [...entry.events] : [] };
		} catch (e) {
			return {
				client,
				installed: false,
				events: [],
				error: e instanceof Error ? e.message : String(e),
			};
		}
	});
}
