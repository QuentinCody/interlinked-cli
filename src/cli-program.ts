// The Interlinked CLI command tree, built without parsing argv.
//
// `src/index.ts` is the entry point: it resolves the version, then either
// supervises a resource-bounded run, runs the zero-arg wizard, or parses argv
// against this tree. Keeping the tree here lets a test walk the real commands
// (printed-command parity, `cli-program.test.ts`) without starting the CLI.
// Command registration is grouped by domain into registrar modules under
// `src/registrars/` (each `registerXxx(program)` is independently
// unit-testable); a handful of older groups expose `registerXxxCommand` from
// `src/commands/`.
import { Command } from "commander";
import { registerCiCommand } from "./commands/ci-status.js";
import { registerCollectCommand } from "./commands/collect.js";
import { registerCompactCommand } from "./commands/compact.js";
import { registerDoctestCommand } from "./commands/doctest.js";
import { registerFindingsCommands } from "./commands/findings.js";
import { registerIndexCommand } from "./commands/index-cmd.js";
import { registerSpecCommands } from "./commands/spec.js";
import { isJsonObject } from "./lib/json-types.js";
import { registerActivityCommands } from "./registrars/activity.js";
import { registerAdoptCommands } from "./registrars/adopt.js";
import { registerLintCommands } from "./registrars/lint.js";
import { registerCapsCommands } from "./registrars/caps.js";
import { registerCheckpointCommands } from "./registrars/checkpoints.js";
import { registerCoordinationCommands } from "./registrars/coordination.js";
import { registerDebtImpactCommands } from "./registrars/debt-impact.js";
import { registerDataCommands } from "./registrars/data.js";
import { registerExperienceCommands } from "./registrars/experience.js";
import { registerE2eCommands } from "./registrars/e2e.js";
import { registerHarnessCommands } from "./registrars/harness.js";
import { registerMcpCommands } from "./registrars/mcp.js";
import { registerObservabilityLogCommands } from "./registrars/observability-logs.js";
import { registerQualityCommands } from "./registrars/quality.js";
import { registerReplayCommands } from "./registrars/replay.js";
import { registerScratchCommands } from "./registrars/scratch.js";
import { registerSemanticCommands } from "./registrars/semantic.js";
import { registerSimplifyCommands } from "./registrars/simplification.js";
import { registerSetupCommands } from "./registrars/setup.js";
import { registerSponsorCommands } from "./registrars/sponsor.js";
import { registerSupplyChainCommands } from "./registrars/supply-chain.js";
import { registerVizCommands } from "./registrars/viz.js";
import { registerCoworkCommands } from "./registrars/cowork.js";

const HELP_FOOTER = `
Interface boundaries:
  Interlinked CLI        local hooks, harness checks, activity capture, diagnostics
  Server                 optional remote tasks/messages/reservations/agent state
  Web UI (/chat, /map)   optional human oversight and coordination

Zero-arg behavior:
  interlinked            human quick start: setup wizard (if unconfigured) or status dashboard

Quick start:
  interlinked                                       guided human setup/status
  interlinked enable                                explicit/automation setup; installs hooks + skills and starts the daemon
  interlinked harness start                         manual daemon recovery (enable starts it automatically)
  interlinked status                                dashboard
  interlinked login --server <url>                  optional server auth
`;

function registerDomainCommands(program: Command): void {
	registerActivityCommands(program);
	registerDataCommands(program);
	registerObservabilityLogCommands(program);
	registerDebtImpactCommands(program);
	registerSupplyChainCommands(program);
	registerHarnessCommands(program);
	registerMcpCommands(program);
	registerCheckpointCommands(program);
	registerCoordinationCommands(program);
	registerQualityCommands(program);
	registerCapsCommands(program);
	registerScratchCommands(program);
	registerSemanticCommands(program);
	registerSimplifyCommands(program);
	registerFindingsCommands(program);
	registerSpecCommands(program);
	registerAdoptCommands(program);
	registerLintCommands(program);
	registerSetupCommands(program);
	registerReplayCommands(program);
	registerExperienceCommands(program);
	registerE2eCommands(program);
	registerSponsorCommands(program);
	registerIndexCommand(program);
	registerCiCommand(program);
	registerCollectCommand(program);
	registerCompactCommand(program);
	registerDoctestCommand(program);
	registerVizCommands(program);
	registerCoworkCommands(program);
}

/** CLI output for `interlinked version`: the local version, then the configured server's health. */
async function printVersion(version: string): Promise<void> {
	const { getClient } = await import("./lib/api-client.js");
	console.log(`Interlinked CLI v${version}`);
	try {
		const client = getClient();
		const result = await client.callTool("health_check");
		if (!isJsonObject(result) || (result.status !== undefined && typeof result.status !== "string")) {
			throw new Error("Invalid health_check response");
		}
		console.log(`Server: ${client.getConfig().server_url} (${result.status || "ok"})`);
	} catch {
		console.log(`Server: ${getClient().getConfig().server_url} (unreachable or not authenticated)`);
	}
}

function registerVersionCommand(program: Command, version: string): void {
	program.command("version").description("Show Interlinked CLI + server version").action(() => printVersion(version));
}

/** The full command tree with metadata and help text; parsing is the caller's job. */
export function buildProgram(version: string): Command {
	const program = new Command();
	program.name("interlinked").description("Interlinked CLI: local hooks, activity capture, and developer observability").version(version);
	program.showHelpAfterError();
	program.addHelpText("afterAll", HELP_FOOTER);
	registerDomainCommands(program);
	registerVersionCommand(program, version);
	// Sort top-level commands alphabetically in help output.
	program.configureHelp({ sortSubcommands: true });
	return program;
}
