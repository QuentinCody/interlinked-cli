// ===========================================
// Coordination registrars — multi-agent coordination and server-backed
// collaboration: file reminders, skill markers, agent handoff, direct
// messages, task management, registry workspaces, and CLI-to-server attach.
// ===========================================

import { type Command, type OptionValues } from "commander";
import { attachCommand } from "../commands/attach.js";

export function registerCoordinationCommands(program: Command): void {
	registerAttachment(program);
	registerReminders(program);
	registerSkillTracking(program);
	registerAgentMessages(program);
	registerTasks(program);
	registerWorkspaces(program);
}

function registerAttachment(program: Command): void {
	program
		.command("attach")
		.description("Attach local CLI settings to workspace/agent and link remote identity")
		.option("--server <url>", "Server URL")
		.option("--workspace <id>", "Active workspace ID (ws_...)")
		.option("--workspace-key <key>", "Default internal workspace_key for MCP tool calls")
		.option("--project <key>", "Default internal project_key for MCP tool calls")
		.option("--agent <name>", "Agent identity to attach")
		.option("--auto", "Derive workspace_key/project from git repo")
		.option("--json", "Machine-readable output")
		.action(attachCommand);
}

function registerReminders(program: Command): void {
	const reminderCmd = program
		.command("reminder")
		.description("File reminder management (warnings when files are touched)");

	reminderCmd
		.command("add")
		.description("Add a file reminder")
		.requiredOption("--glob <pattern>", "File glob pattern to match")
		.requiredOption("--message <text>", "Reminder message")
		.option("--ops <list>", "Comma-separated operations (Edit,Write,Read)")
		.option("--once", "Fire once per session (default)", true)
		.option("--no-once", "Fire every time the file is touched")
		.option("--id <id>", "Stable ID (auto-generated from glob if omitted)")
		.option("--team", "Write to guard-rules.json instead of local")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { reminderAddCommand } = await import("../commands/reminder.js");
			reminderAddCommand(opts);
		});

	reminderCmd
		.command("list", { isDefault: true })
		.description("List active file reminders")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: OptionValues) => {
			const { reminderListCommand } = await import("../commands/reminder.js");
			reminderListCommand(opts);
		});

	reminderCmd
		.command("remove [id-or-glob]")
		.description("Remove a file reminder by id or glob")
		.option("--team", "Remove from guard-rules.json instead of local")
		.option("--all", "Remove all reminders")
		.option("--json", "Machine-readable output")
		.action(async (idOrGlob: string | undefined, opts: OptionValues) => {
			const { reminderRemoveCommand } = await import("../commands/reminder.js");
			reminderRemoveCommand(idOrGlob, opts);
		});
}

function registerSkillTracking(program: Command): void {
	const skillCmd = program
		.command("skill")
		.description("Skill marker management (scopes distilled rules via active_when)");

	skillCmd
		.command("enter <name>")
		.description("Mark a skill as active for the current session(s)")
		.option("--ttl <duration>", "TTL like 30m, 1h, 90s (default 30m, capped at 4h)")
		.option("--session <id>", "Target a specific session (default: broadcast)")
		.option("--source <kind>", "cli | hook | manual (default cli)")
		.option("--json", "Machine-readable output")
		.action(async (name: string, opts: OptionValues) => {
			const { skillEnterCommand } = await import("../commands/skill.js");
			await skillEnterCommand(name, opts);
		});

	skillCmd
		.command("leave <name>")
		.description("Clear a skill marker")
		.option("--session <id>", "Target a specific session (default: broadcast)")
		.option("--json", "Machine-readable output")
		.action(async (name: string, opts: OptionValues) => {
			const { skillLeaveCommand } = await import("../commands/skill.js");
			await skillLeaveCommand(name, opts);
		});

	skillCmd
		.command("list", { isDefault: true })
		.description("Show currently-active skills across all sessions")
		.option("--session <id>", "Show only one session")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { skillListCommand } = await import("../commands/skill.js");
			await skillListCommand(opts);
		});
}

function registerAgentMessages(program: Command): void {
	program
		.command("handoff <from-agent> <to-agent>")
		.description("Explicit agent-to-agent handoff with context transfer")
		.option("--include-files", "Include file context in handoff")
		.option("--json", "Machine-readable output")
		.action(async (from: string, to: string, opts: OptionValues) => {
			const { handoffCommand } = await import("../commands/handoff.js");
			await handoffCommand(from, to, opts);
		});

	program
		.command("send <to> [message]")
		.description("Send a message to an agent")
		.option("--file <path>", "Send file contents as message body")
		.option("--importance <level>", "Message importance: normal, urgent")
		.option("--json", "Machine-readable output")
		.action(async (to: string, message: string | undefined, opts: OptionValues) => {
			const { sendCommand } = await import("../commands/send.js");
			await sendCommand(to, message, opts);
		});
}

function registerTasks(program: Command): void {
	const tasksCmd = program
		.command("tasks")
		.description("Task management via the server");

	tasksCmd
		.command("list", { isDefault: true })
		.description("List tasks")
		.option("--status <status>", "Filter by status")
		.option("--assignee <name>", "Filter by assignee")
		.option("--priority <level>", "Filter by priority")
		.option("--limit <n>", "Max entries")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: OptionValues) => {
			const { tasksListCommand } = await import("../commands/tasks.js");
			await tasksListCommand(opts);
		});

	tasksCmd
		.command("create <title>")
		.description("Create a new task")
		.option("--description <text>", "Task description")
		.option("--assignee <name>", "Assign to agent")
		.option("--priority <level>", "Task priority")
		.option("--json", "Machine-readable output")
		.action(async (title: string, opts: OptionValues) => {
			const { tasksCreateCommand } = await import("../commands/tasks.js");
			await tasksCreateCommand(title, opts);
		});

	tasksCmd
		.command("show <id>")
		.description("Show task detail")
		.option("--json", "Machine-readable output")
		.action(async (id: string, opts: OptionValues) => {
			const { tasksShowCommand } = await import("../commands/tasks.js");
			await tasksShowCommand(id, opts);
		});

	tasksCmd
		.command("claim <id>")
		.description("Claim a task")
		.option("--json", "Machine-readable output")
		.action(async (id: string, opts: OptionValues) => {
			const { tasksClaimCommand } = await import("../commands/tasks.js");
			await tasksClaimCommand(id, opts);
		});

	tasksCmd
		.command("complete <id>")
		.description("Mark a task as complete")
		.option("--json", "Machine-readable output")
		.action(async (id: string, opts: OptionValues) => {
			const { tasksCompleteCommand } = await import("../commands/tasks.js");
			await tasksCompleteCommand(id, opts);
		});
}

function registerWorkspaces(program: Command): void {
	const wsCmd = program.command("workspace").description("Registry workspace management (ws_ IDs)");

	wsCmd
		.command("list")
		.description("Show workspaces")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { workspaceListCommand } = await import("../commands/workspace.js");
			await workspaceListCommand(opts);
		});

	wsCmd
		.command("switch <id>")
		.description("Change active workspace")
		.action(async (id: string) => {
			const { workspaceSwitchCommand } = await import("../commands/workspace.js");
			await workspaceSwitchCommand(id);
		});
}
