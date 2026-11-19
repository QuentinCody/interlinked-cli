// interlinked-tdd: exempt
// `interlinked packets calibrate export|score` — pure commander wiring; logic
// and tests live in src/commands/packets.ts.

import { type Command } from "commander";
import { CWD_FLAG, JSON_FLAG, positiveNumber } from "./packets-options.js";

export function registerPacketsCalibrate(packets: Command): void {
	const calibrate = packets.command("calibrate").description("Blind-label export and session-split holdout scoring; the only writer of a packet's calibration");

	calibrate
		.command("export")
		.description("Write a blind label sheet (evidence re-rendered from collection.jsonl, no scores) for every judged row")
		.requiredOption("--out <file>", "Where to write the JSONL sheet")
		.option("--tail-mb <n>", "Newest megabytes of collection.jsonl to join (default: 256)", positiveNumber("--tail-mb"))
		.option(...CWD_FLAG)
		.action(async (opts: { out: string; tailMb?: number; cwd?: string }) => {
			const { packetsCalibrateExportCommand } = await import("../commands/packets.js");
			process.exitCode = await packetsCalibrateExportCommand(opts);
		});

	calibrate
		.command("score")
		.description("Score two or more independent label files per packet (κ, session-split tau, holdout AUROC/precision); --apply promotes packets that clear the floors")
		.requiredOption("--labels <file...>", "Label files, at least two")
		.option("--apply", "Write promotions into .interlinked/instruction-packets.json")
		.option("--cosign", "With --apply: allow warn → cosign (allow becomes ask at PreToolUse) when holdout recall and the adjudication body suffice")
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (opts: { labels: string[]; apply?: boolean; cosign?: boolean; json?: boolean; cwd?: string }) => {
			const { packetsCalibrateScoreCommand } = await import("../commands/packets.js");
			process.exitCode = await packetsCalibrateScoreCommand(opts);
		});
}
