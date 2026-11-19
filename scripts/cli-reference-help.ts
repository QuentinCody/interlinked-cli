import type { Command } from "commander";

/** Render a documented command without parsing argv or executing its action. */
export function cliReferenceHelp(program: Command, path: readonly string[]): string {
	let command = program;
	for (const token of path) {
		const child = command.commands.find(candidate => candidate.name() === token || candidate.aliases().includes(token));
		if (!child) throw new Error(`Unknown documentation command: ${[program.name(), ...path].join(" ")}`);
		command = child;
	}

	const previous = { ...command.configureOutput() };
	let raw = "";
	try {
		// The published reference uses Commander's 80-column non-terminal layout.
		command.configureOutput({ writeOut: text => { raw += text; }, getOutHelpWidth: () => 80 });
		command.outputHelp();
	} finally {
		command.configureOutput(previous);
	}
	const footer = raw.indexOf("\nInterface boundaries:");
	return (footer < 0 ? raw : raw.slice(0, footer)).trim().replaceAll(process.cwd(), "<cwd>");
}
