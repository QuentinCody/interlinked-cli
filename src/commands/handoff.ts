// ===========================================
// interlinked handoff — Explicit agent-to-agent handoff
// ===========================================
// Orchestrates multiple MCP tool calls for a clean handoff.

import { getClient } from "../lib/api-client.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export async function handoffCommand(
	fromAgent: string,
	toAgent: string,
	opts?: {
		includeFiles?: boolean;
		json?: boolean;
		short?: boolean;
		full?: boolean;
	},
): Promise<void> {
	const mode = getOutputMode(opts || {});

	const client = getClient();
	if (!client.isAuthenticated() && !client.isLocalDevServer()) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	try {
		// Step 1: Get work context from source agent
		let context: JsonObject | null = null;
		try {
			const result = await client.callTool("get_work_context", {
				agent_name: fromAgent,
			});
			if (isJsonObject(result)) context = result;
		} catch (_) {
			/* intentional: work context is optional, continue handoff without it */
		}

		// Step 2: Send handoff message to target agent
		const contextSummary = context
			? JSON.stringify(context).slice(0, 500)
			: "No context available";

		const handoffBody = [
			`## Handoff from ${fromAgent}`,
			"",
			`Agent ${fromAgent} is handing off work to you.`,
			"",
			"### Context",
			contextSummary,
		].join("\n");

		await client.callTool("send_message", {
			to: [toAgent],
			body_md: handoffBody,
			importance: "urgent",
		});

		const handoffResult = {
			from: fromAgent,
			to: toAgent,
			context_available: !!context,
			message_sent: true,
		};

		output(mode, handoffResult, {
			json: () => handoffResult,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Agent Handoff"));
				lines.push(kvLine("From", fromAgent));
				lines.push(kvLine("To", toAgent));
				lines.push(kvLine("Context", context ? c.green("included") : c.dim("unavailable")));
				lines.push(kvLine("Message", c.green("sent")));
				lines.push("");
				lines.push(c.green(`Handoff complete. ${toAgent} has been notified.`));
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, `Handoff failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
