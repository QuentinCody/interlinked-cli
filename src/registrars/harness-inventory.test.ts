import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHarnessInventory } from "./harness-inventory.js";

const calls = vi.hoisted(() => ({ verify: vi.fn(), coverage: vi.fn() }));
vi.mock("../commands/harness-coverage-verify.js", () => ({ harnessCoverageVerifyCommand: calls.verify }));
vi.mock("../commands/harness-capabilities.js", () => ({ harnessCoverageCommand: calls.coverage }));
beforeEach(() => { vi.clearAllMocks(); });

function parse(args: string[]): Promise<Command> {
    const harness = new Command().exitOverride();
    registerHarnessInventory(harness);
    return harness.parseAsync(args, { from: "user" });
}

describe("coverage recovery command arguments", () => {
    it("starts background verification when --no-wait is requested", async () => {
        await parse(["coverage", "verify", "--no-wait", "--json"]);
        expect(calls.verify).toHaveBeenCalledExactlyOnceWith({ wait: false, json: true });
    });

    it("passes exact review identity and numeric generation to the daemon", async () => {
        await parse(["coverage", "acknowledge", "id", "7", "hash", "review evidence", "--json"]);
        expect(calls.coverage).toHaveBeenCalledExactlyOnceWith({ operation: "acknowledge", id: "id", generation: 7, identity: "hash", evidence: "review evidence" }, { json: true });
    });

    it.each(["1.5", "invalid"])("rejects an invalid review generation %s before mutation", async generation => {
        await expect(parse(["coverage", "acknowledge", "id", generation, "hash", "review"])).rejects.toThrow("generation must be a nonnegative integer");
        expect(calls.coverage).not.toHaveBeenCalled();
    });
});
