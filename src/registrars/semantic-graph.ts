import type { Command } from "commander";
import { semanticGraphEdgesAction, semanticGraphMetricsAction, semanticGraphStatusAction } from "../commands/semantic-graph.js";

/** Public, read-only views of the semantic graph. The Jev/Haiku actions stay on the internal runner. */
export function registerSemanticGraphCommands(program: Command): void {
	const group = program.command("semantic-graph").description("Read the opt-in semantic graph (typed edges judged by a decision model; ranks, never gates)");

	group.command("metrics")
		.description("Four metrics per relationship type: orphans, mismatches, hidden coupling, churn")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (options: { cwd?: string; json?: boolean }) => {
			process.exitCode = await semanticGraphMetricsAction(options);
		});

	group.command("status")
		.description("Edge counts by type and state, units, malformed rows, relationships source")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (options: { cwd?: string; json?: boolean }) => {
			process.exitCode = await semanticGraphStatusAction(options);
		});

	group.command("edges")
		.description("Latest live edges by probability")
		.option("--type <name>", "Only this relationship type")
		.option("--state <state>", "Only this edge state (proposed, confirmed, contradicted)")
		.option("--limit <n>", "Maximum rows (default 25)")
		.option("--cwd <path>", "Project root (default: current directory)")
		.option("--json", "Machine-readable output")
		.action(async (options: { type?: string; state?: string; limit?: string; cwd?: string; json?: boolean }) => {
			process.exitCode = await semanticGraphEdgesAction(options);
		});
}
