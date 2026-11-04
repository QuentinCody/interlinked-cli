import { describe, expect, it } from "vitest";
import { createInternalJevProgram } from "./internal-cli.js";

describe("createInternalJevProgram", () => {
	it("retains all four review modes plus the semantic-graph group in the internal runner", () => {
		const jev = createInternalJevProgram();
		expect(jev).toBeDefined();
		expect(jev.commands.map((c) => c.name()).sort()).toEqual(["claims", "doc-claims", "semantic-graph", "state-machines", "test-titles"]);
	});

	it("state-machines exposes --dry-run (no client, no network) and the measured --nullable-slots variant", () => {
		const cmd = createInternalJevProgram().commands.find((c) => c.name() === "state-machines");
		expect(cmd?.options.map((o) => o.long)).toEqual(["--dry-run", "--nullable-slots", "--json"]);
	});

	it("semantic-graph carries the three Jev/Haiku-calling actions, none of them public", () => {
		const graph = createInternalJevProgram().commands.find((c) => c.name() === "semantic-graph");
		expect(graph?.commands.map((c) => c.name())).toEqual(["build", "refresh", "confirm"]);
		const build = graph?.commands.find((c) => c.name() === "build");
		expect(build?.options.map((o) => o.long)).toEqual(["--max-usd", "--types", "--since", "--max-packets", "--json"]);
	});
});
