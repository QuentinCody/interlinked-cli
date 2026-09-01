// ===========================================
// Client Discovery
// ===========================================
// Detects local AI coding clients and their settings locations.
// To add a new client (Amp, Kiro, etc.):
//   1. Add the name to ClientName
//   2. Add an entry to CLIENT_CONFIGS
//   3. Add a RunnerAdapter and capability description
//   4. Wire its lifecycle into CLIENT_INSTALL_REGISTRY in hooks.ts

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerId } from "../harness/unified-event.js";

export type ClientName =
	| "claude"
	| "copilot"
	| "gemini"
	| "codex"
	| "cursor"
	| "opencode"
	| "opencode2"
	| "pi";

interface ClientConfig {
	name: ClientName;
	label: string;
	configDir: string;
	settingsFile: string;
	inputMethod: "stdin" | "argv";
	/** Project-root files that prove the client is configured even before its
	 *  hook/plugin directory exists. */
	detectionFiles?: readonly string[];
	/** Provider-native environment markers for the currently running client. */
	detectFromEnv?: (env: NodeJS.ProcessEnv) => boolean;
}

/**
 * Registry of supported AI coding clients.
 * Each entry describes how the client stores settings and receives hook data.
 */
const CLIENT_CONFIGS: ClientConfig[] = [
	{
		name: "claude",
		label: "Claude Code",
		configDir: ".claude",
		settingsFile: "settings.json",
		inputMethod: "stdin",
	},
	{
		name: "copilot",
		label: "GitHub Copilot CLI",
		configDir: ".github/hooks",
		settingsFile: "hooks.json",
		inputMethod: "stdin",
	},
	{
		name: "gemini",
		label: "Google Gemini CLI",
		configDir: ".gemini",
		settingsFile: "settings.json",
		inputMethod: "stdin",
	},
	{
		name: "codex",
		label: "OpenAI Codex CLI",
		configDir: ".codex",
		settingsFile: "hooks.json",
		inputMethod: "stdin",
	},
	{
		name: "cursor",
		label: "Cursor IDE",
		// Cursor's hook config lives at `<project>/.cursor/hooks.json` (project
		// scope) and `~/.cursor/hooks.json` (user scope). We install at project
		// scope to match how the other clients work — global install is a
		// future enhancement gated on the user-config-tier wiring.
		configDir: ".cursor",
		settingsFile: "hooks.json",
		inputMethod: "stdin",
	},
	{
		name: "opencode",
		label: "OpenCode",
		// OpenCode auto-loads project-local JavaScript/TypeScript plugins from
		// `<project>/.opencode/plugins/`. The Interlinked bridge is an owned
		// plugin file rather than a settings.json fragment.
		configDir: ".opencode",
		settingsFile: "plugins/interlinked.ts",
		inputMethod: "stdin",
		detectionFiles: ["opencode.json", "opencode.jsonc"],
		detectFromEnv: (env) =>
			Object.entries(env).some(
				([name, value]) =>
					name.startsWith("OPENCODE") &&
					name !== "OPENCODE2" &&
					typeof value === "string" &&
					value.length > 0,
			),
	},
	{
		name: "opencode2",
		label: "OpenCode v2",
		configDir: ".opencode",
		settingsFile: "plugins/interlinked-opencode2.ts",
		inputMethod: "stdin",
		detectFromEnv: (env) =>
			Boolean(env.OPENCODE2) || env.INTERLINKED_CLIENT === "opencode2",
	},
	{
		name: "pi",
		label: "Pi",
		// Pi auto-loads project extensions from `<project>/.pi/extensions/`.
		// The generated extension forwards native events to the shared hook
		// entry point over stdin.
		configDir: ".pi",
		settingsFile: "extensions/interlinked.js",
		inputMethod: "stdin",
		detectFromEnv: (env) =>
			env.AI_AGENT?.trim().toLowerCase() === "pi" || Boolean(env.PI_CODING_AGENT),
	},
	// Future client shapes (documented for extension; NOT commented-out code —
	// each line below is an example of a ClientConfig entry you might add):
	//   Example: amp      → configDir: ".amp",      settingsFile: "settings.json", inputMethod: "stdin"
];

interface DetectedClient {
	name: ClientName;
	settingsPath: string;
	exists: boolean;
}

function getClientSettingsPath(cwd: string, client: ClientConfig): string {
	return join(cwd, client.configDir, client.settingsFile);
}

export function detectClients(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): DetectedClient[] {
	const v2Env = env.OPENCODE2 || env.INTERLINKED_CLIENT === "opencode2";
	return CLIENT_CONFIGS.map((config) => {
		const fromEnv = config.detectFromEnv?.(env) === true;
		const fromFiles =
			existsSync(join(cwd, config.configDir)) ||
			config.detectionFiles?.some((path) => existsSync(join(cwd, path))) === true;
		let exists = fromEnv || fromFiles;
		// `.opencode/` is shared. Directory presence is v1; v2 requires an explicit env/client signal.
		if (config.name === "opencode2") exists = fromEnv;
		if (config.name === "opencode" && v2Env) exists = fromEnv;
		return { name: config.name, settingsPath: getClientSettingsPath(cwd, config), exists };
	});
}

/** Maps a legacy `ClientName` id to the adapter `RunnerId` vocabulary. The two
 *  id sets diverge: the adapter layer uses `claude-code` / `copilot-cli` /
 *  `gemini-cli` where the legacy client layer uses `claude` / `copilot` /
 *  `gemini`. It lives HERE, beside the client registry it keys, so a caller
 *  that only needs the id translation does not have to import the hook
 *  INSTALLER — `enable`'s tests mock that module wholesale, which would make a
 *  pure lookup table un-importable at test time. */
export const CLIENT_TO_RUNNER: Record<ClientName, RunnerId> = {
	claude: "claude-code",
	copilot: "copilot-cli",
	gemini: "gemini-cli",
	codex: "codex",
	cursor: "cursor",
	opencode: "opencode",
	opencode2: "opencode2",
	pi: "pi",
};

/** One hook-config location per supported client, resolved against `cwd`.
 *
 *  Reporting surfaces (doctor) must read this rather than restate paths: the
 *  hardcoded copy in `doctor-checks.ts` had Codex pointing at
 *  `.codex/config.toml` — which only carries the `[features] hooks = true`
 *  flag, never the hook commands — so doctor warned that every CORRECT Codex
 *  install was missing its hooks, and told the user to re-run a command that
 *  could not change the outcome. Same class as audit F3; the cure is one
 *  source of truth, not a second correction. */
export function clientHookTargets(cwd: string): Array<{
	name: ClientName;
	label: string;
	configDir: string;
	settingsPath: string;
}> {
	return CLIENT_CONFIGS.map((config) => ({
		name: config.name,
		label: config.label,
		configDir: join(cwd, config.configDir),
		settingsPath: getClientSettingsPath(cwd, config),
	}));
}
