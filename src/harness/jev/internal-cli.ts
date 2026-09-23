// Source-checkout runner only; not imported by any public entry point.

import { Command } from "commander";
import { jevClaimsAction, jevDocClaimsAction, jevTestTitlesAction } from "../../commands/jev.js";

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
		.action(async (finalFile: string, transcript: string, opts: { json?: boolean }) => {
			process.exitCode = await jevClaimsAction(finalFile, transcript, opts);
		});
	return jev;
}
