// ===========================================
// Authentication — OAuth PKCE + Token Resolution
// ===========================================
// CLI's own OAuth flow + fallback to Claude Code credentials.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { matchCredByPrefix, matchCredByServerName } from "./auth-cred-match.js";
import { resolveConfig, updateLocalConfig } from "./config.js";
import type { JsonObject } from "./json-types.js";

/**
 * Timeout for OAuth control-plane HTTP calls (token refresh, code exchange,
 * dynamic client registration), in milliseconds. Bounds a slow or hung
 * auth-server so the request handle can't leak indefinitely.
 */
const OAUTH_REQUEST_TIMEOUT_MS = 30000;

// ===========================================
// Token Resolution (multi-source)
// ===========================================

/**
 * Resolve an auth token for API calls.
 * Priority:
 * 1. CLI's own token from .interlinked/config.local.json
 * 2. Claude Code token from ~/.claude/.credentials.json
 * Returns null if no token available.
 */
export function resolveAuthToken(cwd?: string): string | null {
	const config = resolveConfig(cwd);

	// 1. CLI's own token
	if (config.access_token) {
		// Check expiry
		if (config.token_expires_at) {
			const expires = new Date(config.token_expires_at);
			if (expires > new Date()) {
				return config.access_token;
			}
			// Token expired — could try refresh, but fall through to fallback
		} else {
			return config.access_token;
		}
	}

	// 2. Fallback: Claude Code credentials
	return readClaudeCodeToken(config.mcp_prefix);
}

/**
 * Resolve an auth token and refresh expired CLI tokens when possible.
 * Falls back to Claude Code credentials if CLI token refresh fails.
 */
export async function resolveAuthTokenWithRefresh(
	serverUrl?: string,
	cwd?: string,
): Promise<string | null> {
	const config = resolveConfig(cwd);
	const effectiveServerUrl = serverUrl || config.server_url;

	if (config.access_token) {
		if (!isExpired(config.token_expires_at)) {
			return config.access_token;
		}
	}

	if (config.refresh_token) {
		try {
			const refreshed = await refreshAccessToken({
				serverUrl: effectiveServerUrl,
				refreshToken: config.refresh_token,
				clientId: config.oauth_client_id,
			});
			saveLoginTokens(refreshed, cwd);
			return refreshed.access_token;
		} catch (_err) {
			/* intentional: refresh failures are non-fatal; continue to fallback token source */
		}
	}

	return readClaudeCodeToken(config.mcp_prefix);
}

function isExpired(expiresAtIso?: string): boolean {
	if (!expiresAtIso) return false;
	const expiresAt = new Date(expiresAtIso);
	if (Number.isNaN(expiresAt.getTime())) return false;
	// Small skew window to avoid edge-race with near-expiry tokens.
	return expiresAt.getTime() <= Date.now() + 5_000;
}

async function refreshAccessToken(options: {
	serverUrl: string;
	refreshToken: string;
	clientId?: string | undefined;
}): Promise<LoginResult> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: options.refreshToken,
	});
	if (options.clientId) {
		body.set("client_id", options.clientId);
	}

	const response = await fetch(`${options.serverUrl}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
	}

	const refreshed = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};

	return {
		access_token: refreshed.access_token,
		refresh_token: refreshed.refresh_token || options.refreshToken,
		expires_in: refreshed.expires_in,
		client_id: options.clientId,
	};
}

/**
 * Read OAuth token from Claude Code's credential store.
 * Matches by mcp_prefix against key prefix (most reliable).
 */
function readClaudeCodeToken(mcpPrefix?: string): string | null {
	const credPath = join(
		process.env.HOME || process.env.USERPROFILE || "~",
		".claude",
		".credentials.json",
	);
	if (!existsSync(credPath)) return null;

	try {
		const creds = JSON.parse(readFileSync(credPath, "utf-8"));
		const oauthEntries = creds?.mcpOAuth;
		if (!oauthEntries || typeof oauthEntries !== "object") return null;

		return matchCredByPrefix(oauthEntries, mcpPrefix) ?? matchCredByServerName(oauthEntries);
	} catch (_err) {
		/* intentional: unreadable or malformed credentials file — fall through to "no token" */
		return null;
	}
}

// ===========================================
// OAuth PKCE Login Flow
// ===========================================

interface LoginResult {
	access_token: string;
	refresh_token?: string | undefined;
	expires_in?: number | undefined;
	client_id?: string | undefined;
}

/**
 * Perform OAuth PKCE login flow.
 * Opens browser, waits for callback on local server.
 */
export async function performLogin(serverUrl: string): Promise<LoginResult> {
	// Generate PKCE challenge
	const codeVerifier = randomBytes(32).toString("base64url");
	const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
	const state = randomBytes(16).toString("hex");

	// Start local callback server
	const { port, waitForCallback, server } = await startCallbackServer();

	const redirectUri = `http://localhost:${port}/callback`;

	// Build authorization URL
	// First, register a dynamic client
	const clientInfo = await registerClient(serverUrl, redirectUri);

	const authorizeUrl = new URL(`${serverUrl}/authorize`);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("client_id", clientInfo.client_id);
	authorizeUrl.searchParams.set("redirect_uri", redirectUri);
	authorizeUrl.searchParams.set("code_challenge", codeChallenge);
	authorizeUrl.searchParams.set("code_challenge_method", "S256");
	authorizeUrl.searchParams.set("state", state);
	authorizeUrl.searchParams.set("resource", serverUrl);

	// Open browser
	await openBrowser(authorizeUrl.toString()).catch(() => {
		// Non-fatal: we still print the URL for manual copy/paste.
	});

	console.log("\nOpening browser for authentication...");
	console.log(`If the browser doesn't open, visit:\n  ${authorizeUrl.toString()}\n`);
	console.log(`Waiting for callback on http://localhost:${port}...`);
	console.log("This localhost port is temporary and expected for OAuth redirect handling.");
	console.log(
		"Keep this terminal open while you finish login in the browser (timeout: 5 minutes).",
	);
	console.log("Press Ctrl+C to cancel.\n");

	// Wait for the authorization code
	const { code, returnedState } = await waitForCallback();
	server.close();

	if (returnedState !== state) {
		throw new Error("State mismatch — possible CSRF attack");
	}

	// Exchange code for tokens
	const tokenRes = await fetch(`${serverUrl}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: clientInfo.client_id,
			code_verifier: codeVerifier,
		}),
		signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
	});

	if (!tokenRes.ok) {
		const errText = await tokenRes.text();
		throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`);
	}

	const tokens = (await tokenRes.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};

	return {
		...tokens,
		client_id: clientInfo.client_id,
	};
}

