import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../commands/clean.js", () => ({ cleanCommand: vi.fn() }));
vi.mock("../commands/disable.js", () => ({ disableCommand: vi.fn() }));
vi.mock("../commands/doctor.js", () => ({ doctorCommand: vi.fn() }));
vi.mock("../commands/enable.js", () => ({ enableCommand: vi.fn() }));
vi.mock("../commands/login.js", () => ({ loginCommand: vi.fn() }));
vi.mock("../harness/installer.js", () => ({
	manifestPath: vi.fn(() => "/test/installer-manifest.json"),
	uninstallHooks: vi.fn(() => ({ removed: [], remaining: [] })),
}));

import { uninstallHooks } from "../harness/installer.js";
import { registerSetupCommands } from "./setup.js";

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

async function parseUninstall(flags: string[]): Promise<void> {
	const program = new Command().exitOverride();
	registerSetupCommands(program);
	await program.parseAsync(["uninstall-hooks", "--json", ...flags], { from: "user" });
}

describe("registered uninstall-hooks with the real command handler", () => {
	it.each(["", " ", "unknown", "claude-code,unknown"])("rejects explicit invalid runner %j before removal", async (runner) => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await expect(parseUninstall(["--runner", runner])).rejects.toThrow("Unknown runner:");
		expect(uninstallHooks).not.toHaveBeenCalled();
	});

	it.each([[], ["--runner", "all"]])("retains the all-runner selection for %j", async (...flags) => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await parseUninstall(flags);
		expect(uninstallHooks).toHaveBeenCalledWith({ cwd: process.cwd(), dryRun: false });
	});

	it("forwards a valid runner and dry-run", async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		await parseUninstall(["--runner", "claude-code", "--dry-run"]);
		expect(uninstallHooks).toHaveBeenCalledWith({ cwd: process.cwd(), runners: ["claude-code"], dryRun: true });
	});
});
