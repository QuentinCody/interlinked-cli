// ===========================================
// Harness registrars — the local guard server (start/stop/restart/status/
// test/reap/clean/mode/latency) and the PII content scanner (on/off/toggle/
// status/review). Both operate the runtime that evaluates agent actions.
// ===========================================

import { type Command, type OptionValues } from "commander";
import { registerHarnessInventory } from "./harness-inventory.js";

export function registerHarnessCommands(program: Command): void {
	const harnessCmd = program
		.command("harness")
		.description("Local harness server: guard evaluation, auto-reservations, agent lifecycle");

	harnessCmd
		.command("start")
		.description("Start the harness server (background daemon by default)")
		.option("--no-daemon", "Run in foreground instead of background")
		.option("--protocol <mode>", "Socket protocol: raw, framed, or dual", "dual")
		.option("--session-id <id>", "Framed socket session id", "default")
		.option("--verbose", "Verbose logging")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { harnessStartCommand } = await import("../commands/harness.js");
			await harnessStartCommand(opts);
		});

	harnessCmd
		.command("stop")
		.description("Stop the harness server")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { harnessStopCommand } = await import("../commands/harness.js");
			await harnessStopCommand(opts);
		});

	harnessCmd
		.command("restart")
		.description("Stop and restart the harness server (picks up config changes)")
		.option("--no-daemon", "Run in foreground instead of daemon")
		.option("--protocol <mode>", "Socket protocol: raw, framed, or dual", "dual")
		.option("--session-id <id>", "Framed socket session id", "default")
		.option("--verbose", "Verbose output")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { harnessRestartCommand } = await import("../commands/harness.js");
			await harnessRestartCommand(opts);
		});

	harnessCmd
		.command("status")
		.description("Show harness status, loaded rules, and active agents")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { harnessStatusCommand } = await import("../commands/harness.js");
			await harnessStatusCommand(opts);
		});

	registerHarnessInventory(harnessCmd);

	harnessCmd
		.command("health")
		.description(
			"Check-health report from the recurrence log: repeat-rate per check id, probation candidates (demotion signal)",
		)
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Show every check id (default: top 25 by repeat-rate)")
		.action(async (opts: OptionValues) => {
			const { harnessHealthCommand } = await import("../commands/harness.js");
			await harnessHealthCommand(opts);
		});

	harnessCmd
		.command("test [command]")
		.description(
			"Fire a synthetic PreToolUse event at the running harness and show its decision. Default: a Bash command. Use --write/--edit to test a file operation.",
		)
		.option("--tool <name>", "Tool name to simulate for the positional command", "Bash")
		.option("--write <file>", "Simulate a Write to <file> (pair with --from-file or --stdin)")
		.option("--from-file <path>", "Read the proposed Write content from <path>")
		.option("--stdin", "Read the proposed Write content from stdin")
		.option("--edit <file>", "Simulate an Edit to <file> (pair with --old and --new)")
		.option("--old <str>", "old_string for --edit")
		.option("--new <str>", "new_string for --edit")
		.option("--json", "Machine-readable output")
		.action(async (command: string | undefined, opts: OptionValues) => {
			const { harnessTestCommand } = await import("../commands/harness.js");
			await harnessTestCommand(command, opts);
		});

	harnessCmd
		.command("reap")
		.description(
			"List (default) or kill orphan harness daemons. --force to SIGTERM. --all also targets the active daemon.",
		)
		.option("--force", "Actually SIGTERM the candidates (default is dry-run)")
		.option("--all", "Also target the active daemon (equivalent of pkill -f)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { harnessReapCommand } = await import("../commands/harness-reap.js");
			await harnessReapCommand(opts);
		});

	harnessCmd
		.command("clean")
		.description("Remove stale harness.sock + harness.pid (refuses if a daemon is running)")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { harnessCleanCommand } = await import("../commands/harness-clean.js");
			await harnessCleanCommand(opts);
		});

	harnessCmd
		.command("mode [name]")
		.description(
			"Show or switch the operational tier (budget|quality|ci) — drives HARNESS_POST_TIMEOUT_MS",
		)
		.option("--json", "Machine-readable output")
		.action(async (name: string | undefined, opts: OptionValues) => {
			const { harnessModeCommand } = await import("../commands/harness-mode.js");
			await harnessModeCommand(name, opts);
		});

	harnessCmd
		.command("latency")
		.description("Show per-event latency report from .interlinked/logs/latency.jsonl")
		.option("--json", "Machine-readable output")
		.option("--by-tool", "Include per-tool stats (events count + when-present p50/p99/max)")
		.action(async (opts: OptionValues) => {
			const { harnessLatencyCommand } = await import("../commands/harness-latency.js");
			await harnessLatencyCommand(opts);
		});

	const scannerCmd = program
		.command("scanner")
		.description("PII filter (content scanner) — toggle, inspect, audit");

	scannerCmd
		.command("on")
		.description("Enable the PII filter (content scanner)")
		.option("--reason <text>", "Why — recorded in content-scanner.audit.jsonl")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.action(async (opts: OptionValues) => {
			const { scannerOnCommand } = await import("../commands/scanner.js");
			await scannerOnCommand(opts);
		});

	scannerCmd
		.command("off")
		.description("Disable the PII filter. The exact timestamp is recorded in the audit log.")
		.option("--reason <text>", "Why — recorded in content-scanner.audit.jsonl")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.action(async (opts: OptionValues) => {
			const { scannerOffCommand } = await import("../commands/scanner.js");
			await scannerOffCommand(opts);
		});

	scannerCmd
		.command("toggle")
		.description("Flip the PII filter on/off and record the transition")
		.option("--reason <text>", "Why — recorded in content-scanner.audit.jsonl")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.action(async (opts: OptionValues) => {
			const { scannerToggleCommand } = await import("../commands/scanner.js");
			await scannerToggleCommand(opts);
		});

	scannerCmd
		.command("status")
		.description("Show PII filter config + runtime state + recent toggle audit")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: OptionValues) => {
			const { scannerStatusCommand } = await import("../commands/scanner.js");
			await scannerStatusCommand(opts);
		});

	scannerCmd
		.command("review")
		.description(
			"Review a WebFetch response flagged by the PII filter — pick allow / redact / block",
		)
		.option("--key <hex>", "Review a specific cache key (default: newest pending)")
		.option("--allow", "Approve the full body (skips interactive prompt)")
		.option("--redact", "Replace flagged spans with <CATEGORY> placeholders")
		.option("--block", "Withhold the body entirely")
		.option("--reason <text>", "Why — recorded in content-scanner.audit.jsonl")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.action(async (opts: OptionValues) => {
			const { scannerReviewCommand } = await import("../commands/scanner.js");
			await scannerReviewCommand(opts);
		});
}
