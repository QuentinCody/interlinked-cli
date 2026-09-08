// ===========================================
// Remote Onboarding Helper
// ===========================================
// Bridges Interlinked CLI local setup with server agent bootstrap.
// Best-effort only: never throws, never blocks local-only workflows.

import { getClient } from "./api-client.js";
import { resolveConfig, updateLocalConfig } from "./config.js";
import { isJsonObject } from "./json-types.js";
import { wireAbsentOptional, wireBoolean, wireObject, wireString } from "./value-validation.js";

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

const isGetStartedResponse = wireObject<GetStartedResponse>({
	workspace: wireAbsentOptional(wireObject<NonNullable<GetStartedResponse["workspace"]>>({ name: wireAbsentOptional(wireString) })),
	agent: wireAbsentOptional(wireObject<NonNullable<GetStartedResponse["agent"]>>({ name: wireAbsentOptional(wireString), agent_handle: wireAbsentOptional(wireString), is_new: wireAbsentOptional(wireBoolean), reclaimed: wireAbsentOptional(wireBoolean) })),
});

function parseGetStartedResponse(value: unknown): GetStartedResponse | null {
	if (value == null) return null;
	if (!isJsonObject(value) || !isGetStartedResponse(value)) throw new Error("Invalid agent bootstrap response");
	return value;
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
		const result = parseGetStartedResponse(await client.callTool("get_started", {
			name: agentName,
			program: "interlinked-cli",
		}));

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
