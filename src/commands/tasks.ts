// ===========================================
// interlinked tasks — Task management via the server
// ===========================================
// Thin wrappers around MCP task tools. All business logic is server-side.

import { getClient } from "../lib/api-client.js";
import { badge, c, header, kvLine, relativeTime, table, truncate } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

interface Task {
	id?: number;
	title?: string;
	description?: string;
	status?: string;
	priority?: string;
	assignee_name?: string;
	created_at?: string;
	updated_at?: string;
	[key: string]: unknown;
}

function isUnauthenticatedRemote(client: ReturnType<typeof getClient>): boolean {
	return !client.isAuthenticated() && !client.isLocalDevServer();
}

function parsePositiveInt(raw: string, label: string): number {
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid ${label} value: ${raw}`);
	}
	return parsed;
}

function requireAgentName(client: ReturnType<typeof getClient>, purpose: string): string {
	const name = client.getConfig().agent_name?.trim();
	if (!name) {
		throw new Error(
			`agent_name is required for ${purpose}. Set it with 'interlinked enable --agent <name>'.`,
		);
	}
	return name;
}

function unwrapTask(result: Task | { task?: Task } | undefined): Task {
	if (result && typeof result === "object" && "task" in result) {
		return (result as { task?: Task }).task || {};
	}
	return result || {};
}

export async function tasksListCommand(opts: {
	status?: string;
	assignee?: string;
	priority?: string;
	limit?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);

	const client = getClient();
	if (isUnauthenticatedRemote(client)) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	try {
		const args: JsonObject = {};
		if (opts.status) args.status = opts.status;
		if (opts.assignee) args.assignee_name = opts.assignee;
		if (opts.priority) args.priority = opts.priority;
		if (opts.limit) args.limit = parsePositiveInt(opts.limit, "--limit");

		// `callTool<T>()`'s declared `Promise<T>` return type is honest about
		// the shape of a genuine tool result but not about presence: an MCP
		// tool call can resolve to a bare `null` (a malformed/absent server
		// response — exercised directly in tests via a mocked client), so `T`
		// is widened here to `| null` rather than trusted as always-present.
		const result = await client.callTool<{ tasks?: Task[] } | null>("list_tasks", args);
		const tasks = result?.tasks || [];

		output(mode, tasks, {
			json: () => ({ tasks }),
			short: () => (tasks.length === 0 ? "No tasks" : `${tasks.length} task(s)`),
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Tasks"));

				if (tasks.length === 0) {
					lines.push(c.dim("  No tasks found"));
					return lines.join("\n");
				}

				const rows = tasks.map((t) => [
					String(t.id || ""),
					badge(t.status || "pending"),
					truncate(t.title || "", 40),
					t.assignee_name || c.dim("unassigned"),
					t.priority || c.dim("normal"),
					relativeTime(t.updated_at || t.created_at),
				]);

				lines.push(
					table(["ID", "Status", "Title", "Assignee", "Priority", "Updated"], rows),
				);
				return lines.join("\n");
			},
			full: () => {
				const lines: string[] = [];
				lines.push(header("Tasks (Full)"));

				for (const t of tasks) {
					lines.push("");
					lines.push(
						`${c.bold(`#${t.id}`)} ${badge(t.status || "pending")} ${t.title || ""}`,
					);
					if (t.description) lines.push(`  ${c.dim(t.description)}`);
					lines.push(
						`  Assignee: ${t.assignee_name || "unassigned"} | Priority: ${t.priority || "normal"}`,
					);
					lines.push(
						`  Created: ${relativeTime(t.created_at)} | Updated: ${relativeTime(t.updated_at)}`,
					);
				}

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(
			mode,
			`Server error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function tasksCreateCommand(
	title: string,
	opts: {
		description?: string;
		assignee?: string;
		priority?: string;
		json?: boolean;
	},
): Promise<void> {
	const mode = getOutputMode(opts);

	const client = getClient();
	if (isUnauthenticatedRemote(client)) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	try {
		const creatorName = requireAgentName(client, "task creation");
		const args: JsonObject = { title, creator_name: creatorName };
		if (opts.description) args.description = opts.description;
		if (opts.assignee) args.assignee_name = opts.assignee;
		if (opts.priority) args.priority = opts.priority;

		const rawResult = await client.callTool<Task | { task?: Task }>("create_task", args);
		const task = unwrapTask(rawResult);

		output(mode, rawResult, {
			json: () => rawResult,
			normal: () =>
				c.green(`Task created: ${c.bold(task.title || title)} (#${task.id || "?"})`),
		});
	} catch (err) {
		outputError(
			mode,
			`Server error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function tasksShowCommand(id: string, opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);

	const client = getClient();
	if (isUnauthenticatedRemote(client)) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	try {
		const taskId = parsePositiveInt(id, "task id");
		const rawResult = await client.callTool<Task | { task?: Task }>("get_task", {
			task_id: taskId,
		});
		const result = unwrapTask(rawResult);

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header(`Task #${result.id || id}`));
				lines.push(kvLine("Title", result.title || ""));
				lines.push(kvLine("Status", result.status || "pending"));
				lines.push(kvLine("Priority", result.priority || "normal"));
				lines.push(kvLine("Assignee", result.assignee_name || "unassigned"));
				if (result.description) {
					lines.push(`\n${result.description}`);
				}
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(
			mode,
			`Server error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function tasksClaimCommand(id: string, opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);

	const client = getClient();
	if (isUnauthenticatedRemote(client)) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	try {
		const taskId = parsePositiveInt(id, "task id");
		const agentName = requireAgentName(client, "claiming tasks");
		const result = await client.callTool("claim_task", {
			task_id: taskId,
			agent_name: agentName,
		});

		output(mode, result, {
			json: () => result,
			normal: () => c.green(`Claimed task #${id}`),
		});
	} catch (err) {
		outputError(
			mode,
			`Server error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export async function tasksCompleteCommand(id: string, opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);

	const client = getClient();
	if (isUnauthenticatedRemote(client)) {
		outputError(mode, "Not authenticated. Run: interlinked login");
		return;
	}

	try {
		const taskId = parsePositiveInt(id, "task id");
		const agentName = requireAgentName(client, "completing tasks");
		const result = await client.callTool("update_task_status", {
			task_id: taskId,
			agent_name: agentName,
			status: "completed",
		});

		output(mode, result, {
			json: () => result,
			normal: () => c.green(`Completed task #${id}`),
		});
	} catch (err) {
		outputError(
			mode,
			`Server error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
