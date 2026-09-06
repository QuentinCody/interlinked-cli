import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { debtMarkersCommand } from "../commands/debt-markers.js";
import { impactCommand } from "../commands/impact.js";
import { registerDebtImpactCommands } from "./debt-impact.js";

// Mock the action layer (a different module from the registrar SUT) so
// parsing exercises the two `.action(...)` callbacks' wiring — the dynamic
// import + call-through — without walking a real repo or git history.
vi.mock("../commands/impact.js", () => ({
    impactCommand: vi.fn().mockResolvedValue(0),
}));
vi.mock("../commands/debt-markers.js", () => ({
    debtMarkersCommand: vi.fn().mockResolvedValue(undefined),
}));

describe("registerDebtImpactCommands", () => {
    it("registers explicit manual-marker recording options", () => {
        const program = new Command();
        program.command("debt");
        registerDebtImpactCommands(program);
        const debt = program.commands.find((command) => command.name() === "debt");
        const markers = debt?.commands.find((command) => command.name() === "markers");
        expect(markers?.options.map((option) => option.long)).toEqual([
            "--root",
            "--exclude",
            "--cwd",
            "--record",
            "--reason",
            "--json",
            "--short",
            "--full",
        ]);
    });

    it("sets process.exitCode to impactCommand's resolved exit code", async () => {
        vi.mocked(impactCommand).mockClear().mockResolvedValue(3);
        const program = new Command();
        program.command("debt");
        program.exitOverride();
        registerDebtImpactCommands(program);
        const previousExitCode = process.exitCode;
        await program.parseAsync(["node", "interlinked", "impact"]);
        expect(process.exitCode).toBe(3);
        process.exitCode = previousExitCode;
    });

    it("forwards parsed --reason through to debtMarkersCommand for `debt markers`", async () => {
        vi.mocked(debtMarkersCommand).mockClear();
        const program = new Command();
        program.command("debt");
        program.exitOverride();
        registerDebtImpactCommands(program);
        await program.parseAsync([
            "node",
            "interlinked",
            "debt",
            "markers",
            "--reason",
            "cleanup pass",
        ]);
        expect(vi.mocked(debtMarkersCommand)).toHaveBeenCalledWith(
            expect.objectContaining({ reason: "cleanup pass" }),
        );
    });
});
