// ===========================================
// Jev registrar — `interlinked jev test-titles|doc-claims`
// ===========================================
// On-demand, opt-in semantic checks backed by TypeSafe's Jev model
// (docs/external-pulse/typesafe-jev.md). Actions live in src/commands/jev.ts.

import type { Command } from "commander";
import { jevDocClaimsAction, jevTestTitlesAction } from "../commands/jev.js";

export function registerJevCommands(program: Command): void {
	const jev = program
		.command("jev")
		.description("Opt-in semantic checks via TypeSafe Jev (advisory; needs jev.enabled + TYPESAFE_API_KEY)");
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
}
