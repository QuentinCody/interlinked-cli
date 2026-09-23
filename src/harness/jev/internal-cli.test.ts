import { describe, expect, it } from "vitest";
import { createInternalJevProgram } from "./internal-cli.js";

describe("createInternalJevProgram", () => {
	it("retains all three review modes in the internal runner", () => {
		const jev = createInternalJevProgram();
		expect(jev).toBeDefined();
		expect(jev.commands.map((c) => c.name()).sort()).toEqual(["claims", "doc-claims", "test-titles"]);
	});
});
