import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDataCommands } from "./data.js";

const mocks = vi.hoisted(() => ({
    maintenance: vi.fn<typeof import("../commands/data-maintenance.js").dataMaintenanceCommand>(),
    lab: vi.fn<typeof import("../commands/data-lab.js").dataLabCommand>(),
}));

vi.mock("../commands/data-maintenance.js", () => ({ dataMaintenanceCommand: mocks.maintenance }));
vi.mock("../commands/data-lab.js", () => ({ dataLabCommand: mocks.lab }));

function program(): Command {
    const cli = new Command().exitOverride();
    registerDataCommands(cli);
    return cli;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("data command argument forwarding", () => {
    it("passes automation choices and import/rotation budgets to configure", async () => {
        await program().parseAsync([
            "data", "configure", "--auto-index", "on", "--auto-compact", "off",
            "--index-mb", "96", "--index-records", "1200", "--keep-live-mb", "12",
            "--compact-at-mb", "48", "--cwd", "/repo", "--json",
        ], { from: "user" });

        expect(mocks.maintenance).toHaveBeenCalledExactlyOnceWith("configure", {
            autoIndex: "on", autoCompact: "off", indexMb: "96", indexRecords: "1200",
            keepLiveMb: "12", compactAtMb: "48", cwd: "/repo", json: true,
        });
    });

    it("passes explicit transcript source and disk budget to the lab operation", async () => {
        await program().parseAsync([
            "data", "lab", "snapshot", "--native-dir", "/transcripts", "--disk-mb", "24",
            "--out", "/experiment", "--cwd", "/repo",
        ], { from: "user" });

        expect(mocks.lab).toHaveBeenCalledExactlyOnceWith("snapshot", expect.objectContaining({
            nativeDir: "/transcripts", diskMb: "24", out: "/experiment", cwd: "/repo",
        }));
        expect(mocks.maintenance).not.toHaveBeenCalled();
    });

    it("uses the bounded lab default and does not invent a transcript source", async () => {
        await program().parseAsync(["data", "lab", "build"], { from: "user" });
        expect(mocks.lab).toHaveBeenCalledExactlyOnceWith("build", expect.objectContaining({ diskMb: "8" }));
        expect(mocks.lab.mock.calls[0]?.[1]).not.toHaveProperty("nativeDir");
    });
});
