// ===========================================
// interlinked inbox — Read messages from the server
// ===========================================
// Thin wrapper around fetch_inbox MCP tool. All logic is server-side.

import { getClient } from "../lib/api-client.js";
import { c, header, relativeTime, table, truncate } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

interface Message {
	id?: number;
	from?: string;
	from_agent?: string; // legacy compat
	recipients?: string[];
	to_agents?: string[];
	body_md?: string;
	importance?: string;
	created_at?: string;
	read?: boolean;
	[key: string]: unknown;
}

export async function inboxCommand(opts: {
	all?: boolean;
	agent?: string;
	limit?: string;
	since?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);

	const client = getClient();
	if (!client.isAuthenticated() && !client.isLocalDevServer()) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	try {
		const configuredAgentName = client.getConfig().agent_name?.trim();
		const requestedAgentName = opts.agent?.trim() || configuredAgentName;
		if (!requestedAgentName) {
			throw new Error(
				"agent_name is required. Set it with 'interlinked enable --agent <name>' or pass --agent.",
			);
		}

		const args: JsonObject = {
			agent_name: requestedAgentName,
			unread_only: !opts.all,
		};
		if (opts.limit) {
			const parsedLimit = Number.parseInt(opts.limit, 10);
			if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
				throw new Error(`Invalid --limit value: ${opts.limit}`);
			}
			args.limit = parsedLimit;
		}

		const result = await client.callTool<
			{ messages?: Message[]; inbox?: Message[] } | undefined
		>("fetch_inbox", args);

		const messages = result?.messages || result?.inbox || [];

		output(mode, messages, {
			json: () => ({ messages }),
			short: () => (messages.length === 0 ? "No messages" : `${messages.length} message(s)`),
			normal: () => {
				const lines: string[] = [];
				lines.push(header(opts.all ? "All Messages" : "Unread Messages"));

				if (messages.length === 0) {
					lines.push(c.dim("  No messages"));
					return lines.join("\n");
				}

				const rows = messages.map((m) => [
					m.from || m.from_agent || c.dim("-"),
					m.importance === "urgent" ? c.red("URGENT") : c.dim(m.importance || "normal"),
					truncate(m.body_md || "", 50),
					relativeTime(m.created_at),
				]);

				lines.push(table(["From", "Priority", "Message", "When"], rows));
				return lines.join("\n");
			},
			full: () => {
				const lines: string[] = [];
				lines.push(header(opts.all ? "All Messages" : "Unread Messages"));

				for (const m of messages) {
					lines.push("");
					const sender = m.from || m.from_agent || "unknown";
					const recipients = m.recipients || m.to_agents || [];
					lines.push(
						`${c.bold(sender)} → ${recipients.join(", ")} ${c.dim(relativeTime(m.created_at))}`,
					);
					if (m.importance === "urgent") {
						lines.push(c.red("  [URGENT]"));
					}
					lines.push(`  ${m.body_md || ""}`);
				}

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(
			mode,
			`Server error: ${err instanceof Error ? err.message : String(err)}`,
			{
				hint: "Is the Server reachable?",
			},
		);
	}
}
