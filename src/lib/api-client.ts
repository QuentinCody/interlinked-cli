// ===========================================
// API Client — HTTP client for /api/ui/call
// ===========================================
// Uses Bearer token auth with the server UI proxy endpoint.
// Returns parsed tool results (already unwrapped from JSON-RPC).

import { resolveAuthToken, resolveAuthTokenWithRefresh } from "./auth.js";
import { type ResolvedConfig, resolveConfig } from "./config.js";
import { isJsonObject, type JsonObject } from "./json-types.js";

/** Timeout for the /health reachability ping, in milliseconds. */
const HEALTH_PING_TIMEOUT_MS = 5000;

/**
 * Timeout for regular API calls (tool proxy, workspace list), in milliseconds.
 * Bounds a slow upstream so a hung request can't leak the handle indefinitely;
 * generous enough for larger payloads (activity feeds, timelines).
 */
const API_REQUEST_TIMEOUT_MS = 30000;

function apiErrorMessage(result: unknown): string {
	if (!isJsonObject(result)) return String(result);
	if (isJsonObject(result.error) && typeof result.error.message === "string" && result.error.message) return result.error.message;
	if (typeof result.message === "string" && result.message) return result.message;
	return JSON.stringify(result);
}

interface WorkspaceSummary {
	id: string;
	name: string;
	role?: string;
	display_name?: string;
}

function parseWorkspace(value: unknown): WorkspaceSummary {
	if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.name !== "string") {
		throw new Error("Workspace response contains an invalid workspace");
	}
	const workspace: WorkspaceSummary = { id: value.id, name: value.name };
	if (typeof value.role === "string") workspace.role = value.role;
	if (typeof value.display_name === "string") workspace.display_name = value.display_name;
	return workspace;
}

function parseWorkspaces(value: unknown): WorkspaceSummary[] {
	if (!isJsonObject(value)) throw new Error("Workspace response must be an object");
	if (value.workspaces == null) return [];
	if (!Array.isArray(value.workspaces)) throw new Error("Workspace response must contain a workspace array");
	return value.workspaces.map(parseWorkspace);
}

/**
 * Timeout for fire-and-forget hook-event POSTs, in milliseconds. Shorter than
 * a user-facing API call — these are best-effort and already swallow errors.
 */
const HOOK_EVENT_TIMEOUT_MS = 3000;

/** Result of {@link InterlinkedClient.healthCheck}. */
export interface HealthCheckResult {
	serverReachable: boolean;
	authenticated: boolean;
	serverVersion?: string | undefined;
	error?: string | undefined;
}

/**
 * Build a health result for a failed check. Always reports `authenticated:
 * false` and carries the real error — never invented success data. Centralizing
 * the failure shape keeps the `healthCheck` catch from inlining a literal.
 */
function healthFailure(opts: { serverReachable: boolean; error: string }): HealthCheckResult {
	return { serverReachable: opts.serverReachable, authenticated: false, error: opts.error };
}

export class InterlinkedClient {
	private serverUrl: string;
	private workspaceId?: string | undefined;
	private token: string | null;
	private readonly usesExplicitToken: boolean;

	constructor(options?: {
		serverUrl?: string | undefined;
		workspaceId?: string | undefined;
		token?: string | undefined;
	}) {
		const config = resolveConfig();
		this.serverUrl = options?.serverUrl || config.server_url;
		this.workspaceId = options?.workspaceId || config.workspace_id;
		this.usesExplicitToken = Boolean(options?.token);
		this.token = options?.token || resolveAuthToken() || null;
	}

	private async ensureToken(): Promise<void> {
		if (this.usesExplicitToken) {
			return;
		}
		this.token = await resolveAuthTokenWithRefresh(this.serverUrl);
	}

	/**
	 * Get the resolved config for display purposes.
	 */
	getConfig(): ResolvedConfig {
		return resolveConfig();
	}

	/**
	 * Check if the client has authentication credentials.
	 */
	isAuthenticated(): boolean {
		return this.token !== null;
	}

	/**
	 * Local dev servers bypass OAuth and accept unauthenticated requests.
	 */
	isLocalDevServer(): boolean {
		return this.serverUrl.includes("localhost") || this.serverUrl.includes("127.0.0.1");
	}

	/**
	 * Call an MCP tool via the /api/ui/call proxy.
	 * Returns the parsed tool result (already unwrapped from JSON-RPC).
	 * Throws on errors.
	 */
	callTool(name: string, args?: JsonObject): Promise<unknown>;
	callTool<T>(name: string, args: JsonObject, parse: (value: unknown) => T): Promise<T>;
	async callTool(name: string, args: JsonObject = {}, parse?: (value: unknown) => unknown): Promise<unknown> {
		await this.ensureToken();
		const isLocalDev = this.isLocalDevServer();

		if (!this.token && !isLocalDev) {
			throw new Error(
				"Not authenticated. Run 'interlinked login' to authenticate, or ensure Claude Code has a valid server connection.",
			);
		}

		// Keep CLI wrappers resilient across server versions by always supplying
		// the default MCP workspace/project context unless explicitly overridden.
		const resolvedConfig = this.getConfig();
		const defaultWorkspaceKey = resolvedConfig.default_workspace_key || "main";
		const defaultProject = resolvedConfig.default_project || "main";
		const normalizedArgs: JsonObject = {
			workspace_key: defaultWorkspaceKey,
			project_key: defaultProject,
			...args,
		};

		const body: JsonObject = { tool: name, args: normalizedArgs };
		if (this.workspaceId) {
			body.workspace = this.workspaceId;
		}

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		// Only send Bearer auth for real tokens (not dev-mode placeholders)
		// In dev mode (localhost), the server provides a session fallback
		if (this.token && !isLocalDev) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		const res = await fetch(`${this.serverUrl}/api/ui/call`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
		});

