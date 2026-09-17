import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerJevCommands } from "./jev.js";

describe("registerJevCommands", () => {
	it("P1: registers `jev` with the test-titles and doc-claims subcommands", () => {
		const program = new Command();
		registerJevCommands(program);
		const jev = program.commands.find((c) => c.name() === "jev");
		expect(jev).toBeDefined();
		expect(jev?.commands.map((c) => c.name()).sort()).toEqual(["doc-claims", "test-titles"]);
	});
});
