// ===========================================
// Server Bridge — Sync harness state with server
// ===========================================
// Manages:
// - Reservation cache refresh from server
// - Guard event reporting to server
// - Server presence detection
// - Team rule sync

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { JsonObject } from "../lib/json-types.js";
import { scrubEgressPayload } from "../lib/secrets.js";
import type { CoordinationResponse } from "./auto-coordinate.js";
import type { ServerApiClient, ServerReservation } from "./reservations.js";
import type { SessionTrajectory } from "./types.js";

// ===========================================
// Types
// ===========================================

interface ServerBridgeConfig {
	serverUrl: string;
	authToken?: string | undefined;
	workspaceId?: string | undefined;
	workspaceKey?: string | undefined;
	projectKey?: string | undefined;
	/** How often to refresh reservation cache (ms, default: 30s) */
	refreshIntervalMs?: number | undefined;
}

interface GuardEventReport {
	agent_name: string;
	event_type: "guard_block" | "guard_warn" | "guard_alert";
	rule_id?: string | undefined;
	tool_name?: string | undefined;
	tool_input_summary?: string | undefined;
	decision: "block" | "warn";
	reason: string;
	occurred_at: string;
}

// ===========================================
// Reservation response classifier
// ===========================================

/**
 * The MCP `file_reservation_paths` tool returns a body shaped roughly:
 *   { granted?: [...], conflicts?: [{file, reserved_by, ...}], ok?: boolean }
 * A non-empty `conflicts[]` (or explicit `ok: false`) means the server has
 * actively denied the reservation — caller should roll back the optimistic
 * local grant. Anything else (including missing fields, server returning
 * the bare success object) is treated as accepted.
 */
function isExplicitReservationRejection(
	result: JsonObject | null | undefined,
	_filePath: string,
): boolean {
	if (!result) return false;
	if (result.ok === false) return true;
	const conflicts = result.conflicts;
	// `reserveFile` is the only caller and always sends a single path. Any
	// non-empty conflicts list therefore belongs to that path — even if the
	// server reported it under a normalized form (`./a.ts` vs `a.ts`,
	// absolute vs relative). Per-conflict file matching here would let those
	// normalization differences masquerade as "no conflict" and reopen the
	// double-allocation case this classifier exists to close.
	return Array.isArray(conflicts) && conflicts.length > 0;
}

/**
 * Classify a thrown callTool error as an *explicit reservation denial* vs
 * a transient/auth/config failure. The reservation rollback path only
 * fires for explicit denials — anything else must NOT roll back a
 * legitimate optimistic local grant.
 *
 * Explicit reservation denial: HTTP 409 (Conflict) or 423 (Locked). These
 * are the only 4xx codes that prove "another agent holds this file".
 *
 * Auth/config 4xx (401/403/404, etc.): NOT denials. An expired token, a
 * wrong workspace key, or a stale server URL says nothing about whether
 * another agent holds the file. Treat as fail-open — keep the optimistic
 * grant; the user will see auth errors elsewhere and reconcile.
 *
 * Network/timeout/5xx errors: also not denials. The server hasn't said no
 * — it just hasn't said anything we can trust.
 */
function isExplicitDenialError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const m = e.message.match(/^Server API error: (\d+)$/);
	if (!m) return false;
	const status = Number(m[1]);
	return status === 409 || status === 423;
}

// ===========================================
// Server Bridge
// ===========================================

export class ServerBridge implements ServerApiClient {
	private config: ServerBridgeConfig;
	private connected = false;
	private guardEventQueue: GuardEventReport[] = [];
	private flushInterval: ReturnType<typeof setInterval> | null = null;

	constructor(config: ServerBridgeConfig) {
		this.config = config;

		// Flush guard events every 10 seconds
		this.flushInterval = setInterval(() => {
			this.flushGuardEvents().catch(() => {/* best-effort: server sync is optional */});
		}, 10_000);

		// Initial health check
		this.healthCheck().catch(() => {/* best-effort: server is optional */});
	}

	// ===========================================
	// Health Check
	// ===========================================

