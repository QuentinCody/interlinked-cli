// interlinked-tdd: exempt
// `interlinked packets replay|replay-windows` — pure commander wiring; logic
// and tests live in src/commands/packets-replay.ts.

import { type Command } from "commander";
import { CWD_FLAG, JSON_FLAG, positiveInteger, positiveNumber } from "./packets-options.js";

export function registerPacketsReplay(packets: Command): void {
	packets
		.command("replay")
		.description("Replay the newest N sessions of collection.jsonl through the shadow evaluator (rows marked source=replay; already-judged calls skipped)")
		.requiredOption("--sessions <n>", "Newest sessions to replay", positiveInteger("--sessions"))
		.option("--max-events <n>", "Upper bound on events sent (default: 2000)", positiveInteger("--max-events"))
		.option("--tail-mb <n>", "Newest megabytes of collection.jsonl to read (default: 256)", positiveNumber("--tail-mb"))
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (opts: { sessions: number; maxEvents?: number; tailMb?: number; json?: boolean; cwd?: string }) => {
			const { packetsReplayCommand } = await import("../commands/packets.js");
			process.exitCode = await packetsReplayCommand(opts);
		});

	packets
		.command("replay-windows")
		.description("Replay the newest N sessions as TURN windows through the trajectory layer (pass 1 screen, pass 2 judge; rows source=replay)")
		.requiredOption("--sessions <n>", "Newest sessions to replay", positiveInteger("--sessions"))
		.option("--tail-mb <n>", "Newest megabytes of each log to read (default: 256)", positiveNumber("--tail-mb"))
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (opts: { sessions: number; tailMb?: number; json?: boolean; cwd?: string }) => {
			const { packetsReplayWindowsCommand } = await import("../commands/packets.js");
			process.exitCode = await packetsReplayWindowsCommand(opts);
		});
}
