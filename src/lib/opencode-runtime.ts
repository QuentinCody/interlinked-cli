// Shared OpenCode v1 vs v2 process detection and user plugin path.
// Identity is provider-owned env only: OPENCODE2 or INTERLINKED_CLIENT.
// Argv / XDG substrings are not a security boundary.

import { homedir } from "node:os";
import { join } from "node:path";

export function isOpenCodeV2Env(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.INTERLINKED_CLIENT === "opencode2") return true;
	if (env.INTERLINKED_CLIENT === "opencode") return false;
	return Boolean(env.OPENCODE2);
}

/** User-scope OpenCode plugin directory: XDG_CONFIG_HOME/opencode/plugins, else ~/.config/opencode/plugins. */
export function opencodeUserPluginDir(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CONFIG_HOME;
	if (typeof xdg === "string" && xdg.length > 0) return join(xdg, "opencode", "plugins");
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	return join(home, ".config", "opencode", "plugins");
}

export function opencodeUserPluginRelPath(filename: string, env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CONFIG_HOME;
	if (typeof xdg === "string" && xdg.length > 0) return join(xdg, "opencode", "plugins", filename);
	return `~/.config/opencode/plugins/${filename}`;
}
