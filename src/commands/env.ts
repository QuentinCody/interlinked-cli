// ===========================================
// interlinked env — Show environment variable documentation
// ===========================================
// Displays all supported env vars, their current values, and descriptions.
// Useful for CI/headless setup and debugging config resolution.

import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";

interface EnvOptions {
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

interface EnvVarDoc {
	name: string;
	description: string;
	example: string;
	currentValue: string | undefined;
}

function getEnvVars(): EnvVarDoc[] {
	return [
		{
			name: "INTERLINKED_SERVER_URL",
			description: "Server URL (overrides config.json)",
			example: "http://localhost:8787",
			currentValue: process.env.INTERLINKED_SERVER_URL,
		},
		{
			name: "INTERLINKED_ACCESS_TOKEN",
			description: "OAuth access token (overrides config.local.json)",
			example: "eyJ...",
			currentValue: process.env.INTERLINKED_ACCESS_TOKEN,
		},
		{
			name: "INTERLINKED_TOKEN",
			description: "Alias for INTERLINKED_ACCESS_TOKEN",
			example: "eyJ...",
			currentValue: process.env.INTERLINKED_TOKEN,
		},
		{
			name: "INTERLINKED_AGENT_NAME",
			description: "Agent name (overrides config.local.json)",
			example: "my-agent",
			currentValue: process.env.INTERLINKED_AGENT_NAME,
		},
		{
			name: "INTERLINKED_AGENT",
			description: "Alias for INTERLINKED_AGENT_NAME",
			example: "my-agent",
			currentValue: process.env.INTERLINKED_AGENT,
		},
		{
			name: "INTERLINKED_WORKSPACE_ID",
			description: "Workspace UUID (ws_... format)",
			example: "ws_abc123def456789",
			currentValue: process.env.INTERLINKED_WORKSPACE_ID,
		},
		{
			name: "INTERLINKED_SYNC_MODE",
			description: "Sync mode: realtime (default), local, manual",
			example: "realtime",
			currentValue: process.env.INTERLINKED_SYNC_MODE,
		},
		{
			name: "INTERLINKED_DATA_DIR",
			description: "Override data directory for activity logs and sessions",
			example: "/tmp/interlinked-data",
			currentValue: process.env.INTERLINKED_DATA_DIR,
		},
		{
			name: "INTERLINKED_HOME",
			description: "Override config directory (default: .interlinked/)",
			example: "/home/user/.interlinked",
			currentValue: process.env.INTERLINKED_HOME,
		},
		{
			name: "INTERLINKED_MCP_PREFIX",
			description: "MCP server name prefix for credential lookup",
			example: "Interlinked-local",
			currentValue: process.env.INTERLINKED_MCP_PREFIX,
		},
		{
			name: "INTERLINKED_CLIENTS",
			description: "Comma-separated list of clients for non-interactive bootstrap",
			example: "claude,copilot,gemini,codex,cursor,opencode,opencode2,pi",
			currentValue: process.env.INTERLINKED_CLIENTS,
		},
	];
}

export async function envCommand(options: EnvOptions): Promise<void> {
	const mode = getOutputMode(options);
	const vars = getEnvVars();
	const setVars = vars.filter((v) => v.currentValue);

	output(mode, vars, {
		json: () =>
			vars.map((v) => ({
				name: v.name,
				description: v.description,
				example: v.example,
				is_set: !!v.currentValue,
				value: v.currentValue || null,
			})),
		short: () => {
			if (setVars.length === 0) return "No Interlinked env vars set.";
			return setVars.map((v) => `${v.name}=${v.currentValue}`).join(", ");
		},
		normal: () => {
			const lines: string[] = [];

			lines.push(c.bold("Interlinked CLI — Environment Variables"));
			lines.push(c.dim("─".repeat(40)));

			if (setVars.length > 0) {
				lines.push(header("Active Overrides"));
				for (const v of setVars) {
					const displayVal =
						v.name.includes("TOKEN") || v.name.includes("ACCESS")
							? `${v.currentValue!.substring(0, 8)}...`
							: v.currentValue!;
					lines.push(kvLine(v.name, c.green(displayVal)));
					lines.push(`    ${c.dim(v.description)}`);
				}
			} else {
				lines.push(c.dim("\n  No environment overrides active."));
			}

			lines.push(header("All Supported Variables"));
			for (const v of vars) {
				const status = v.currentValue ? c.green("SET") : c.dim("not set");
				lines.push(`  ${c.cyan(v.name)} ${status}`);
				lines.push(`    ${c.dim(v.description)}`);
				lines.push(`    ${c.dim(`Example: ${v.example}`)}`);
			}

			lines.push("");
			lines.push(
				c.dim(
					"Use these for CI/headless environments where interactive setup isn't possible.",
				),
			);

			return lines.join("\n");
		},
	});
}
