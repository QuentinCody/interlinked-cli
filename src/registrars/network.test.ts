import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { registerNetworkCommands } from "./network.js";
import { networkCheckCommand, networkCodexProfileCommand } from "../commands/network.js";
vi.mock("../commands/network.js", () => ({ networkCheckCommand: vi.fn(), networkCodexProfileCommand: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); });

it("routes endpoint checks and explicit profile installation", async () => {
    const program = new Command();
    program.exitOverride();
    registerNetworkCommands(program);
    await program.parseAsync(["network", "check", "http://127.0.0.1:11434", "https://api.typesafe.ai", "--json"], { from: "user" });
    expect(networkCheckCommand).toHaveBeenCalledWith(["http://127.0.0.1:11434", "https://api.typesafe.ai"], { json: true });
    await program.parseAsync(["network", "codex-profile", "research", "--allow", "https://example.com", "--write"], { from: "user" });
    expect(networkCodexProfileCommand).toHaveBeenCalledWith("research", { allow: ["https://example.com"], write: true });
});