		if (res.status === 401) {
			throw new Error(
				"Authentication failed. Your token may have expired. Run 'interlinked login' to re-authenticate.",
			);
		}

		const result: unknown = await res.json();

		if (!res.ok) {
			const errMsg = apiErrorMessage(result);
			throw new Error(`API error (${res.status}): ${errMsg}`);
		}

		return parse ? parse(result) : result;
	}

	/**
	 * Fetch workspaces directly from the registry endpoint.
	 * Unlike callTool, this doesn't require a workspace to be selected.
	 */
	async fetchWorkspaces(): Promise<
		Array<{ id: string; name: string; role?: string; display_name?: string }>
	> {
		await this.ensureToken();
		const isLocalDev = this.isLocalDevServer();

		if (!this.token && !isLocalDev) {
			throw new Error("Not authenticated. Run 'interlinked login' to authenticate.");
		}

		const headers: Record<string, string> = {};
		if (this.token && !isLocalDev) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		const res = await fetch(`${this.serverUrl}/api/workspaces`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
		});

		if (res.status === 401) {
			throw new Error("Authentication failed. Run 'interlinked login' to re-authenticate.");
		}

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`API error (${res.status}): ${text}`);
		}

		return parseWorkspaces(await res.json());
	}

	/**
	 * Call multiple tools in sequence, collecting results.
	 */
	async callTools(calls: Array<{ name: string; args?: JsonObject }>): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const call of calls) {
			results.push(await this.callTool(call.name, call.args || {}));
		}
		return results;
	}

	/**
	 * Post a hook event (activity or lifecycle).
	 */
	async postHookEvent(
		event: {
			agent_name: string;
			event_type: string;
			tool_name?: string;
			tool_input_summary?: string;
		},
		type: "activity" | "lifecycle" = "activity",
	): Promise<void> {
		await this.ensureToken();
		const isLocalDev = this.isLocalDevServer();
		if (!this.token && !isLocalDev) return;
		const resolvedConfig = this.getConfig();
		const payload: JsonObject = {
			workspace_key: resolvedConfig.default_workspace_key || "main",
			project_key: resolvedConfig.default_project || "main",
			...event,
		};

		const endpoint = type === "lifecycle" ? "/api/hooks/lifecycle" : "/api/hooks/activity";

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.token && !isLocalDev) {
			headers.Authorization = `Bearer ${this.token}`;
		}

		await fetch(`${this.serverUrl}${endpoint}`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(HOOK_EVENT_TIMEOUT_MS),
		}).catch(() => {
			// Swallow — hook events are fire-and-forget (timeout aborts included)
		});
	}

	/**
	 * Health check: verify server reachability and auth validity.
	 */
	async healthCheck(): Promise<HealthCheckResult> {
		try {
			await this.ensureToken();
			const isLocalDev = this.isLocalDevServer();

			// First check server reachability
			const pingRes = await fetch(`${this.serverUrl}/health`, {
				signal: AbortSignal.timeout(HEALTH_PING_TIMEOUT_MS),
			}).catch(() => null);

			if (!pingRes?.ok) {
				return {
					serverReachable: false,
					authenticated: false,
					error: "server unreachable",
				};
			}

			// In localhost dev mode, auth may be intentionally omitted.
			// Validate MCP availability directly instead of requiring a token.
			if (!this.token && isLocalDev) {
				const result = await this.callTool("health_check");
				return {
					serverReachable: true,
					authenticated: true,
					serverVersion:
						isJsonObject(result) && typeof result.version === "string"
							? result.version
							: undefined,
				};
			}

			// Then check auth (remote mode)
			if (!this.token) {
				return { serverReachable: true, authenticated: false, error: "No auth token" };
			}

			const result = await this.callTool("health_check");
			return {
				serverReachable: true,
				authenticated: true,
				serverVersion:
					isJsonObject(result) && typeof result.version === "string"
						? result.version
						: undefined,
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// The catch returns a typed health result describing the real failure
			// (not invented success data) — built via a named helper so the
			// failure mode is explicit at the boundary.
			if (msg.includes("Authentication failed")) {
				return healthFailure({ serverReachable: true, error: "Token invalid or expired" });
			}
			return healthFailure({ serverReachable: false, error: msg });
		}
	}
}

/**
 * Create a shared client instance for use across commands.
 */
let _sharedClient: InterlinkedClient | null = null;

export function getClient(options?: {
	serverUrl?: string | undefined;
	workspaceId?: string | undefined;
	token?: string | undefined;
}): InterlinkedClient {
	if (options) {
		return new InterlinkedClient(options);
	}
	if (!_sharedClient) {
		_sharedClient = new InterlinkedClient();
	}
	return _sharedClient;
}
