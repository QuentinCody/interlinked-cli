// ===========================================
// resolveConfig() helpers — split out for the per-file line cap.
// ===========================================
// Pure, side-effect-free resolution steps used by `resolveConfig` in
// ./config.ts. Kept as a sibling module rather than inline so the
// orchestrator stays small; imported back into config.ts.

import type { LocalConfig, ServerEntry } from "./config.js";

/** Env-var overrides consumed by `resolveConfig`, gathered in one place so the
 *  orchestrator reads a single object instead of six independent branches. */
interface ConfigEnvOverrides {
	envServerUrl: string | undefined;
	envWorkspaceId: string | undefined;
	envMcpPrefix: string | undefined;
	envAgentName: string | undefined;
	envAccessToken: string | undefined;
	envSyncMode: string | undefined;
}

export function resolveConfigEnvOverrides(): ConfigEnvOverrides {
	return {
		envServerUrl: process.env.INTERLINKED_SERVER_URL?.trim(),
		envWorkspaceId: process.env.INTERLINKED_WORKSPACE_ID?.trim(),
		envMcpPrefix: process.env.INTERLINKED_MCP_PREFIX?.trim(),
		envAgentName:
			process.env.INTERLINKED_AGENT_NAME?.trim() || process.env.INTERLINKED_AGENT?.trim(),
		envAccessToken:
			process.env.INTERLINKED_ACCESS_TOKEN?.trim() || process.env.INTERLINKED_TOKEN?.trim(),
		envSyncMode: process.env.INTERLINKED_SYNC_MODE?.trim().toLowerCase(),
	};
}

/**
 * Resolve the active server entry — all URL/workspace/prefix come from the
 * same source: an env-matched entry when `INTERLINKED_SERVER_URL` is set,
 * otherwise the configured `active_server` entry.
 */
export function resolveActiveServerEntry(
	local: LocalConfig | null,
	envServerUrl: string | undefined,
): ServerEntry | undefined {
	if (!envServerUrl) {
		const activeKey = local?.active_server || "production";
		return local?.servers?.[activeKey];
	}
	return Object.values(local?.servers || {}).find((s) => s.server_url === envServerUrl);
}

export function resolveSyncMode(
	local: LocalConfig | null,
	envSyncMode: string | undefined,
): string {
	if (envSyncMode === "local" || envSyncMode === "manual" || envSyncMode === "realtime") {
		return envSyncMode;
	}
	return local?.sync_mode || "realtime";
}
