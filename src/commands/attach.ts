// ===========================================
// interlinked attach — Link local CLI config to remote identity/workspace
// ===========================================

import {
	initConfig,
	readLocalConfig,
	readSharedConfig,
	resolveConfig,
	updateLocalConfig,
	writeSharedConfig,
} from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { deriveProjectIdentity, isGitRepo } from "../lib/git-utils.js";
import { nonNull } from "../lib/non-null.js";
import { ensureRemoteOnboarding, type RemoteOnboardingResult } from "../lib/onboarding.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9]+$/;

interface AttachOptions {
	server?: string;
	workspace?: string;
	workspaceKey?: string;
	project?: string;
	agent?: string;
	auto?: boolean;
	json?: boolean;
}

interface AttachResult {
	server_url: string;
	workspace_id?: string | undefined;
	default_workspace_key?: string | undefined;
	default_project?: string | undefined;
	agent_name?: string | undefined;
	remote: {
		status: "linked" | "skipped" | "failed";
		reason?: string | undefined;
		agent_name?: string | undefined;
		agent_handle?: string | undefined;
		workspace_name?: string | undefined;
		is_new_agent?: boolean | undefined;
		reclaimed_agent?: boolean | undefined;
		error?: string | undefined;
	};
}

function applyWorkspaceLocalConfig(workspaceId: string): void {
	const local = readLocalConfig() || {};
	const activeServerKey = local.active_server || "production";

	if (local.servers?.[activeServerKey]) {
		const servers = {
			...local.servers,
			[activeServerKey]: {
				...local.servers[activeServerKey],
				workspace_id: workspaceId,
			},
		};
		updateLocalConfig({ workspace_id: workspaceId, servers });
		return;
	}

	updateLocalConfig({ workspace_id: workspaceId });
}

// Map remote status+reason pairs to the user-facing lines shown in `attach` output.
// Keeps the render path table-driven so new reasons are one-row additions.
function buildRemoteStatusLines(remote: RemoteOnboardingResult, result: AttachResult): string[] {
	const lines: string[] = [];

	if (remote.status === "linked") {
		const lifecycle = remote.isNewAgent
			? "new"
			: remote.reclaimedAgent
				? "reclaimed"
				: "existing";
		const name = remote.agentName || result.agent_name || "agent";
		lines.push(kvLine("Remote", c.green(`${name} linked (${lifecycle})`)));
		if (remote.agentHandle) {
			lines.push(kvLine("Agent handle", remote.agentHandle));
		}
		return lines;
	}

	const skippedReasons: Record<string, { label: string; help?: string }> = {
		not_authenticated: { label: "not authenticated", help: "  Run: interlinked login" },
		agent_name_missing: {
			label: "agent name required",
			help: "  Run: interlinked attach --agent <name>",
		},
	};

	if (remote.status === "skipped" && remote.reason && skippedReasons[remote.reason]) {
		const { label, help } = nonNull(skippedReasons[remote.reason]);
		lines.push(kvLine("Remote", c.yellow(label)));
		if (help) lines.push(c.dim(help));
		return lines;
	}

	if (remote.status === "failed") {
		lines.push(kvLine("Remote", c.yellow("not linked")));
		if (remote.error) lines.push(c.dim(`  ${remote.error}`));
		return lines;
	}

	lines.push(kvLine("Remote", c.dim("skipped")));
	return lines;
}

// --auto: derive workspace_key/project from git repo metadata, mutating opts in place.
function applyAutoDerivedContext(opts: AttachOptions, mode: ReturnType<typeof getOutputMode>): void {
	const cwd = process.cwd();
	if (!isGitRepo(cwd)) {
		if (mode !== "json") {
			console.log(c.yellow("  --auto: not a git repository, skipping auto-derivation."));
		}
		return;
	}

	const derived = deriveProjectIdentity(cwd);
	if (!opts.workspaceKey && derived.workspaceKey) {
		opts.workspaceKey = derived.workspaceKey;
		if (mode !== "json") {
			console.log(c.dim(`  Auto-derived workspace_key: ${derived.workspaceKey}`));
		}
	}
	if (!opts.project && derived.projectKey) {
		opts.project = derived.projectKey;
		if (mode !== "json") {
			console.log(c.dim(`  Auto-derived project: ${derived.projectKey}`));
		}
	}
}

function applyDefaultContext(opts: {
	workspaceKey?: string | undefined;
	project?: string | undefined;
}): void {
	if (!opts.workspaceKey && !opts.project) {
		return;
	}
	const existing = readSharedConfig() || { version: 1, server_url: resolveConfig().server_url };
	const updated = {
		...existing,
		...(opts.workspaceKey ? { default_workspace_key: opts.workspaceKey } : {}),
		...(opts.project ? { default_project: opts.project } : {}),
	};
	writeSharedConfig(updated);
}

export async function attachCommand(opts: AttachOptions): Promise<void> {
	const mode = getOutputMode(opts);

	try {
		// --auto: derive workspace_key/project from git repo metadata
		if (opts.auto) {
			applyAutoDerivedContext(opts, mode);
		}

		if (opts.server) {
			initConfig({ serverUrl: opts.server });
		}

		if (opts.workspace) {
			if (!WORKSPACE_ID_PATTERN.test(opts.workspace)) {
				throw new Error(
					`Invalid workspace ID '${opts.workspace}'. Expected format: ws_<alphanumeric>.`,
				);
			}
			applyWorkspaceLocalConfig(opts.workspace);
		}

		applyDefaultContext({
			workspaceKey: opts.workspaceKey?.trim(),
			project: opts.project?.trim(),
		});

		if (opts.agent?.trim()) {
			updateLocalConfig({ agent_name: opts.agent.trim() });
		}

		const remote = await ensureRemoteOnboarding(
			opts.server !== undefined ? { serverUrl: opts.server } : {},
		);
		const resolved = resolveConfig();

		const result: AttachResult = {
			server_url: resolved.server_url,
			workspace_id: resolved.workspace_id,
			default_workspace_key: resolved.default_workspace_key,
			default_project: resolved.default_project,
			agent_name: resolved.agent_name,
			remote: {
				status: remote.status,
				reason: remote.reason,
				agent_name: remote.agentName,
				agent_handle: remote.agentHandle,
				workspace_name: remote.workspaceName,
				is_new_agent: remote.isNewAgent,
				reclaimed_agent: remote.reclaimedAgent,
				error: remote.error,
			},
		};

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Attach"));
				lines.push(kvLine("Server", result.server_url));
				lines.push(kvLine("Workspace", result.workspace_id || c.dim("not set")));
				lines.push(
					kvLine(
						"workspace_key",
						result.default_workspace_key || c.dim("main (default)"),
					),
				);
				lines.push(
					kvLine("project_key", result.default_project || c.dim("main (default)")),
				);
				lines.push(kvLine("Agent", result.agent_name || c.dim("not set")));

				lines.push(...buildRemoteStatusLines(remote, result));

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
