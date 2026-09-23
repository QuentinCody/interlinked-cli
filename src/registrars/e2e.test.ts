import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { e2eScaffoldCommand } from "../commands/e2e.js";
import { registerE2eCommands } from "./e2e.js";
vi.mock("../commands/e2e.js", () => ({ e2eScaffoldCommand: vi.fn() }));
describe("e2e registrar", () => {
    it("forwards the scaffold shape and dry run", async () => {
        const program = new Command();
        registerE2eCommands(program);
        await program.parseAsync(["node", "interlinked", "e2e", "scaffold", "policy", "--event", "Stop", "--tool", "Read", "--dry-run"]);
        expect(e2eScaffoldCommand).toHaveBeenCalledWith("policy", expect.objectContaining({ event: "Stop", tool: "Read", dryRun: true }));
    });
});
