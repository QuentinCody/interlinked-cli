import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { capsExplainAction, capsSetAction, capsShowAction } from "../commands/caps.js";
import { capsRatchetAction, capsStatusAction } from "../commands/caps-ratchet.js";
import { capsProposeAction } from "../commands/metrics-complexity.js";
import { registerCapsCommands } from "./caps.js";

// Mock the action layer (a different module from the registrar SUT) so parsing a
// subcommand exercises the `.action(...)` wiring without real file writes.
vi.mock("../commands/caps.js", () => ({
	capsShowAction: vi.fn().mockResolvedValue(0),
	capsSetAction: vi.fn().mockResolvedValue(0),
	capsExplainAction: vi.fn().mockResolvedValue(0),
}));
vi.mock("../commands/caps-ratchet.js", () => ({
	capsRatchetAction: vi.fn().mockResolvedValue(0),
	capsStatusAction: vi.fn().mockResolvedValue(0),
}));
// caps.ts loads this one lazily (`await import(...)`) to avoid pulling the
// metrics-complexity census machinery into every `caps` invocation — vi.mock
// intercepts the dynamic import the same way it does a static one.
vi.mock("../commands/metrics-complexity.js", () => ({
	capsProposeAction: vi.fn().mockResolvedValue(0),
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

	it("wires `caps ratchet <metric> --to <n>` to capsRatchetAction", async () => {
		vi.mocked(capsRatchetAction).mockClear();
		const program = new Command();
		program.exitOverride();
		registerCapsCommands(program);
		await program.parseAsync(["node", "interlinked", "caps", "ratchet", "cyclomatic", "--to", "16"]);
		expect(vi.mocked(capsRatchetAction)).toHaveBeenCalledWith(
			"cyclomatic",
			expect.objectContaining({ to: "16" }),
		);
	});

	it("wires `caps propose` to capsProposeAction through its lazy dynamic import", async () => {
		vi.mocked(capsProposeAction).mockClear();
		vi.mocked(capsStatusAction).mockClear();
		const program = new Command();
		program.exitOverride();
		registerCapsCommands(program);
		await program.parseAsync(["node", "interlinked", "caps", "propose"]);
		// The observable this line exists to produce is DISPATCH: `propose` reaches
		// its own lazily-imported action, not some other caps subcommand's action.
		expect(vi.mocked(capsProposeAction)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(capsStatusAction)).not.toHaveBeenCalled();
	});

	it("wires `caps status` to capsStatusAction", async () => {
		vi.mocked(capsStatusAction).mockClear();
		vi.mocked(capsProposeAction).mockClear();
		const program = new Command();
		program.exitOverride();
		registerCapsCommands(program);
		await program.parseAsync(["node", "interlinked", "caps", "status"]);
		expect(vi.mocked(capsStatusAction)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(capsProposeAction)).not.toHaveBeenCalled();
	});
});
