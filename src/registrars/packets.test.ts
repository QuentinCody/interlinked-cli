import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerPacketsCommands } from "./packets.js";

// Mock the action layer so parsing exercises the registrar's option wiring
// (including the numeric coercions) without touching the filesystem or Jev.
vi.mock("../commands/packets.js", () => ({
	packetsCompileCommand: vi.fn().mockResolvedValue(0),
	packetsStatusCommand: vi.fn().mockReturnValue(0),
	packetsCalibrateExportCommand: vi.fn().mockResolvedValue(0),
	packetsCalibrateScoreCommand: vi.fn().mockResolvedValue(0),
	packetsAdjudicateCommand: vi.fn().mockReturnValue(0),
	packetsReplayCommand: vi.fn().mockResolvedValue(0),
	packetsReplayWindowsCommand: vi.fn().mockResolvedValue(0),
	packetsBudgetCommand: vi.fn().mockReturnValue(0),
	packetsReleaseCommand: vi.fn().mockReturnValue(0),
	packetsRestoreCommand: vi.fn().mockReturnValue(0),
}));

function program(): Command {
	const p = new Command();
	p.exitOverride();
	registerPacketsCommands(p);
	return p;
}

describe("registerPacketsCommands", () => {
	it("P1: registers every packets subcommand", () => {
		const packets = program().commands.find((c) => c.name() === "packets");
		expect((packets?.commands ?? []).map((c) => c.name()).sort()).toEqual(["adjudicate", "budget", "calibrate", "compile", "release", "replay", "replay-windows", "restore", "status"]);
		const calibrate = packets?.commands.find((c) => c.name() === "calibrate");
		expect((calibrate?.commands ?? []).map((c) => c.name()).sort()).toEqual(["export", "score"]);
	});

	it("P2: `--tail-mb` is coerced to a positive number and reaches the action", async () => {
		const { packetsCompileCommand } = await import("../commands/packets.js");
		await program().parseAsync(["node", "il", "packets", "compile", "--from", "draft.json", "--dry", "--tail-mb", "2.5"]);
		expect(packetsCompileCommand).toHaveBeenCalledWith(expect.objectContaining({ from: "draft.json", dry: true, tailMb: 2.5 }));
	});

	it("N1: `--tail-mb` refuses a non-number, zero and a negative value", async () => {
		for (const bad of ["nope", "0", "-3"]) {
			await expect(program().parseAsync(["node", "il", "packets", "replay-windows", "--sessions", "1", "--tail-mb", bad])).rejects.toThrow(/--tail-mb must be a positive number/);
		}
	});

	it("P3: `--sessions` and `--max-events` are positive integers; a fraction is refused", async () => {
		const { packetsReplayCommand } = await import("../commands/packets.js");
		await program().parseAsync(["node", "il", "packets", "replay", "--sessions", "3", "--max-events", "10"]);
		expect(packetsReplayCommand).toHaveBeenCalledWith(expect.objectContaining({ sessions: 3, maxEvents: 10 }));
		await expect(program().parseAsync(["node", "il", "packets", "replay", "--sessions", "1.5"])).rejects.toThrow(/--sessions must be a positive integer/);
	});

	it("P5: `calibrate score --apply --cosign` reaches the action as two flags", async () => {
		const { packetsCalibrateScoreCommand } = await import("../commands/packets.js");
		await program().parseAsync(["node", "il", "packets", "calibrate", "score", "--labels", "a.json", "b.json", "--apply", "--cosign"]);
		expect(packetsCalibrateScoreCommand).toHaveBeenCalledWith(expect.objectContaining({ labels: ["a.json", "b.json"], apply: true, cosign: true }));
	});
	it("P6: `release <file> --only a b --dry` and `restore <file>` reach their actions with the file as `file`", async () => {
		const { packetsReleaseCommand, packetsRestoreCommand } = await import("../commands/packets.js");
		await program().parseAsync(["node", "il", "packets", "release", "CLAUDE.md", "--only", "a", "b", "--dry"]);
		expect(packetsReleaseCommand).toHaveBeenCalledWith(expect.objectContaining({ file: "CLAUDE.md", only: ["a", "b"], dry: true }));
		await program().parseAsync(["node", "il", "packets", "restore", "AGENTS.md", "--json"]);
		expect(packetsRestoreCommand).toHaveBeenCalledWith(expect.objectContaining({ file: "AGENTS.md", json: true }));
	});
	it("P7: `budget --runner codex --json` reaches the action", async () => {
		const { packetsBudgetCommand } = await import("../commands/packets.js");
		await program().parseAsync(["node", "il", "packets", "budget", "--runner", "codex", "--json"]);
		expect(packetsBudgetCommand).toHaveBeenCalledWith(expect.objectContaining({ runner: "codex", json: true }));
	});
	it("P4: `adjudicate <id> <label>` passes both positionals and `--note`", async () => {
		const { packetsAdjudicateCommand } = await import("../commands/packets.js");
		await program().parseAsync(["node", "il", "packets", "adjudicate", "prefer-rg:abc:1:h:e", "false", "--note", "pipe filter"]);
		expect(packetsAdjudicateCommand).toHaveBeenCalledWith(expect.objectContaining({ id: "prefer-rg:abc:1:h:e", label: "false", note: "pipe filter" }));
	});
});