	async healthCheck(): Promise<boolean> {
		try {
			const res = await fetchWithTimeout(`${this.config.serverUrl}/health`, {
				timeout: 3000,
			});
			this.connected = res.ok;
			return this.connected;
		} catch {
			this.connected = false;
			return false;
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	// ===========================================
	// File Reservations (implements ServerApiClient)
	// ===========================================

	async reserveFile(filePath: string, agentName: string, ttlSeconds: number): Promise<void> {
		// Network/transient errors are swallowed so flaky connectivity doesn't
		// roll back legitimate optimistic local grants. *Explicit* server
		// rejection — either a 4xx HTTP status (callTool throws
		// `Server API error: <code>`) or a resolved body carrying
		// `conflicts[]` / `ok:false` — re-throws so the caller's `.catch()`
		// in reservations.ts:266-269 rolls back the local grant and emits a
		// "server-rejected" conflict event.
		let result: JsonObject;
		try {
			result = await this.callTool("file_reservation_paths", {
				agent_name: agentName,
				paths: [filePath],
				ttl_seconds: ttlSeconds,
				workspace_key: this.config.workspaceKey || "main",
				project_key: this.config.projectKey || "main",
			});
		} catch (e) {
			if (isExplicitDenialError(e)) throw e;
			return;
		}
		if (isExplicitReservationRejection(result, filePath)) {
			throw new Error("server rejected reservation");
		}
	}

	async releaseFile(filePath: string, agentName: string): Promise<void> {
		try {
			await this.callTool("release_file_reservations", {
				agent_name: agentName,
				paths: [filePath],
				workspace_key: this.config.workspaceKey || "main",
				project_key: this.config.projectKey || "main",
			});
		} catch (e) {
			void e;
		}
	}

	async listReservations(): Promise<ServerReservation[]> {
		try {
			const result = await this.callTool("list_file_reservations", {
				brief: true,
				workspace_key: this.config.workspaceKey || "main",
				project_key: this.config.projectKey || "main",
			});
			const reservations = result.reservations;
			if (!Array.isArray(reservations)) return [];
			return reservations.map((r: JsonObject) => {
				const expires_at = r.expires_at as string | undefined;
				return {
					agent_name: r.agent_name as string,
					path_pattern: r.path_pattern as string,
					...(expires_at !== undefined ? { expires_at } : {}),
				};
			});
		} catch {
			return [];
		}
	}

	// ===========================================
	// Guard Event Reporting
	// ===========================================

	/** Queue a guard event for batch reporting to the server */
	reportGuardEvent(event: GuardEventReport): void {
		this.guardEventQueue.push(event);

		// If queue is large, flush immediately
		if (this.guardEventQueue.length >= 10) {
			this.flushGuardEvents().catch(() => {/* best-effort: server sync is optional */});
		}
	}

	/** Flush queued guard events to the server */
	private async flushGuardEvents(): Promise<void> {
		if (this.guardEventQueue.length === 0 || !this.connected) return;

		const events = [...this.guardEventQueue];
		this.guardEventQueue = [];

		// Report as activity events with guard-specific fields
		try {
			const batchPayload = {
				events: events.map((e) => {
					const payload: JsonObject = {
						agent_name: e.agent_name,
						event_type: e.event_type,
						tool_name: e.tool_name,
						tool_input_summary: e.tool_input_summary,
						occurred_at: e.occurred_at,
						workspace_key: this.config.workspaceKey || "main",
						project_key: this.config.projectKey || "main",
						// Store guard decision details in error_message field
						error_message: `[${e.decision}] ${e.reason}`.slice(0, 500),
						hook_event: e.event_type,
						source: "harness",
					};
					// Redact at the cloud boundary via the shared scrubber — same
					// contract as the hook + `interlinked sync` egress. A guard
					// summary/reason can echo a command containing a secret; the PII
					// pass is a no-op here (no prompt/thinking). Two-tier model:
					// raw local, redacted egress.
					scrubEgressPayload(payload);
					return payload;
				}),
			};

			await fetchWithTimeout(`${this.config.serverUrl}/api/hooks/activity/batch`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(this.config.authToken
						? { Authorization: `Bearer ${this.config.authToken}` }
						: {}),
					"X-Interlinked-Harness-Version": "1.0.0",
				},
				body: JSON.stringify(batchPayload),
				timeout: 5000,
			});
		} catch {
			// Re-queue events on failure (up to a limit)
			if (events.length <= 50) {
				this.guardEventQueue.unshift(...events);
			}
		}
	}

	// ===========================================
	// MCP Tool Proxy (via /api/ui/call)
	// ===========================================

	private async callTool(toolName: string, args: JsonObject): Promise<JsonObject> {
		const res = await fetchWithTimeout(`${this.config.serverUrl}/api/ui/call`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(this.config.authToken
					? { Authorization: `Bearer ${this.config.authToken}` }
					: {}),
			},
			body: JSON.stringify({
				tool: toolName,
				args,
				// Route to the correct workspace DO
				...(this.config.workspaceId ? { workspace_id: this.config.workspaceId } : {}),
			}),
			timeout: 5000,
		});

		if (!res.ok) {
			throw new Error(`Server API error: ${res.status}`);
		}

		const data = (await res.json()) as JsonObject;
		// Handle JSON-RPC response format
		if (data.result) return data.result as JsonObject;
		if (data.error) throw new Error(String((data.error as JsonObject).message || data.error));
		return data;
	}

	// ===========================================
	// Auto-Coordination
	// ===========================================

	/**
	 * Fetch coordination state from the MCP server.
	 * Returns null on any failure (fail-open — always).
	 */
	async fetchCoordinationState(
		agentName: string,
		session: SessionTrajectory,
		timeoutMs?: number,
	): Promise<CoordinationResponse | null> {
		if (!this.connected) return null;

		try {
			const response = await fetchWithTimeout(
				`${this.config.serverUrl}/api/auto-coordinate`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(this.config.authToken
							? { Authorization: `Bearer ${this.config.authToken}` }
							: {}),
					},
					body: JSON.stringify({
						agent_name: agentName,
						workspace_key: this.config.workspaceKey,
						project_key: this.config.projectKey,
						tool_call_count: session.tool_call_count,
						session_started_at: session.started_at,
					}),
					timeout: timeoutMs ?? 2000,
				},
			);

			if (!response.ok) return null;
			return (await response.json()) as CoordinationResponse;
		} catch {
			return null; // Fail open — always
		}
	}

	// ===========================================
	// Cleanup
	// ===========================================

	shutdown(): void {
		if (this.flushInterval) {
			clearInterval(this.flushInterval);
			this.flushInterval = null;
		}
		// Final flush attempt
		this.flushGuardEvents().catch(() => {/* best-effort: server sync is optional */});
	}
}

