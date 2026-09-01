// ===========================================
// Setup & lifecycle registrars — onboarding, hook install/uninstall,
// authentication, config inspection, and enforcement-mode switching:
// clean, completions, context, disable, doctor, enable, env, init,
// install-hooks, login, logout, mode, setup, uninstall-hooks, update.
// ===========================================

import { type Command, type OptionValues } from "commander";
import { cleanCommand } from "../commands/clean.js";
import { disableCommand } from "../commands/disable.js";
import { doctorCommand } from "../commands/doctor.js";
import { enableCommand } from "../commands/enable.js";
import { loginCommand } from "../commands/login.js";
import { resolveAuthToken } from "../lib/auth.js";
import { c } from "../lib/formatter.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";

// Common option shapes for commander action callbacks.
interface JsonOpts extends OptionValues {
	json?: boolean;
}
interface ViewOpts extends JsonOpts {
	short?: boolean;
	full?: boolean;
}

const CLIENT_LIST_HELP =
	"Comma-separated client list (claude,copilot,gemini,codex,cursor,opencode,opencode2,pi)";
const RUNNER_LIST_HELP =
	"Comma-separated runners (claude-code,copilot-cli,cursor,gemini-cli,codex,opencode,opencode2,pi); defaults to auto-detect";

async function setupAction(opts: OptionValues): Promise<void> {
	await enableCommand({
		server: opts.server,
		agent: opts.agent,
		clients: opts.clients,
		syncMode: opts.syncMode,
		dryRun: opts.dryRun,
	});
	// `enable` validates both entry points. A refused enable must terminate
	// setup too: login or onboarding would contradict its no-change result.
	if (process.exitCode !== undefined && process.exitCode !== 0) return;
	if (opts.dryRun) return;
	if (opts.token) {
		await loginCommand({ server: opts.server, token: opts.token });
		return;
	}
	if (!resolveAuthToken()) {
		await loginCommand({ server: opts.server });
		return;
	}
	console.log(c.dim("\nAuth token already present. Skipping login."));
	const onboarding = await ensureRemoteOnboarding({ serverUrl: opts.server });
	if (onboarding.status !== "linked") return;
	console.log(
		c.dim(
			`Remote agent linked: ${onboarding.agentName || "agent"}${
				onboarding.agentHandle ? ` (${onboarding.agentHandle})` : ""
			}`,
		),
	);
}

