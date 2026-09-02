import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { capsExplainAction, capsSetAction, capsShowAction } from "../commands/caps.js";
import { registerCapsCommands } from "./caps.js";

// Mock the action layer (a different module from the registrar SUT) so parsing a
// subcommand exercises the `.action(...)` wiring without real file writes.
vi.mock("../commands/caps.js", () => ({
	capsShowAction: vi.fn().mockResolvedValue(0),
	capsSetAction: vi.fn().mockResolvedValue(0),
	capsExplainAction: vi.fn().mockResolvedValue(0),
}));

describe("registerCapsCommands", () => {
	it("registers the caps group with set + explain subcommands", () => {
		const program = new Command();
		registerCapsCommands(program);
		const caps = program.commands.find((c) => c.name() === "caps");
		expect(caps).toBeDefined();
		const subs = (caps?.commands ?? []).map((c) => c.name()).sort();
		expect(subs).toEqual(["explain", "propose", "ratchet", "set", "status"]);
	});

	it("runs capsShowAction for a bare `caps` invocation", async () => {
		const program = new Command();
		program.exitOverride();
		registerCapsCommands(program);
		await program.parseAsync(["node", "interlinked", "caps"]);
		expect(vi.mocked(capsShowAction)).toHaveBeenCalledTimes(1);
	});

	it("wires `caps set <metric> <value>` to capsSetAction", async () => {
		vi.mocked(capsSetAction).mockClear();
		const program = new Command();
		program.exitOverride();
		registerCapsCommands(program);
		await program.parseAsync(["node", "interlinked", "caps", "set", "cyclomatic", "15"]);
		expect(vi.mocked(capsSetAction)).toHaveBeenCalledWith("cyclomatic", "15", expect.anything());
	});

	it("wires `caps explain [metric]` to capsExplainAction", async () => {
		vi.mocked(capsExplainAction).mockClear();
		const program = new Command();
		program.exitOverride();
		registerCapsCommands(program);
		await program.parseAsync(["node", "interlinked", "caps", "explain", "crap"]);
		expect(vi.mocked(capsExplainAction)).toHaveBeenCalledWith("crap", expect.anything());
	});
});
