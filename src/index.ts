#!/usr/bin/env node
// ===========================================
// Interlinked CLI — Local companion: hooks, activity capture, guard evaluation, and developer observability
// ===========================================
//
// This is the thin entry point. Command registration is grouped by domain
// into registrar modules under `src/registrars/` (each `registerXxx(program)`
// is independently unit-testable). A handful of older command groups expose
// their own `registerXxxCommand(program)` from `src/commands/`. This file owns
// only the wiring: program metadata, help text, the version command (which
// closes over `CLI_VERSION`), alphabetical sort, and parse/dispatch.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { registerCiCommand } from "./commands/ci-status.js";
import { registerCollectCommand } from "./commands/collect.js";
import { registerCompactCommand } from "./commands/compact.js";
import { registerDoctestCommand } from "./commands/doctest.js";
import { registerFindingsCommands } from "./commands/findings.js";
import { handleImplicitEntry } from "./commands/first-run.js";
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

const program = new Command();

// Read version from package.json so it stays in sync with the package
function resolveVersion(): string {
	try {
		const pkgPath = new URL("../package.json", import.meta.url);
		const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const version = isJsonObject(parsed) ? parsed.version : undefined;
		return typeof version === "string" && version.length > 0 ? version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}
const CLI_VERSION = resolveVersion();

program
	.name("interlinked")
	.description("Interlinked CLI: local hooks, activity capture, and developer observability")
	.version(CLI_VERSION);

program.showHelpAfterError();
program.addHelpText(
	"afterAll",
	`
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
`,
);

// ===========================================
// Command registration (grouped by domain)
// ===========================================
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
registerSponsorCommands(program);
registerIndexCommand(program);
registerCiCommand(program);
registerCollectCommand(program);
registerCompactCommand(program);
registerDoctestCommand(program);
registerVizCommands(program);

program
	.command("version")
	.description("Show Interlinked CLI + server version")
	.action(async () => {
		const { getClient } = await import("./lib/api-client.js");
		console.log(`Interlinked CLI v${CLI_VERSION}`);
		try {
			const client = getClient();
			const result = await client.callTool("health_check");
			if (!isJsonObject(result) || (result.status !== undefined && typeof result.status !== "string")) {
				throw new Error("Invalid health_check response");
			}
			console.log(
				`Server: ${client.getConfig().server_url} (${result.status || "ok"})`,
			);
		} catch {
			console.log(
				`Server: ${getClient().getConfig().server_url} (unreachable or not authenticated)`,
			);
		}
	});

// ===========================================
// Parse and Execute
// ===========================================

// Sort top-level commands alphabetically in help output.
program.configureHelp({ sortSubcommands: true });

if (!(await handleImplicitEntry())) {
	await program.parseAsync(process.argv);
}
