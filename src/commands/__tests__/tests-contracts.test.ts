import { Command } from "commander";
import { expect, it } from "vitest";
import { registerTestsCommands } from "../../registrars/tests.js";
it("exposes separate read-only inspection, import and explicitly budgeted execution", () => {
    const program = new Command(); registerTestsCommands(program);
    const contracts = program.commands.find(row => row.name() === "tests")?.commands.find(row => row.name() === "contracts");
    expect(contracts?.commands.map(row => row.name())).toEqual(expect.arrayContaining(["inspect", "import", "run"]));
    expect(contracts?.commands.find(row => row.name() === "run")?.options.map(row => row.long)).toContain("--timeout");
});
