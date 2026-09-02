// ===========================================
// interlinked login — Authenticate with the server
// ===========================================
// Runs the OAuth PKCE flow (opens browser) or accepts a manual token.
// Saves credentials to .interlinked/config.local.json.

import { InterlinkedClient } from "../lib/api-client.js";
import { performLogin, saveLoginTokens } from "../lib/auth.js";
import {
	initConfig,
	isConfigured,
	readLocalConfig,
	resolveConfig,
	updateLocalConfig,
} from "../lib/config.js";
import { c } from "../lib/formatter.js";
import { ensureRemoteOnboarding, type RemoteOnboardingResult } from "../lib/onboarding.js";

interface LoginOptions {
	server?: string;
	token?: string;
}

function renderRemoteOnboarding(result: RemoteOnboardingResult): void {
	if (result.status === "linked") {
		const lifecycleTag = result.isNewAgent
			? "new"
			: result.reclaimedAgent
				? "reclaimed"
				: "existing";
		const workspace = result.workspaceName || "main";
		const handleLabel = result.agentHandle ? ` (${result.agentHandle})` : "";
		console.log(
			`  ${c.dim("Remote agent:")} ${c.green(`${result.agentName || "agent"} linked`)} ${c.dim(
				`[${workspace}/${lifecycleTag}]`,
			)}${c.dim(handleLabel)}`,
		);
		return;
	}

	if (result.status === "skipped" && result.reason === "agent_name_missing") {
		console.log(
			`  ${c.dim("Remote agent:")} ${c.yellow("skipped")} ${c.dim(
				"(set agent name: interlinked enable --agent <name>)",
			)}`,
		);
		return;
	}

	if (result.status === "skipped") {
		return;
	}

	console.log(
		`  ${c.dim("Remote agent:")} ${c.yellow("not linked")} ${c.dim(result.error || "bootstrap failed")}`,
	);
}

/**
 * Ensure a config exists, apply an explicit `--server` override, and return the
 * server URL the login flow should use.
 */
function resolveLoginServerUrl(options: LoginOptions, cwd: string): string {
	// Ensure config exists (at minimum, we need a server URL)
	if (!isConfigured(cwd)) {
		// Default to localhost; users configure their own remote via `--server`.
		const serverUrl = options.server || "http://localhost:8787";
		initConfig({ serverUrl }, cwd);
		console.log(`${c.green("Created")} .interlinked/config.json`);
		console.log(`  ${c.dim("Server:")} ${serverUrl}\n`);
	}

	// Resolve the server URL
	const config = resolveConfig(cwd);
	const serverUrl = options.server || config.server_url;

	// If --server was provided and differs from config, update
	if (options.server && options.server !== config.server_url) {
		initConfig({ serverUrl: options.server }, cwd);
		console.log(
			`${c.green("Updated")} Server URL to ${c.cyan(options.server)}\n`,
		);
	}

	return serverUrl;
}

/** Path 1: manual token injection (CI/headless). */
async function loginWithManualToken(
	token: string,
	serverUrl: string,
	cwd: string,
): Promise<void> {
	const manualToken = token.trim();
	if (!manualToken) {
		console.error(`\n${c.red("Invalid token.")} --token cannot be empty.`);
		process.exit(1);
	}

	try {
		const testClient = new InterlinkedClient({
			serverUrl,
			token: manualToken,
		});
		await testClient.callTool("health_check");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`\n${c.red("Token validation failed:")} ${message}`);
		console.error(c.dim("The token was not saved. Check the value and try again."));
		process.exit(1);
	}

	updateLocalConfig(
		{
			access_token: manualToken,
			refresh_token: undefined,
			token_expires_at: undefined,
			oauth_client_id: undefined,
		},
		cwd,
	);
	console.log(`${c.green("Saved")} manual token to .interlinked/config.local.json`);
	console.log(c.dim("Token source: --token flag (manual injection)"));
	const onboarding = await ensureRemoteOnboarding({
		serverUrl,
		token: manualToken,
	});
	renderRemoteOnboarding(onboarding);
	console.log(`\n${c.green("Authenticated.")} You can now use Interlinked CLI commands.`);
}

/**
 * Auto-select a default workspace after successful auth to remove manual setup
 * friction. Prefer owner workspace when available, otherwise first membership.
 * Never throws — login already succeeded; discovery is a bonus step.
 */
async function autoSelectWorkspace(
	serverUrl: string,
	accessToken: string,
	cwd: string,
): Promise<void> {
	try {
		const client = new InterlinkedClient({
			serverUrl,
			token: accessToken,
		});
		const workspaces = await client.fetchWorkspaces();
		const preferred = workspaces.find((w) => w.role === "owner") || workspaces[0];
		if (preferred?.id) {
			const local = readLocalConfig(cwd) || {};
			const activeServerKey = local.active_server || "production";
			if (local.servers?.[activeServerKey]) {
				const servers = {
					...local.servers,
					[activeServerKey]: {
						...local.servers[activeServerKey],
						workspace_id: preferred.id,
					},
				};
				updateLocalConfig({ workspace_id: preferred.id, servers }, cwd);
			} else {
				updateLocalConfig({ workspace_id: preferred.id }, cwd);
			}
		}
	} catch (_) {
		/* intentional: login already succeeded; workspace discovery is a bonus step */
	}
}

