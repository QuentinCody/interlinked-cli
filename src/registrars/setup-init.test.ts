import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../commands/clean.js", () => ({ cleanCommand: vi.fn() }));
vi.mock("../commands/disable.js", () => ({ disableCommand: vi.fn() }));
vi.mock("../commands/doctor.js", () => ({ doctorCommand: vi.fn() }));
vi.mock("../commands/enable.js", () => ({ enableCommand: vi.fn() }));
vi.mock("../commands/login.js", () => ({ loginCommand: vi.fn() }));
vi.mock("../lib/auth.js", () => ({ resolveAuthToken: vi.fn(() => "test-token") }));
vi.mock("../lib/config.js", () => ({ initConfig: vi.fn(), updateLocalConfig: vi.fn() }));
vi.mock("../lib/hooks.js", () => ({
	findProjectRoot: vi.fn(() => null),
	HOOK_SCRIPT_VERSION: "test",
	installAllHooks: vi.fn(() => []),
	writeHookScript: vi.fn(),
}));
vi.mock("../lib/onboarding.js", () => ({ ensureRemoteOnboarding: vi.fn(async () => ({ status: "skipped" })) }));
vi.mock("../lib/settings.js", () => ({ detectClients: vi.fn(() => []) }));
vi.mock("../commands/harness.js", () => ({
	harnessStartCommand: vi.fn(),
	isHarnessRunning: vi.fn(() => ({ running: true, pid: 1 })),
}));
vi.mock("../commands/init-presentation.js", () => ({
	emitDryRun: vi.fn(),
	isLocalServer: vi.fn(() => true),
	printBanner: vi.fn(),
	printCompletion: vi.fn(),
	printDetectedClients: vi.fn(),
	printProjectContext: vi.fn(),
	printServer: vi.fn(),
}));
vi.mock("../lib/api-client.js", () => ({
	InterlinkedClient: class {
		async callTool() { return { agents: [] }; }
	},
}));

import { initCommand } from "../commands/init.js";
import { emitDryRun } from "../commands/init-presentation.js";
import { initConfig, updateLocalConfig } from "../lib/config.js";
import { installAllHooks, writeHookScript } from "../lib/hooks.js";
import { ensureRemoteOnboarding } from "../lib/onboarding.js";
import { registerSetupCommands } from "./setup.js";

afterEach(() => vi.clearAllMocks());

async function parseInit(flags: string[]): Promise<void> {
	const program = new Command().exitOverride();
	registerSetupCommands(program);
	await program.parseAsync([
		"init", "--server", "http://test.invalid", "--agent", "test-agent", "--json", "--yes", ...flags,
	], { from: "user" });
}

describe("registered init with the real command handler", () => {
	it.each(["realtime", "local", "manual"])("previews %s sync without writes or onboarding", async (syncMode) => {
		await parseInit(["--dry-run", "--sync-mode", syncMode]);
		expect(emitDryRun).toHaveBeenCalledWith(
			"http://test.invalid", "test-agent", null, syncMode, [], true,
		);
		expect(initConfig).not.toHaveBeenCalled();
		expect(writeHookScript).not.toHaveBeenCalled();
		expect(installAllHooks).not.toHaveBeenCalled();
		expect(updateLocalConfig).not.toHaveBeenCalled();
		expect(ensureRemoteOnboarding).not.toHaveBeenCalled();
	});

	it.each(["realtime", "local", "manual"])("persists the explicit %s sync mode", async (syncMode) => {
		await parseInit(["--sync-mode", syncMode]);
		expect(updateLocalConfig).toHaveBeenCalledWith({ sync_mode: syncMode }, process.cwd());
		expect(initConfig).toHaveBeenCalledOnce();
	});

	it("defaults an omitted sync mode to realtime", async () => {
		await parseInit([]);
		expect(updateLocalConfig).toHaveBeenCalledWith({ sync_mode: "realtime" }, process.cwd());
	});

	it.each(["invalid", ""])("rejects explicit invalid sync mode %j before effects", async (syncMode) => {
		await expect(parseInit(["--sync-mode", syncMode])).rejects.toThrow("Invalid --sync-mode");
		expect(initConfig).not.toHaveBeenCalled();
		expect(writeHookScript).not.toHaveBeenCalled();
		expect(ensureRemoteOnboarding).not.toHaveBeenCalled();
	});

	it("preserves legacy direct-call option spelling", async () => {
		await initCommand({ "dry-run": true, "sync-mode": "manual", server: "http://test.invalid", agent: "test-agent", json: true });
		expect(emitDryRun).toHaveBeenCalledWith("http://test.invalid", "test-agent", null, "manual", [], true);
		expect(initConfig).not.toHaveBeenCalled();
	});
});
