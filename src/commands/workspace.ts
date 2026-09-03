// ===========================================
// interlinked workspace — Workspace management
// ===========================================
// List workspaces and switch active workspace.

import { getClient } from "../lib/api-client.js";
import { readLocalConfig, resolveConfig, updateLocalConfig } from "../lib/config.js";
import { badge, c, header, table } from "../lib/formatter.js";
import { getOutputMode, output, outputError, outputSuccess } from "../lib/output.js";

interface Workspace {
	id?: string;
	name?: string;
	display_name?: string;
	role?: string;
	project_count?: number;
	agent_count?: number;
}

const WORKSPACE_ID_PATTERN = /^ws_[A-Za-z0-9]+$/;

function formatWorkspaceRow(w: Workspace, activeWorkspaceId: string | undefined): string[] {
	const isActive = activeWorkspaceId === w.id;
	const marker = isActive ? c.green("*") : " ";
	const name = w.name || c.dim("-");
	const role = w.role ? badge(w.role) : c.dim("-");
	const projects = w.project_count != null ? String(w.project_count) : c.dim("-");
	const agents = w.agent_count != null ? String(w.agent_count) : c.dim("-");
	return [marker, name, role, projects, agents, w.id != null ? String(w.id) : c.dim("-")];
}

// ===========================================
// workspace list
// ===========================================

export async function workspaceListCommand(opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);

	try {
		const client = getClient();
		const config = resolveConfig();

		const workspaces: Workspace[] = await client.fetchWorkspaces();

		output(mode, workspaces, {
			json: () => ({
				workspaces,
				active_workspace: config.workspace_id || null,
			}),
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Registry Workspaces"));

				if (workspaces.length === 0) {
					lines.push(c.dim("  No workspaces found"));
					return lines.join("\n");
				}

				const rows = workspaces.map((w) => formatWorkspaceRow(w, config.workspace_id));

				lines.push(table(["", "Name", "Role", "Projects", "Agents", "ID"], rows));

				if (config.workspace_id) {
					lines.push("");
					lines.push(c.dim(`  Active: ${config.workspace_id}`));
				}
				lines.push(c.dim("  IDs here are registry workspace IDs (ws_...)."));
				lines.push(
					c.dim("  Internal workspace_key/project_key are selected in MCP tool calls."),
				);

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// workspace switch
// ===========================================

export async function workspaceSwitchCommand(id: string): Promise<void> {
	try {
		if (!WORKSPACE_ID_PATTERN.test(id)) {
			throw new Error(`Invalid workspace ID '${id}'. Expected format: ws_<alphanumeric>.`);
		}

		const client = getClient();
		const workspaces: Workspace[] = await client.fetchWorkspaces();
		const exists = workspaces.some((w) => w.id === id);
		if (!exists) {
			const available = workspaces
				.map((w) => w.id)
				.filter((value): value is string => Boolean(value));
			const suffix =
				available.length > 0
					? ` Available IDs: ${available.join(", ")}`
					: " No accessible workspaces were returned by the server.";
			throw new Error(`Workspace '${id}' was not found in your workspace list.${suffix}`);
		}

		const local = readLocalConfig() || {};
		const activeServerKey = local.active_server || "production";

		if (local.servers?.[activeServerKey]) {
			const servers = {
				...local.servers,
				[activeServerKey]: {
					...local.servers[activeServerKey],
					workspace_id: id,
				},
			};
			updateLocalConfig({ workspace_id: id, servers });
		} else {
			updateLocalConfig({ workspace_id: id });
		}
		outputSuccess("normal", `${c.green("Switched")} active workspace to ${c.cyan(id)}`);
	} catch (err) {
		console.error(`${c.red("Error:")} ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
