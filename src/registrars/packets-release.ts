// interlinked-tdd: exempt
// `interlinked packets budget|release|restore` — pure commander wiring; logic
// and tests live in src/commands/packets-release.ts.

import { type Command } from "commander";
import { CWD_FLAG, JSON_FLAG } from "./packets-options.js";

export function registerPacketsRelease(packets: Command): void {
	packets
		.command("budget")
		.description("Per instruction file: characters/tokens held by Pass 1 rules, by live packets (releasable, net of the pointer), by releases, and by shadow packets")
		.option("--runner <name>", "Runner whose liveness decides whether a release saves anything (default: claude-code)")
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (opts: { json?: boolean; cwd?: string; runner?: string }) => {
			const { packetsBudgetCommand } = await import("../commands/packets.js");
			process.exitCode = packetsBudgetCommand(opts);
		});

	packets
		.command("release <file>")
		.description("Move every warn/cosign packet's instruction span out of <file> (verbatim into the packet file, one pointer line left); one transaction with the source hash; never a global ~/ file")
		.option("--only <ids...>", "Release only these packet ids")
		.option("--dry", "Print the plan and write nothing")
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (file: string, opts: { only?: string[]; dry?: boolean; json?: boolean; cwd?: string }) => {
			const { packetsReleaseCommand } = await import("../commands/packets.js");
			process.exitCode = packetsReleaseCommand({ file, ...opts });
		});

	packets
		.command("restore <file>")
		.description("Put every released span back into <file> byte-for-byte and clear the releases (works on a stale or demoted packet set)")
		.option(...JSON_FLAG)
		.option(...CWD_FLAG)
		.action(async (file: string, opts: { json?: boolean; cwd?: string }) => {
			const { packetsRestoreCommand } = await import("../commands/packets.js");
			process.exitCode = packetsRestoreCommand({ file, ...opts });
		});
}
