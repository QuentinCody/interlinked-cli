// ===========================================
// interlinked logout — Clear authentication credentials
// ===========================================
// Removes tokens from config.local.json without destroying
// other config (agent name, workspace, sync mode, etc.).

import {
	isConfigured,
	type LocalConfig,
	readLocalConfig,
	updateLocalConfig,
} from "../lib/config.js";
import { c } from "../lib/formatter.js";

interface LogoutOptions {
	all?: boolean;
	json?: boolean;
}

function printSimpleStatus(json: boolean | undefined, jsonStatus: string, textMessage: string): void {
	if (json) {
		console.log(JSON.stringify({ status: jsonStatus }));
	} else {
		console.log(c.dim(textMessage));
	}
}

interface ClearedFlags {
	hadToken: boolean;
	hadRefresh: boolean;
	hadOauth: boolean;
	hadHandle: boolean;
}

function printJsonLoggedOut(options: LogoutOptions, flags: ClearedFlags): void {
	console.log(
		JSON.stringify({
			status: "logged_out",
			cleared: {
				access_token: flags.hadToken,
				refresh_token: flags.hadRefresh,
				oauth_client_id: flags.hadOauth,
				agent_handle: options.all && flags.hadHandle,
			},
		}),
	);
}

function printTextLoggedOut(options: LogoutOptions, flags: ClearedFlags): void {
	console.log(c.bold("Interlinked CLI — Logout"));
	console.log(c.dim("─".repeat(40)));

	if (flags.hadToken) console.log(`  ${c.green("Cleared")} access token`);
	if (flags.hadRefresh) console.log(`  ${c.green("Cleared")} refresh token`);
	if (flags.hadOauth) console.log(`  ${c.green("Cleared")} OAuth client ID`);
	if (options.all && flags.hadHandle) {
		console.log(`  ${c.green("Cleared")} agent handle`);
		console.log(c.dim("\n  Agent handle cleared. Re-registration required on next login."));
	}

	console.log(`\n${c.green("Logged out.")} Config preserved at .interlinked/config.local.json`);
	console.log(c.dim("To re-authenticate: interlinked login"));
}

export async function logoutCommand(options: LogoutOptions): Promise<void> {
	const cwd = process.cwd();

	if (!isConfigured(cwd)) {
		printSimpleStatus(options.json, "not_configured", "Not configured. Nothing to log out from.");
		return;
	}

	const local = readLocalConfig(cwd);
	if (!local) {
		printSimpleStatus(options.json, "no_credentials", "No local config found. Nothing to log out from.");
		return;
	}

	const flags: ClearedFlags = {
		hadToken: !!local.access_token,
		hadRefresh: !!local.refresh_token,
		hadOauth: !!local.oauth_client_id,
		hadHandle: !!local.agent_handle,
	};

	if (!flags.hadToken && !flags.hadRefresh && !flags.hadOauth) {
		printSimpleStatus(options.json, "no_credentials", "No credentials found in config. Already logged out.");
		return;
	}

	// Clear auth-related fields
	const updates: Partial<LocalConfig> = {
		access_token: undefined,
		refresh_token: undefined,
		token_expires_at: undefined,
		oauth_client_id: undefined,
	};

	// --all also clears agent handle (requires re-registration)
	if (options.all) {
		updates.agent_handle = undefined;
	}

	updateLocalConfig(updates, cwd);

	if (options.json) {
		printJsonLoggedOut(options, flags);
		return;
	}

	printTextLoggedOut(options, flags);
}
