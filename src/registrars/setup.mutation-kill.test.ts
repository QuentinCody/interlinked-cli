// Mutation-kill companion for src/registrars/setup.ts.
//
// The registrar's surviving mutants are mostly Commander help-text literals.
// Help is public CLI behavior, so assert the complete command/option contract
// rather than merely requiring descriptions to be non-empty. The reload action
// is also exercised because it was the only uncovered forwarding block.

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerSetupCommands } from "./setup.js";

const reloadCommand = vi.fn();

vi.mock("../commands/reload.js", () => ({
	reloadCommand: (...args: unknown[]) => reloadCommand(...args),
}));

function build(): Command {
	const program = new Command();
	program.exitOverride();
	registerSetupCommands(program);
	return program;
}

function command(program: Command, name: string): Command {
	const found = program.commands.find((candidate) => candidate.name() === name);
	if (!found) throw new Error(`missing command: ${name}`);
	return found;
}

function optionDescriptions(cmd: Command): Record<string, string> {
	const result: Record<string, string> = {};
	for (const option of cmd.options) {
		if (option.long) result[option.long] = option.description;
	}
	return result;
}

describe("registerSetupCommands — public help contract", () => {
	// test-contract: public-api — Commander help exposes every documented setup lifecycle command and option description
	it("preserves every command and option description", () => {
		const program = build();
		const expected: Record<string, { description: string; options: Record<string, string> }> = {
			reload: {
				description:
					"One-command dogfood loop: rebuild the CLI from its source checkout, refresh this repo's hooks, restart the daemon — reporting only what actually changed",
				options: {
					"--force": "Restart the daemon even when nothing changed",
					"--no-build": "Skip the CLI rebuild (hook refresh + conditional restart only)",
					"--json": "Machine-readable output",
				},
			},
			clean: {
				description: "Remove stale data",
				options: {
					"--dry-run": "Show what would be removed (default)",
					"--force": "Actually delete",
					"--json": "Machine-readable output",
				},
			},
			completions: {
				description: "Output shell completion script (bash, zsh, fish)",
				options: {},
			},
			context: {
				description: "Show effective configuration (merged from all sources)",
				options: {
					"--json": "Machine-readable output",
					"--short": "One-line summary",
					"--full": "Detailed output",
				},
			},
			disable: {
				description:
					"Stand the harness down for this project (recorded); --uninstall to remove hooks + config",
				options: {
					"--team": "Write a committed marker (shared, shows in PR diffs) instead of a personal one",
					"--reason": "Why the harness is being stood down (recorded in the audit log)",
					"--until": "Auto-expire the stand-down (e.g. 30m, 2h, 1d)",
					"--by": "Who is standing it down (defaults to agent name / $USER)",
					"--uninstall": "Destructive teardown: remove hooks from all clients and delete .interlinked/",
					"--keep-config": "With --uninstall, preserve .interlinked/ config files",
				},
			},
			doctor: {
				description: "Diagnose issues (local + server checks)",
				options: {
					"--fix": "Auto-fix what's possible",
					"--json": "Machine-readable output",
				},
			},
			enable: {
				description: "Install hooks + create .interlinked/ config",
				options: {
					"--server": "Server URL",
					"--agent": "Default agent name",
					"--clients":
						"Comma-separated client list (claude,copilot,gemini,codex,cursor,opencode,opencode2,pi)",
					"--sync-mode": "Sync mode: realtime (default), local, manual",
					"--data-dir": "Override data directory for activity logs and sessions",
					"--dry-run": "Show what would change without modifying files",
					"--structure": "Scaffold structure manifests: minimal, standard, strict",
				},
			},
			env: {
				description: "Show supported environment variables and their current values",
				options: {
					"--json": "Machine-readable output",
					"--short": "One-line summary",
					"--full": "Detailed output",
				},
			},
			init: {
				description: "One-command onboarding: detect clients, configure, login, verify",
				options: {
					"--server": "Server URL",
					"--agent": "Agent name",
					"--sync-mode": "Sync mode: realtime (default), local, manual",
					"--dry-run": "Show what would change without modifying files",
					"--json": "Machine-readable output",
					"--yes": "Accept all defaults without prompting",
				},
			},
			login: {
				description: "Authenticate with the server (opens browser)",
				options: {
					"--server": "Server URL",
					"--token": "Manual token for CI/headless use",
				},
			},
			logout: {
				description: "Clear authentication credentials (preserves other config)",
				options: {
					"--all": "Also clear agent handle (requires re-registration)",
					"--json": "Machine-readable output",
				},
			},
			setup: {
				description: "One-command setup: install hooks, configure server, authenticate",
				options: {
					"--server": "Server URL",
					"--agent": "Default agent name",
					"--clients":
						"Comma-separated client list (claude,copilot,gemini,codex,cursor,opencode,opencode2,pi)",
					"--sync-mode": "Sync mode: realtime (default), local, manual",
					"--token": "Manual token for CI/headless use",
					"--dry-run": "Show what would change without modifying files",
				},
			},
			update: {
				description: "Clone or pull from GitHub, rebuild, and link the CLI",
				options: {
					"--force": "Pull even with uncommitted changes in the source checkout",
					"--json": "Machine-readable output",
				},
			},
			"install-hooks": {
				description: "Install agent hooks for detected runners (adapter-based, manifest-driven)",
				options: {
					"--runner":
						"Comma-separated runners (claude-code,copilot-cli,cursor,gemini-cli,codex,opencode,opencode2,pi); defaults to auto-detect",
					"--scope": "Install scope: user, project, or local",
					"--mode": "Enforcement preset: balanced, strict, lenient",
					"--binary": "Override path to the interlinked binary",
					"--refresh":
						"Re-render already-installed hooks from the manifest (snapshot + rollback; implies --preserve-mode)",
					"--preserve-mode": "Never write the enforcement mode or cloud config — hooks only",
					"--dry-run": "Show what would change without writing",
					"--json": "Machine-readable output",
				},
			},
			"uninstall-hooks": {
				description: "Remove hooks previously installed via install-hooks (manifest-driven)",
				options: {
					"--runner": "Comma-separated runners to target; defaults to every runner in the manifest",
					"--dry-run": "Show what would change without writing",
					"--json": "Machine-readable output",
				},
			},
			mode: {
				description: "Show current enforcement mode, or switch to balanced / strict / lenient",
				options: {
					"--diff": "Preview changes without writing",
					"--local": "Write to the gitignored personal override instead of the shared config",
					"--force": "Skip confirmation prompts",
					"--json": "Machine-readable output",
				},
			},
		};

		expect(Object.keys(expected).sort()).toEqual(program.commands.map((cmd) => cmd.name()).sort());
		for (const [name, contract] of Object.entries(expected)) {
			const cmd = command(program, name);
			expect(cmd.description(), `${name} description`).toBe(contract.description);
			expect(optionDescriptions(cmd), `${name} option descriptions`).toEqual(contract.options);
		}
	});
});

describe("registerSetupCommands — reload forwarding", () => {
	// test-contract: public-api — reload parses force, no-build, and json flags into the documented command options
	it("loads and invokes reloadCommand with parsed options", async () => {
		const program = build();
		await program.parseAsync(["reload", "--force", "--no-build", "--json"], { from: "user" });
		expect(reloadCommand).toHaveBeenCalledWith({ force: true, build: false, json: true });
	});
});
