import type { Command, OptionValues } from "commander";

/** Source-only measurement of explicitly selected guidance, with inherited CLI options preserved. */
export function registerMetricsStandardsCommands(metrics: Command): void {
	metrics.command("standards")
		.description("Measure pinned source guidance with explicit syntax, detector, candidate and unknown coverage")
		.option("--profile <name>", "Guidance profile (dmmulroy-typescript)", "dmmulroy-typescript")
		.option("--scope <scope>", "Measured source roles: all or product", "all")
		.option("--cwd <path>", "Repository root")
		.option("--json", "Complete source-bound report")
		.option("--short", "One-line measurement summary")
		.option("--full", "Complete structured report with every occurrence and context gap")
		.action(async (opts: OptionValues, command: Command) => {
			const { metricsStandardsCommand } = await import("../commands/metrics-standards.js");
			metricsStandardsCommand({ ...command.optsWithGlobals(), ...opts });
		});
}
