import { Command } from "commander";
import { expect, it } from "vitest";
import { registerDecisionMetricCommands } from "./metrics-decisions.js";

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
