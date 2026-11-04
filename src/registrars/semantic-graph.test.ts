import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSemanticGraphCommands } from "./semantic-graph.js";

describe("registerSemanticGraphCommands — positive (must fire)", () => {
	it("P1: registers the read-only semantic-graph command group", () => {
		const program = new Command();
		registerSemanticGraphCommands(program);
		const group = program.commands.find((command) => command.name() === "semantic-graph");
		expect(group?.commands.map((command) => command.name())).toEqual(["metrics", "status", "edges"]);
	});

	it("P2: edges takes --type, --state and --limit", () => {
		const program = new Command();
		registerSemanticGraphCommands(program);
		const edges = program.commands.find((c) => c.name() === "semantic-graph")?.commands.find((c) => c.name() === "edges");
		expect(edges?.options.map((option) => option.long)).toEqual(expect.arrayContaining(["--type", "--state", "--limit", "--json"]));
	});
});

describe("registerSemanticGraphCommands — negative (must not fire)", () => {
	it("N1: registers no Jev-calling action on the public program", () => {
		const program = new Command();
		registerSemanticGraphCommands(program);
		const names = program.commands.find((command) => command.name() === "semantic-graph")?.commands.map((command) => command.name()) ?? [];
		expect(names).not.toContain("build");
		expect(names).not.toContain("refresh");
		expect(names).not.toContain("confirm");
	});
});