export function registerSetupCommands(program: Command): void {
	program
		.command("reload")
		.description(
			"One-command dogfood loop: rebuild the CLI from its source checkout, refresh this repo's hooks, restart the daemon — reporting only what actually changed",
		)
		.option("--force", "Restart the daemon even when nothing changed")
		.option("--no-build", "Skip the CLI rebuild (hook refresh + conditional restart only)")
		.option("--json", "Machine-readable output")
		.action(async (opts: { force?: boolean; build?: boolean; json?: boolean }) => {
			const { reloadCommand } = await import("../commands/reload.js");
			await reloadCommand(opts);
		});

	program
		.command("clean")
		.description("Remove stale data")
		.option("--dry-run", "Show what would be removed (default)")
		.option("--force", "Actually delete")
		.option("--json", "Machine-readable output")
		.action(cleanCommand);

	program
		.command("completions <shell>")
		.description("Output shell completion script (bash, zsh, fish)")
		.action(async (shell: string) => {
			const { completionsCommand } = await import("../commands/completions.js");
			await completionsCommand(shell);
		});

	program
		.command("context")
		.description("Show effective configuration (merged from all sources)")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: ViewOpts) => {
			const { contextCommand } = await import("../commands/context.js");
			await contextCommand(opts);
		});

	program
		.command("disable")
		.description("Stand the harness down for this project (recorded); --uninstall to remove hooks + config")
		.option("--team", "Write a committed marker (shared, shows in PR diffs) instead of a personal one")
		.option("--reason <text>", "Why the harness is being stood down (recorded in the audit log)")
		.option("--until <duration>", "Auto-expire the stand-down (e.g. 30m, 2h, 1d)")
		.option("--by <name>", "Who is standing it down (defaults to agent name / $USER)")
		.option("--uninstall", "Destructive teardown: remove hooks from all clients and delete .interlinked/")
		.option("--keep-config", "With --uninstall, preserve .interlinked/ config files")
		.action(disableCommand);

	program
		.command("doctor")
		.description("Diagnose issues (local + server checks)")
		.option("--fix", "Auto-fix what's possible")
		.option("--json", "Machine-readable output")
		.action(doctorCommand);

	program
		.command("enable")
		.description("Install hooks + create .interlinked/ config")
		.option("--server <url>", "Server URL")
		.option("--agent <name>", "Default agent name")
		.option("--clients <list>", CLIENT_LIST_HELP)
		.option("--sync-mode <mode>", "Sync mode: realtime (default), local, manual")
		.option("--data-dir <path>", "Override data directory for activity logs and sessions")
		.option("--dry-run", "Show what would change without modifying files")
		.option("--structure <mode>", "Scaffold structure manifests: minimal, standard, strict")
		.action(enableCommand);

	program
		.command("env")
		.description("Show supported environment variables and their current values")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: ViewOpts) => {
			const { envCommand } = await import("../commands/env.js");
			await envCommand(opts);
		});

	program
		.command("init")
		.description("One-command onboarding: detect clients, configure, login, verify")
		.option("--server <url>", "Server URL")
		.option("--agent <name>", "Agent name")
		.option("--sync-mode <mode>", "Sync mode: realtime (default), local, manual")
		.option("--dry-run", "Show what would change without modifying files")
		.option("--json", "Machine-readable output")
		.option("-y, --yes", "Accept all defaults without prompting")
		.action(async (opts: OptionValues) => {
			const { initCommand } = await import("../commands/init.js");
			await initCommand(opts);
		});

	program
		.command("login")
		.description("Authenticate with the server (opens browser)")
		.option("--server <url>", "Server URL")
		.option("--token <token>", "Manual token for CI/headless use")
		.action(loginCommand);

	program
		.command("logout")
		.description("Clear authentication credentials (preserves other config)")
		.option("--all", "Also clear agent handle (requires re-registration)")
		.option("--json", "Machine-readable output")
		.action(async (opts: JsonOpts) => {
			const { logoutCommand } = await import("../commands/logout.js");
			await logoutCommand(opts);
		});

	program
		.command("setup")
		.description("One-command setup: install hooks, configure server, authenticate")
		.option("--server <url>", "Server URL")
		.option("--agent <name>", "Default agent name")
		.option("--clients <list>", CLIENT_LIST_HELP)
		.option("--sync-mode <mode>", "Sync mode: realtime (default), local, manual")
		.option("--token <token>", "Manual token for CI/headless use")
		.option("--dry-run", "Show what would change without modifying files")
		.action(setupAction);

	program
		.command("update")
		.alias("upgrade")
		.description("Clone or pull from GitHub, rebuild, and link the CLI")
		.option("--force", "Pull even with uncommitted changes in the source checkout")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { updateCommand } = await import("../commands/update.js");
			await updateCommand(opts);
		});

	// ===========================================
	// install-hooks / uninstall-hooks — blessed install path (adapter-based, manifest-driven)
	// ===========================================
	program
		.command("install-hooks")
		.description("Install agent hooks for detected runners (adapter-based, manifest-driven)")
		.option(
			"--runner <list>",
			RUNNER_LIST_HELP,
		)
		.option("--scope <scope>", "Install scope: user, project, or local", "project")
		.option("--mode <mode>", "Enforcement preset: balanced, strict, lenient", "balanced")
		.option("--binary <path>", "Override path to the interlinked binary")
		.option(
			"--refresh",
			"Re-render already-installed hooks from the manifest (snapshot + rollback; implies --preserve-mode)",
		)
		.option("--preserve-mode", "Never write the enforcement mode or cloud config — hooks only")
		.option("--dry-run", "Show what would change without writing")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { installHooksCommand } = await import("../commands/install-hooks.js");
			await installHooksCommand(opts);
		});

	program
		.command("uninstall-hooks")
		.description("Remove hooks previously installed via install-hooks (manifest-driven)")
		.option(
			"--runner <list>",
			"Comma-separated runners to target; defaults to every runner in the manifest",
		)
		.option("--dry-run", "Show what would change without writing")
		.option("--json", "Machine-readable output")
		.action(async (opts: OptionValues) => {
			const { uninstallHooksCommand } = await import("../commands/uninstall-hooks.js");
			await uninstallHooksCommand(opts);
		});

	// ===========================================
	// Mode — show / switch enforcement preset
	// ===========================================
	program
		.command("mode [name]")
		.description("Show current enforcement mode, or switch to balanced / strict / lenient")
		.option("--diff", "Preview changes without writing")
		.option("--local", "Write to the gitignored personal override instead of the shared config")
		.option("--force", "Skip confirmation prompts")
		.option("--json", "Machine-readable output")
		.action(async (name: string | undefined, opts: OptionValues) => {
			const { modeCommand } = await import("../commands/mode.js");
			await modeCommand(name, opts);
		});
}