async function openBrowser(url: string): Promise<void> {
	const { spawn } = await import("node:child_process");
	const commonOptions = {
		detached: true,
		stdio: "ignore" as const,
	};

	if (process.platform === "darwin") {
		const child = spawn("open", [url], commonOptions);
		child.unref();
		return;
	}

	if (process.platform === "win32") {
		const child = spawn("cmd", ["/c", "start", "", url], {
			...commonOptions,
			windowsVerbatimArguments: true,
		});
		child.unref();
		return;
	}

	const child = spawn("xdg-open", [url], commonOptions);
	child.unref();
}

/**
 * Dynamic Client Registration (RFC 7591).
 */
async function registerClient(
	serverUrl: string,
	redirectUri: string,
): Promise<{ client_id: string }> {
	const res = await fetch(`${serverUrl}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "Interlinked CLI",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
		signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
	});

	if (!res.ok) {
		throw new Error(`Client registration failed (${res.status}): ${await res.text()}`);
	}

	return (await res.json()) as { client_id: string };
}

/**
 * Start a local HTTP server to receive the OAuth callback.
 */
function startCallbackServer(): Promise<{
	port: number;
	waitForCallback: () => Promise<{ code: string; returnedState: string }>;
	server: ReturnType<typeof createServer>;
}> {
	return new Promise((resolve, reject) => {
		let callbackResolve: (value: { code: string; returnedState: string }) => void;
		let callbackReject: (reason: Error) => void;

		const callbackPromise = new Promise<{ code: string; returnedState: string }>((res, rej) => {
			callbackResolve = res;
			callbackReject = rej;
		});

		const server = createServer((req, res) => {
			const reqUrl = new URL(req.url || "/", "http://localhost");
			if (reqUrl.pathname === "/callback") {
				const code = reqUrl.searchParams.get("code");
				const returnedState = reqUrl.searchParams.get("state") || "";
				const error = reqUrl.searchParams.get("error");

				if (error) {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h2>Authentication failed</h2><p>You can close this window.</p></body></html>",
					);
					callbackReject(
						new Error(
							`OAuth error: ${error} — ${reqUrl.searchParams.get("error_description") || ""}`,
						),
					);
					return;
				}

				if (!code) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h2>Missing authorization code</h2><p>You can close this window.</p></body></html>",
					);
					callbackReject(new Error("No authorization code received"));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					"<html><body><h2>Authentication successful!</h2><p>You can close this window and return to the terminal.</p></body></html>",
				);
				callbackResolve({ code, returnedState });
			} else {
				res.writeHead(404);
				res.end("Not found");
			}
		});

		// Listen on random port
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to start callback server"));
				return;
			}
			resolve({
				port: addr.port,
				waitForCallback: () => callbackPromise,
				server,
			});
		});

		server.on("error", reject);

		// Timeout after 5 minutes
		setTimeout(
			() => {
				callbackReject(new Error("Login timed out after 5 minutes"));
				server.close();
			},
			5 * 60 * 1000,
		);
	});
}

/**
 * Save login tokens to local config.
 */
export function saveLoginTokens(tokens: LoginResult, cwd?: string): void {
	const updates: JsonObject = {
		access_token: tokens.access_token,
	};
	if (tokens.client_id) {
		updates.oauth_client_id = tokens.client_id;
	}
	if (tokens.refresh_token) {
		updates.refresh_token = tokens.refresh_token;
	}
	if (tokens.expires_in) {
		updates.token_expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
	} else {
		updates.token_expires_at = undefined;
	}
	updateLocalConfig(updates, cwd);
}