// ===========================================
// Fetch with Timeout Helper
// ===========================================

async function fetchWithTimeout(
	url: string,
	options: RequestInit & { timeout?: number } = {},
): Promise<Response> {
	const { timeout = 5000, ...fetchOptions } = options;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		const res = await fetch(url, {
			...fetchOptions,
			signal: controller.signal,
		});
		return res;
	} finally {
		clearTimeout(timer);
	}
}

// ===========================================
// Factory
// ===========================================

/** The three `config.json` fields this bridge reads (server URL + workspace/
 *  project defaults) — `config.json` carries a wider shape than this module
 *  needs. Fields with the wrong runtime type read as absent rather than
 *  flowing an untyped value into `ServerBridgeConfig`. */
function parseSharedBridgeFields(value: unknown): {
	serverUrl: string | undefined;
	workspaceKey: string | undefined;
	projectKey: string | undefined;
} {
	if (!isJsonObject(value)) {
		return { serverUrl: undefined, workspaceKey: undefined, projectKey: undefined };
	}
	return {
		serverUrl: typeof value.server_url === "string" ? value.server_url : undefined,
		workspaceKey: typeof value.default_workspace_key === "string" ? value.default_workspace_key : undefined,
		projectKey: typeof value.default_project === "string" ? value.default_project : undefined,
	};
}

/** One entry of `config.local.json`'s `servers` map, narrowed field-by-field. */
function parseLocalServerEntry(value: unknown): { serverUrl: string | undefined; workspaceId: string | undefined } {
	if (!isJsonObject(value)) return { serverUrl: undefined, workspaceId: undefined };
	return {
		serverUrl: typeof value.server_url === "string" ? value.server_url : undefined,
		workspaceId: typeof value.workspace_id === "string" ? value.workspace_id : undefined,
	};
}

/** The `config.local.json` fields this bridge reads: top-level auth/workspace
 *  defaults, plus the active-server override (falls back to "production").
 *  An override applies only when non-empty — matches the original `||` checks. */
function parseLocalBridgeFields(value: unknown): {
	authToken: string | undefined;
	workspaceId: string | undefined;
	activeServerUrl: string | undefined;
} {
	if (!isJsonObject(value)) {
		return { authToken: undefined, workspaceId: undefined, activeServerUrl: undefined };
	}
	const authToken = typeof value.access_token === "string" ? value.access_token : undefined;
	let workspaceId = typeof value.workspace_id === "string" ? value.workspace_id : undefined;
	let activeServerUrl: string | undefined;

	const activeKey = typeof value.active_server === "string" ? value.active_server : "production";
	const servers = value.servers;
	if (isJsonObject(servers)) {
		const activeServer = parseLocalServerEntry(servers[activeKey]);
		// workspaceId only overrides when server_url is also present (matches original nesting).
		if (activeServer.serverUrl) {
			activeServerUrl = activeServer.serverUrl;
			if (activeServer.workspaceId) workspaceId = activeServer.workspaceId;
		}
	}
	return { authToken, workspaceId, activeServerUrl };
}

/**
 * Create a ServerBridge from CLI config.
 * Returns null if no server URL is configured.
 */
export function createServerBridge(cwd: string = process.cwd()): ServerBridge | null {
	try {
		const configDir = join(cwd, ".interlinked");
		const sharedPath = join(configDir, "config.json");
		const localPath = join(configDir, "config.local.json");

		let serverUrl: string | undefined;
		let authToken: string | undefined;
		let workspaceId: string | undefined;
		let workspaceKey: string | undefined;
		let projectKey: string | undefined;

		if (existsSync(sharedPath)) {
			try {
				const shared = parseSharedBridgeFields(JSON.parse(readFileSync(sharedPath, "utf-8")));
				serverUrl = shared.serverUrl;
				workspaceKey = shared.workspaceKey;
				projectKey = shared.projectKey;
			} catch (e) {
				void e;
			}
		}

		if (existsSync(localPath)) {
			try {
				const local = parseLocalBridgeFields(JSON.parse(readFileSync(localPath, "utf-8")));
				authToken = local.authToken;
				workspaceId = local.workspaceId;
				if (local.activeServerUrl) serverUrl = local.activeServerUrl;
			} catch (e) {
				void e;
			}
		}

		if (!serverUrl) return null;

		return new ServerBridge({
			serverUrl,
			authToken,
			workspaceId,
			workspaceKey: workspaceKey || "main",
			projectKey: projectKey || "main",
		});
	} catch {
		return null;
	}
}
