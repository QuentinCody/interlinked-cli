import type { Command, OptionValues } from "commander";

function common(command: Command): Command {
	return command.option("--cwd <path>", "Repository root").option("--json", "Complete machine-readable evidence")
		.option("--short", "Compact summary").option("--full", "All policy evidence and limitations");
}

function options(opts: OptionValues, command: Command): OptionValues { return { ...command.optsWithGlobals(), ...opts }; }

export function registerMetricsPolicyCommands(metrics: Command): void {
	const policies = metrics.command("policies").description("Inspect, export and evaluate data-only metric and detector profiles");
	common(policies.command("export").description("Export configured metric entries as a shareable profile without changing settings"))
		.option("--id <id>", "Stable profile identity", "current-repository")
		.action(async (opts: OptionValues, command: Command) => {
			const { metricsPoliciesExportCommand } = await import("../commands/metrics-policies.js");
			metricsPoliciesExportCommand(options(opts, command));
		});
	common(policies.command("inspect <profile>").description("Validate known references and inspect an integrity-checked structural proposal"))
		.action(async (profile: string, opts: OptionValues, command: Command) => {
			const { metricsPoliciesInspectCommand } = await import("../commands/metrics-policies.js");
			metricsPoliciesInspectCommand(profile, options(opts, command));
		});
	common(policies.command("evaluate [profile]").description("Evaluate a local profile or configured metric policies with retained raw measurements"))
		.action(async (profile: string | undefined, opts: OptionValues, command: Command) => {
			const { metricsPoliciesEvaluateCommand } = await import("../commands/metrics-policies.js");
			metricsPoliciesEvaluateCommand(profile, options(opts, command));
		});
}
