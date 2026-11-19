// interlinked-tdd: exempt
// ===========================================
// Packets registrar — `interlinked packets …`: instruction packets
// (docs/design/instruction-jev-evaluator.md). Pure commander wiring; logic and
// tests live in src/commands/packets*.ts. Sibling registrars hold the
// calibrate, replay and release groups; the pin is src/registrars/packets.test.ts.
// ===========================================

import { type Command } from "commander";
import { registerPacketsCalibrate } from "./packets-calibrate.js";
import { CWD_FLAG, JSON_FLAG, positiveNumber } from "./packets-options.js";
import { registerPacketsRelease } from "./packets-release.js";
import { registerPacketsReplay } from "./packets-replay.js";

export function registerPacketsCommands(program: Command): void {
	const packets = program.command("packets").description("Instruction packets: instruction-file rules compiled into Jev-evaluated hook questions (shadow by default; warn/cosign only on a measured holdout)");

	packets
		.command("compile")
		.description("Compile a draft packet file: hash, carry over calibration, replay triggers over collection.jsonl, write .interlinked/instruction-packets.json")
		.requiredOption("--from <draft.json>", "Draft written by /enforce (packets without hashes or calibration)")
		.option("--dry", "Print the replay table and write nothing")
		.option("--runner <name>", "Runner whose hook delivery is checked (default: claude-code)")
		.option("--tail-mb <n>", "Newest megabytes of collection.jsonl to replay (default: 256)", positiveNumber("--tail-mb"))
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (opts: { from: string; dry?: boolean; runner?: string; tailMb?: number; json?: boolean; cwd?: string }) => {
			const { packetsCompileCommand } = await import("../commands/packets.js");
			process.exitCode = await packetsCompileCommand(opts);
		});

	registerPacketsCalibrate(packets);
	registerPacketsReplay(packets);

	packets
		.command("adjudicate <id> <label>")
		.description("Record whether a delivered [interlinked:packet] warning was right (true), a false positive (false) or unsure; counts as a labeler in calibrate score")
		.option("--note <text>", "Short reason")
		.option(...CWD_FLAG)
		.action(async (id: string, label: string, opts: { note?: string; cwd?: string }) => {
			const { packetsAdjudicateCommand } = await import("../commands/packets.js");
			process.exitCode = packetsAdjudicateCommand({ id, label, ...opts });
		});

	registerPacketsRelease(packets);

	packets
		.command("status")
		.description("List compiled packets with status, tau and release state")
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (opts: { json?: boolean; cwd?: string }) => {
			const { packetsStatusCommand } = await import("../commands/packets.js");
			process.exitCode = packetsStatusCommand(opts);
		});
}