/** Print expiry + refresh-token lines for a freshly issued token pair. */
function printTokenLifetime(tokens: {
	expires_in?: number | undefined;
	refresh_token?: string | undefined;
}): void {
	if (tokens.expires_in) {
		const hours = Math.round(tokens.expires_in / 3600);
		if (hours > 0) {
			console.log(`  ${c.dim("Expires in:")}    ~${hours} hour(s)`);
		} else {
			const minutes = Math.round(tokens.expires_in / 60);
			console.log(`  ${c.dim("Expires in:")}    ~${minutes} minute(s)`);
		}
	}

	if (tokens.refresh_token) {
		console.log(`  ${c.dim("Refresh token:")} ${c.green("Yes")} (auto-renewal available)`);
	}
}

/** Path 2: OAuth PKCE flow (interactive). Throws on any login failure. */
async function loginWithOAuth(serverUrl: string, cwd: string): Promise<void> {
	const tokens = await performLogin(serverUrl);

	// Save tokens to local config
	saveLoginTokens(tokens, cwd);

	await autoSelectWorkspace(serverUrl, tokens.access_token, cwd);

	console.log(`\n${c.green("Authentication successful!")}`);
	console.log(`  ${c.dim("Token saved to:")} .interlinked/config.local.json`);

	printTokenLifetime(tokens);

	const resolvedAfterLogin = resolveConfig(cwd);
	if (resolvedAfterLogin.workspace_id) {
		console.log(
			`  ${c.dim("Workspace:")}    ${resolvedAfterLogin.workspace_id} (auto-selected)`,
		);
	}
	const onboarding = await ensureRemoteOnboarding({
		serverUrl,
		token: tokens.access_token,
	});
	renderRemoteOnboarding(onboarding);

	console.log(`\n${c.green("Ready.")} You can now use Interlinked CLI commands.`);
}

export async function loginCommand(options: LoginOptions): Promise<void> {
	const cwd = process.cwd();

	console.log(c.bold("Interlinked CLI — Login"));
	console.log(c.dim("─".repeat(40)));

	const serverUrl = resolveLoginServerUrl(options, cwd);

	// Path 1: Manual token injection (CI/headless)
	if (options.token) {
		await loginWithManualToken(options.token, serverUrl, cwd);
		return;
	}

	// Path 2: OAuth PKCE flow (interactive)
	console.log(`${c.dim("Server:")} ${serverUrl}`);
	console.log(c.dim("Starting OAuth PKCE flow...\n"));

	try {
		await loginWithOAuth(serverUrl, cwd);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		reportLoginFailure(message, serverUrl);
		console.error(c.dim("\nAlternative: use --token <token> for manual token injection."));
		process.exit(1);
	}
}

/**
 * Lookup table of error substrings to user-facing error reporters. Checked in
 * order; first match wins. Falls back to a generic message if no entry matches.
 */
const LOGIN_ERROR_REPORTERS: ReadonlyArray<{
	match: string;
	report: (message: string, serverUrl: string) => void;
}> = [
	{
		match: "timed out",
		report: () => {
			console.error(
				`\n${c.red("Login timed out.")} The browser flow was not completed within 5 minutes.`,
			);
			console.error(c.dim("Try again with: interlinked login"));
		},
	},
	{
		match: "CSRF",
		report: (message) => {
			console.error(`\n${c.red("Security error:")} ${message}`);
			console.error(c.dim("This may indicate a man-in-the-middle attack. Try again."));
		},
	},
	{
		match: "Client registration failed",
		report: (_message, serverUrl) => {
			console.error(`\n${c.red("Server error:")} Could not register OAuth client.`);
			console.error(c.dim(`Server: ${serverUrl}`));
			console.error(
				c.dim(
					"Check that the Server URL is correct and the server is running.",
				),
			);
		},
	},
	{
		match: "Token exchange failed",
		report: (message) => {
			console.error(`\n${c.red("Token exchange failed:")} ${message}`);
			console.error(c.dim("The authorization succeeded but token exchange failed."));
			console.error(c.dim("This may be a server-side issue. Try again."));
		},
	},
];

function reportLoginFailure(message: string, serverUrl: string): void {
	for (const { match, report } of LOGIN_ERROR_REPORTERS) {
		if (message.includes(match)) {
			report(message, serverUrl);
			return;
		}
	}
	console.error(`\n${c.red("Login failed:")} ${message}`);
}
