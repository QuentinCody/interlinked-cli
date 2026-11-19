import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { decisionsAction } from "../commands/metrics-decisions.js";
import { registerDecisionMetricCommands } from "./metrics-decisions.js";

vi.mock("../commands/metrics-decisions.js", () => ({ decisionsAction: vi.fn().mockResolvedValue(0) }));

it("forwards inherited scope through every generated decision action in both flag positions", async () => {
    const inventory = new Command("metrics");
    registerDecisionMetricCommands(inventory);
    const commands = inventory.commands[0]!.commands.filter((command) => command.commands.length === 0);
    expect(commands).toHaveLength(17);
    for (const command of commands) {
        const args = ["decisions", command.name(), ...command.registeredArguments.map(() => "input.json")];
        for (const argv of [["--cwd", "/selected/repo", "--json", ...args], [...args, "--cwd", "/selected/repo", "--json"]]) {
            vi.mocked(decisionsAction).mockClear();
            const metrics = new Command("metrics").option("--cwd <path>").option("--json");
            registerDecisionMetricCommands(metrics);
            await metrics.parseAsync(argv, { from: "user" });
            expect(decisionsAction).toHaveBeenCalledExactlyOnceWith(
                command.name(), command.registeredArguments.length ? "input.json" : undefined,
                expect.objectContaining({ cwd: "/selected/repo", json: true }),
            );
        }
    }
});

it("exposes the experimental measurement and offline audit surfaces", () => {
    const metrics = new Command("metrics");
    registerDecisionMetricCommands(metrics);
    const decisions = metrics.commands.find((command) => command.name() === "decisions");
    expect(decisions?.commands.map((command) => command.name())).toEqual(
        expect.arrayContaining([
            "prepare",
            "measure",
            "review",
            "audit",
            "diff",
            "replay",
            "embed",
        ]),
    );
    expect(
        decisions?.commands
            .find((command) => command.name() === "measure")
            ?.options.map((option) => option.long),
    ).toContain("--plan");
});
