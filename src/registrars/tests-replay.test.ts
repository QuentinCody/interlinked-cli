import { Command } from "commander";
import { expect, it } from "vitest";
import { registerE2eReplay } from "./tests-replay.js";
it("registers inspection and explicit replay separately with a bounded default", () => {
    const command = new Command(); registerE2eReplay(command);
    expect(command.commands.map(row => row.name())).toEqual(["attempts", "replay"]);
    expect(command.commands[1]!.options.find(option => option.long === "--timeout")?.defaultValue).toBe("120000");
});
