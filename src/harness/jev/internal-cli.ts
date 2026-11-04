// Source-checkout runner only; not imported by any public entry point.

import { Command } from "commander";
import { jevClaimsAction, jevDocClaimsAction, jevStateMachinesAction, jevTestTitlesAction } from "../../commands/jev.js";
import {
	semanticGraphBuildAction,
	semanticGraphConfirmAction,
	semanticGraphRefreshAction,
} from "../../commands/semantic-graph-internal.js";

type BuildFlags = { maxUsd?: string; types?: string; since?: string; maxPackets?: string; json?: boolean };

/** `semantic-graph build|refresh|confirm`: Jev judges packets, Haiku confirms the top slice. Never gates. */
function addSemanticGraphCommands(jev: Command): void {
	const graph = jev.command("semantic-graph").description("Build, refresh and confirm the semantic graph (sends unit text to TypeSafe)");
	const withBuildFlags = (command: Command): Command =>
		command
			.option("--max-usd <n>", "Jev spend ceiling for this run (USD)")
			.option("--types <a,b>", "Relationship type names (default: every configured type)")
			.option("--since <when>", "Co-change window, a git --since value")
			.option("--max-packets <n>", "Per type, the most packets asked after the unchanged skip")
			.option("--json", "Machine-readable output");
	withBuildFlags(graph.command("build").description("Judge every packet without a live judgment")).action(async (opts: BuildFlags) => {
		process.exitCode = await semanticGraphBuildAction(opts);
	});
	withBuildFlags(graph.command("refresh").description("Mark changed sources stale, then build")).action(async (opts: BuildFlags) => {
		process.exitCode = await semanticGraphRefreshAction(opts);
	});
	graph
		.command("confirm")
		.description("Haiku confirmation of the top slice of proposed edges")
		.option("--max-calls <n>", "Ceiling on Haiku spawns")
		.option("--fraction <f>", "Top slice fraction (default 0.05, floor 5)")
		.option("--json", "Machine-readable output")
		.action(async (opts: { maxCalls?: string; fraction?: string; json?: boolean }) => {
			process.exitCode = await semanticGraphConfirmAction(opts);
		});
}

export function createInternalJevProgram(): Command {
	const jev = new Command("internal-jev")
		.description("Internal Jev evaluation; sends evidence to TypeSafe using TYPESAFE_API_KEY");
	jev
		.command("test-titles <files...>")
		.description("Flag it()/test() blocks whose body may not test what the title claims")
		.option("--json", "Machine-readable output")
		.action(async (files: string[], opts: { json?: boolean }) => {
			process.exitCode = await jevTestTitlesAction(files, opts);
		});
	jev
		.command("state-machines <files...>")
		.description("Select implicit state-machine scopes and ask Jev whether their fields form one lifecycle (operating point unmeasured)")
		.option("--dry-run", "Print candidates, Jev packets and stale-handle findings; build no client and call nothing")
		.option("--nullable-slots", "Measured selector variant: count nullable records as lifecycle fields")
		.option("--json", "Machine-readable output")
		.action(async (files: string[], opts: { dryRun?: boolean; nullableSlots?: boolean; json?: boolean }) => {
			process.exitCode = await jevStateMachinesAction(files, opts);
		});
	jev
		.command("doc-claims <files...>")
		.description("Flag doc paragraphs that claim a module is live while nothing imports it")
		.option("--json", "Machine-readable output")
		.action(async (files: string[], opts: { json?: boolean }) => {
			process.exitCode = await jevDocClaimsAction(files, opts);
		});
	jev
		.command("claims <final-message-file> <transcript-file>")
		.description("Compare a saved final message with its Claude Code transcript")
		.option("--json", "Machine-readable output")
        .option("--receipt-shadow <links-file>", "Log deterministic receipt comparisons using explicit claim/scope links (off by default)")
		.action(async (finalFile: string, transcript: string, opts: { json?: boolean; receiptShadow?: string }) => {
			process.exitCode = await jevClaimsAction(finalFile, transcript, opts);
		});
	addSemanticGraphCommands(jev);
	return jev;
}
