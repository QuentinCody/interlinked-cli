// ===========================================
// `interlinked harness taint` registrar
// ===========================================
// Operator surface for the session sensitivity label: inspect which source
// set it, and clear a level that a since-fixed detector raised in error.
// `clear` takes no --yes/--force on purpose — see commands/harness-taint.ts.

import type { Command, OptionValues } from "commander";

const TAINT_DESC =
	"Session sensitivity label: inspect which source set it, or clear it (operator)";
const STATUS_DESC =
	"Show a session's sensitivity level per ACTOR, step limit, the source that SET the level, and recent sources";
const CLEAR_DESC =
	"OPERATOR ONLY: lower every actor of a session to Public, or one with --actor. Needs a real terminal and a typed confirmation; no --yes/--force. Audited in .interlinked/taint-clears.jsonl.";

export function registerHarnessTaint(harness: Command): void {
	const taint = harness.command("taint").description(TAINT_DESC);

	taint
		.command("status", { isDefault: true })
		.description(STATUS_DESC)
		.option("--session <id>", "Session id (default: every live session + tainted snapshot)")
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.option("--full", "Detailed output")
		.action(async (opts: OptionValues) => {
			const { harnessTaintStatusCommand } = await import("../commands/harness-taint.js");
			await harnessTaintStatusCommand(opts);
		});

	taint
		.command("clear")
		.description(CLEAR_DESC)
		.requiredOption("--session <id>", "Session id to clear")
		.requiredOption("--reason <text>", "Why — recorded in the audit row and the source history")
		.option(
			"--actor <key>",
			"Clear only this actor (subagent id / agent name; needs a live daemon). Default: every actor",
		)
		.option("--json", "Machine-readable output")
		.option("--short", "One-line summary")
		.action(async (opts: OptionValues) => {
			const { harnessTaintClearCommand } = await import("../commands/harness-taint.js");
			await harnessTaintClearCommand(opts);
		});
}
