// ===========================================
// Remote Onboarding Helper
// ===========================================
// Bridges Interlinked CLI local setup with server agent bootstrap.
// Best-effort only: never throws, never blocks local-only workflows.

import { getClient } from "./api-client.js";
import { resolveConfig, updateLocalConfig } from "./config.js";

export type RemoteOnboardingStatus = "linked" | "skipped" | "failed";

export interface RemoteOnboardingResult {
	status: RemoteOnboardingStatus;
	reason?:
		| "agent_name_missing"
		| "not_authenticated"
		| "workspace_missing"
		| "server_unavailable"
		| "bootstrap_failed";
	agentName?: string;
	agentHandle?: string | undefined;
	isNewAgent?: boolean;
	reclaimedAgent?: boolean;
	workspaceName?: string | undefined;
	error?: string;
}

interface GetStartedResponse {
	workspace?: {
		name?: string;
	};
	agent?: {
		name?: string;
		agent_handle?: string;
		is_new?: boolean;
		reclaimed?: boolean;
	};
}

export async function ensureRemoteOnboarding(options?: {
	serverUrl?: string;
	token?: string;
}): Promise<RemoteOnboardingResult> {
	const config = resolveConfig();
	const agentName = config.agent_name?.trim();

	if (!agentName) {
		return { status: "skipped", reason: "agent_name_missing" };
	}

	const client = getClient({
		serverUrl: options?.serverUrl || config.server_url,
		workspaceId: config.workspace_id,
		token: options?.token,
	});

	if (!client.isAuthenticated() && !client.isLocalDevServer()) {
		return { status: "skipped", reason: "not_authenticated" };
	}

	try {
		// callTool's return type is trusted, not verified — the raw payload
		// comes from `res.json()` over the network, so it can be null (or any
		// other shape) at runtime despite the generic annotation. Widen to
		// `| null` here so the `result?.` guards below stay honest instead of
		// being unnecessary-condition dead code against a lying non-null type.
		const result = await client.callTool<GetStartedResponse | null>("get_started", {
			name: agentName,
			program: "interlinked-cli",
		});

		const resolvedAgentName =
			typeof result?.agent?.name === "string" && result.agent.name.trim().length > 0
				? result.agent.name
				: agentName;

		const agentHandle =
			typeof result?.agent?.agent_handle === "string" &&
			result.agent.agent_handle.trim().length > 0
				? result.agent.agent_handle
				: undefined;

		if (agentHandle) {
			updateLocalConfig({ agent_handle: agentHandle });
		}

		return {
			status: "linked",
			agentName: resolvedAgentName,
			agentHandle,
			isNewAgent: result?.agent?.is_new === true,
			reclaimedAgent: result?.agent?.reclaimed === true,
			workspaceName:
				typeof result?.workspace?.name === "string" ? result.workspace.name : undefined,
		};
	} catch (error) {
		return {
			status: "failed",
			reason: "bootstrap_failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
