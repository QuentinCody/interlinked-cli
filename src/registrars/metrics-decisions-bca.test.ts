import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { registerDecisionMetricCommands } from "./metrics-decisions.js";

const { action } = vi.hoisted(() => ({ action: vi.fn().mockResolvedValue(0) }));
vi.mock("../commands/metrics-decisions.js", () => ({ decisionsAction: action }));

// The executable and exact version supplied by the operator must both reach
// preparation; dropping either option changes tool selection or its version pin.
it("forwards --bca-command and --bca-version unchanged to preparation", async () => {
    const previousExitCode = process.exitCode;
    try {
        const metrics = new Command("metrics");
        registerDecisionMetricCommands(metrics);
        await metrics.parseAsync([
            "decisions", "prepare", "--bca-command", "/tools/bca",
            "--bca-version", "bca fixture-version",
        ], { from: "user" });
        expect(action).toHaveBeenCalledWith("prepare", undefined, {
            bcaCommand: "/tools/bca", bcaVersion: "bca fixture-version",
        });
    } finally {
        process.exitCode = previousExitCode;
    }
});
