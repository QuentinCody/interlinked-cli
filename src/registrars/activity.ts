// ===========================================
// Observability registrars — activity feed, narrative explain, local logs,
// status dashboard, server watch, inbox, telemetry spool, daemon listing,
// event sync, and agent-trace export/import.
// ===========================================

import { type Command, type OptionValues } from "commander";
import { activityCommand } from "../commands/activity.js";
import { explainCommand } from "../commands/explain.js";
import { statusCommand } from "../commands/status.js";
import { syncCommand } from "../commands/sync.js";
import { watchCommand } from "../commands/watch.js";

export function registerActivityCommands(program: Command): void {
	registerFeedCommands(program);
	registerMonitoringCommands(program);
	registerTraceCommands(program);
}

function registerFeedCommands(program: Command): void {
	program
		.command("activity")
		.description("Recent activity feed")
		.option("--agent <name>", "Filter by agent")
		.option("--limit <n>", "Max entries", "30")
		.option("--since <duration>", "e.g. 1h, 30m")
		.option("--json", "Machine-readable output")
		.action(activityCommand);

	program
		.command("explain")
		.description("Reconstruct what happened (narrative view)")
		.option("--agent <name>", "Filter by agent")
		.option("--since <duration>", "Time window", "1h")
		.option("--full", "Include event detail")
		.option("--json", "Machine-readable output")
		.action(explainCommand);

	program
		.command("inbox")
		.description("Show recent messages from the server")
		.option("--all", "Show all messages (default: unread only)")
		.option("--agent <name>", "Filter by recipient agent")
		.option("--limit <n>", "Max entries")
		.option("--since <duration>", "e.g. 1h, 30m")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: OptionValues) => {
			const { inboxCommand } = await import("../commands/inbox.js");
			await inboxCommand(opts);
		});

	program
		.command("logs")
		.description("View local activity log (offline, no server needed)")
		.option("-f, --follow", "Follow mode (like tail -f)")
		.option("--agent <name>", "Filter by agent name")
		.option("--tool <name>", "Filter by tool name")
		.option("--type <type>", "Filter by event type")
		.option("--since <duration>", "Show events from last duration (e.g. 5m, 1h)")
		.option("--limit <n>", "Max events to show (default: 20)")
		.option("--raw", "Show raw JSON per line")
		.option("--json", "Machine-readable output")
		.option("--short", "Compact output")
		.action(async (opts: OptionValues) => {
			const { logsCommand } = await import("../commands/logs.js");
			await logsCommand(opts);
		});
}

function registerMonitoringCommands(program: Command): void {
	program
		.command("status")
		.description("Dashboard: local sessions, recent activity, sync status")
		.option("--short", "One-line summary")
		.option("--full", "Per-session detail with tools and files")
		.option("--json", "Machine-readable output")
		.option("--watch [seconds]", "Auto-refresh interval (default 10s)")
		.action(statusCommand);

	program
		.command("watch")
		.description("Monitor server for pending work (messages, tasks, agents)")
		.option("--interval <seconds>", "Refresh interval (default 10s)")
		.option("--short", "One-line summary")
		.option("--json", "Machine-readable output")
		.action(watchCommand);

	program
		.command("telemetry")
		.description("View or tail the local telemetry spool (.interlinked/offline-spool.jsonl)")
		.option("-f, --follow", "Tail the spool for new events (like tail -f)")
		.option("--limit <n>", "Show the last N events")
		.option("--spool <path>", "Override spool path")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { telemetryShowCommand } = await import("../commands/telemetry.js");
			await telemetryShowCommand(opts);
		});

	program
		.command("daemons")
		.description("List active harness daemons, PID liveness, socket paths, and health")
		.option("--json", "Machine-readable output")
		.option("--cleanup", "Remove orphan daemon records (dead PIDs)")
		.action(async (opts: OptionValues) => {
			const { daemonsCommand } = await import("../commands/daemons.js");
			await daemonsCommand(opts);
		});

	program
		.command("sync")
		.description("Push locally-buffered events to the server")
		.option("--dry-run", "Show what would be synced without sending")
		.option("--limit <n>", "Max events to sync")
		.option("--json", "Machine-readable output")
		.action(syncCommand);
}

function registerTraceCommands(program: Command): void {
	const traceCmd = program.command("trace").description("Agent trace export/import");

	traceCmd
		.command("export")
		.description("Export local activity as agent trace")
		.option("--since <duration>", "e.g. 1h, 1d")
		.option("--agent <name>", "Filter by agent")
		.option("--output <file>", "Output file (default: stdout)")
		.option("--format <fmt>", "Format: json (default) or jsonl")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { traceExportCommand } = await import("../commands/trace.js");
			await traceExportCommand(opts);
		});

	traceCmd
		.command("import <file>")
		.description("Import trace file into local activity")
		.option("--json", "Machine-readable output")
		.action(async (file: string, opts: OptionValues) => {
			const { traceImportCommand } = await import("../commands/trace.js");
			await traceImportCommand(file, opts);
		});
}
