import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { registerSetupCommands } from "./setup.js";

// ---------------------------------------------------------------------------
// Mock every command implementation the registrar wires — both the directly
// imported ones (clean/disable/doctor/enable/login) and the lazily
// `import()`-ed ones (completions/context/env/init/logout/update/install-hooks/
// uninstall-hooks/mode). Mocking lets us drive each `.action` body end-to-end
// via parseAsync and assert the exact option spread the registrar forwards,
// without touching the real filesystem / network / hook installers.
// ---------------------------------------------------------------------------
const cleanCommand = vi.fn();
const disableCommand = vi.fn();
const doctorCommand = vi.fn();
const enableCommand = vi.fn();
const loginCommand = vi.fn();
const completionsCommand = vi.fn();
const contextCommand = vi.fn();
const envCommand = vi.fn();
const initCommand = vi.fn();
const logoutCommand = vi.fn();
const updateCommand = vi.fn();
const installHooksCommand = vi.fn();
const uninstallHooksCommand = vi.fn();
const modeCommand = vi.fn();
const resolveAuthToken = vi.fn();
const ensureRemoteOnboarding = vi.fn();

vi.mock("../commands/clean.js", () => ({ cleanCommand: (...a: unknown[]) => cleanCommand(...a) }));
vi.mock("../commands/disable.js", () => ({
	disableCommand: (...a: unknown[]) => disableCommand(...a),
}));
vi.mock("../commands/doctor.js", () => ({ doctorCommand: (...a: unknown[]) => doctorCommand(...a) }));
vi.mock("../commands/enable.js", () => ({ enableCommand: (...a: unknown[]) => enableCommand(...a) }));
vi.mock("../commands/login.js", () => ({ loginCommand: (...a: unknown[]) => loginCommand(...a) }));
vi.mock("../commands/completions.js", () => ({
	completionsCommand: (...a: unknown[]) => completionsCommand(...a),
}));
vi.mock("../commands/context.js", () => ({
	contextCommand: (...a: unknown[]) => contextCommand(...a),
}));
vi.mock("../commands/env.js", () => ({ envCommand: (...a: unknown[]) => envCommand(...a) }));
vi.mock("../commands/init.js", () => ({ initCommand: (...a: unknown[]) => initCommand(...a) }));
vi.mock("../commands/logout.js", () => ({ logoutCommand: (...a: unknown[]) => logoutCommand(...a) }));
vi.mock("../commands/update.js", () => ({ updateCommand: (...a: unknown[]) => updateCommand(...a) }));
vi.mock("../commands/install-hooks.js", () => ({
	installHooksCommand: (...a: unknown[]) => installHooksCommand(...a),
}));
vi.mock("../commands/uninstall-hooks.js", () => ({
	uninstallHooksCommand: (...a: unknown[]) => uninstallHooksCommand(...a),
}));
vi.mock("../commands/mode.js", () => ({ modeCommand: (...a: unknown[]) => modeCommand(...a) }));
vi.mock("../lib/auth.js", () => ({ resolveAuthToken: (...a: unknown[]) => resolveAuthToken(...a) }));
vi.mock("../lib/onboarding.js", () => ({
	ensureRemoteOnboarding: (...a: unknown[]) => ensureRemoteOnboarding(...a),
}));
// formatter.c is pure (ANSI/dim helpers); keep the real module — only assert
// console.log call counts in the setup-action branches, never exact ANSI bytes.

function build(): Command {
	const program = new Command();
	program.exitOverride(); // throw on parse errors instead of process.exit
	registerSetupCommands(program);
	return program;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = undefined;
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	process.exitCode = undefined;
	logSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Structure — names, alias, options (kept from the original suite).
// ---------------------------------------------------------------------------
describe("registerSetupCommands — structure", () => {
	it("registers the setup / lifecycle top-level commands", () => {
		const program = build();
		const top = program.commands.map((c) => c.name());
		for (const name of [
			"clean",
			"completions",
			"context",
			"disable",
			"doctor",
			"enable",
			"env",
			"init",
			"login",
			"logout",
			"setup",
			"update",
			"install-hooks",
			"uninstall-hooks",
			"mode",
		]) {
			expect(top).toContain(name);
		}
	});

	it("exposes the upgrade alias on update", () => {
		const program = build();
		const update = program.commands.find((c) => c.name() === "update");
		if (!update) throw new Error("update not registered");
		expect(update.aliases()).toContain("upgrade");
	});

	it("wires the documented options on enable", () => {
		const program = build();
		const enable = program.commands.find((c) => c.name() === "enable");
		if (!enable) throw new Error("enable not registered");
		expect(enable.options.map((o) => o.long).sort()).toEqual(
			[
				"--agent",
				"--clients",
				"--data-dir",
				"--dry-run",
				"--server",
				"--structure",
				"--sync-mode",
			].sort(),
		);
	});

	it("wires the documented options on install-hooks with defaults", () => {
		const program = build();
		const ih = program.commands.find((c) => c.name() === "install-hooks");
		if (!ih) throw new Error("install-hooks not registered");
		expect(ih.options.map((o) => o.long).sort()).toEqual(
			[
				"--binary",
				"--dry-run",
				"--json",
				"--mode",
				"--preserve-mode",
				"--refresh",
				"--runner",
				"--scope",
			].sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// Direct-binding actions: commander passes (opts, command) straight to the impl.
// ---------------------------------------------------------------------------
describe("direct-binding actions", () => {
	it("clean forwards parsed flags", async () => {
		const program = build();
		await program.parseAsync(["clean", "--force", "--json"], { from: "user" });
		expect(cleanCommand).toHaveBeenCalledTimes(1);
		expect(nonNull(cleanCommand.mock.calls[0])[0]).toMatchObject({ force: true, json: true });
	});

	it("disable forwards --keep-config", async () => {
		const program = build();
		await program.parseAsync(["disable", "--keep-config"], { from: "user" });
		expect(nonNull(disableCommand.mock.calls[0])[0]).toMatchObject({ keepConfig: true });
	});

	it("doctor forwards --fix --json", async () => {
		const program = build();
		await program.parseAsync(["doctor", "--fix", "--json"], { from: "user" });
		expect(nonNull(doctorCommand.mock.calls[0])[0]).toMatchObject({ fix: true, json: true });
	});

	it("enable forwards its full option spread", async () => {
		const program = build();
		await program.parseAsync(
			[
				"enable",
				"--server",
				"https://s",
				"--agent",
				"a",
				"--clients",
				"claude,codex",
				"--sync-mode",
				"local",
				"--data-dir",
				"/d",
				"--structure",
				"strict",
				"--dry-run",
			],
			{ from: "user" },
		);
		expect(nonNull(enableCommand.mock.calls[0])[0]).toMatchObject({
			server: "https://s",
			agent: "a",
			clients: "claude,codex",
			syncMode: "local",
			dataDir: "/d",
			structure: "strict",
			dryRun: true,
		});
	});

	it("does not normalize invalid explicit enable values before validation", async () => {
		const program = build();
		await program.parseAsync(
			["enable", "--clients", "claude,bogus", "--sync-mode", "turbo"],
			{ from: "user" },
		);
		expect(nonNull(enableCommand.mock.calls[0])[0]).toMatchObject({
			clients: "claude,bogus",
			syncMode: "turbo",
		});
	});

	it("login forwards --server --token", async () => {
		const program = build();
		await program.parseAsync(["login", "--server", "https://s", "--token", "tok"], {
			from: "user",
		});
		expect(nonNull(loginCommand.mock.calls[0])[0]).toMatchObject({ server: "https://s", token: "tok" });
	});
});

// ---------------------------------------------------------------------------
// Lazy-import action wrappers: each awaits import() then calls the impl.
// ---------------------------------------------------------------------------
describe("lazy-import action wrappers", () => {
	it("completions passes the shell positional", async () => {
		const program = build();
		await program.parseAsync(["completions", "zsh"], { from: "user" });
		expect(completionsCommand).toHaveBeenCalledWith("zsh");
	});

	it("context passes view opts", async () => {
		const program = build();
		await program.parseAsync(["context", "--json", "--short", "--full"], { from: "user" });
		expect(nonNull(contextCommand.mock.calls[0])[0]).toMatchObject({ json: true, short: true, full: true });
	});

	it("env passes view opts", async () => {
		const program = build();
		await program.parseAsync(["env", "--full"], { from: "user" });
		expect(nonNull(envCommand.mock.calls[0])[0]).toMatchObject({ full: true });
	});

	it("init passes opts including -y/--yes", async () => {
		const program = build();
		await program.parseAsync(
			["init", "--server", "https://s", "--agent", "a", "--sync-mode", "realtime", "-y"],
			{ from: "user" },
		);
		expect(nonNull(initCommand.mock.calls[0])[0]).toMatchObject({
			server: "https://s",
			agent: "a",
			syncMode: "realtime",
			yes: true,
		});
	});

	it("logout passes --all --json", async () => {
		const program = build();
		await program.parseAsync(["logout", "--all", "--json"], { from: "user" });
		expect(nonNull(logoutCommand.mock.calls[0])[0]).toMatchObject({ all: true, json: true });
	});

	it("update passes --force --json", async () => {
		const program = build();
		await program.parseAsync(["update", "--force", "--json"], { from: "user" });
		expect(nonNull(updateCommand.mock.calls[0])[0]).toMatchObject({ force: true, json: true });
	});

	it("update is reachable via the upgrade alias", async () => {
		const program = build();
		await program.parseAsync(["upgrade", "--json"], { from: "user" });
		expect(nonNull(updateCommand.mock.calls[0])[0]).toMatchObject({ json: true });
	});

	it("install-hooks forwards runner/scope/mode/binary and defaults scope+mode", async () => {
		const program = build();
		await program.parseAsync(
			["install-hooks", "--runner", "claude-code,codex", "--binary", "/bin/il", "--dry-run"],
			{ from: "user" },
		);
		expect(nonNull(installHooksCommand.mock.calls[0])[0]).toMatchObject({
			runner: "claude-code,codex",
			binary: "/bin/il",
			scope: "project", // default
			mode: "balanced", // default
			dryRun: true,
		});
	});

	it("does not normalize invalid explicit install values before validation", async () => {
		const program = build();
		await program.parseAsync(
			["install-hooks", "--runner", "claude-code", "--scope", "galaxy", "--mode", "turbo"],
			{ from: "user" },
		);
		expect(nonNull(installHooksCommand.mock.calls[0])[0]).toMatchObject({
			runner: "claude-code",
			scope: "galaxy",
			mode: "turbo",
		});
	});

	it("uninstall-hooks forwards runner + flags", async () => {
		const program = build();
		await program.parseAsync(["uninstall-hooks", "--runner", "codex", "--json"], {
			from: "user",
		});
		expect(nonNull(uninstallHooksCommand.mock.calls[0])[0]).toMatchObject({ runner: "codex", json: true });
	});

	it("mode passes the name positional and opts", async () => {
		const program = build();
		await program.parseAsync(["mode", "strict", "--diff", "--local", "--force", "--json"], {
			from: "user",
		});
		expect(nonNull(modeCommand.mock.calls[0])[0]).toBe("strict");
		expect(nonNull(modeCommand.mock.calls[0])[1]).toMatchObject({
			diff: true,
			local: true,
			force: true,
			json: true,
		});
	});

	it("mode passes undefined name when omitted (show-current path)", async () => {
		const program = build();
		await program.parseAsync(["mode"], { from: "user" });
		expect(nonNull(modeCommand.mock.calls[0])[0]).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// setup — the only action with non-trivial branching. Covers all four exits:
// dry-run, token-login, already-authed (+linked / +not-linked), and login
// fall-through.
// ---------------------------------------------------------------------------
describe("setup action — branches", () => {
	it("stops before auth and onboarding when enable rejects its inputs", async () => {
		enableCommand.mockImplementationOnce(() => {
			process.exitCode = 1;
		});
		const program = build();
		await program.parseAsync(
			["setup", "--clients", "claude,bogus", "--sync-mode", "turbo", "--token", "tok"],
			{ from: "user" },
		);

		expect(process.exitCode).toBe(1);
		expect(loginCommand).not.toHaveBeenCalled();
		expect(resolveAuthToken).not.toHaveBeenCalled();
		expect(ensureRemoteOnboarding).not.toHaveBeenCalled();
	});

	it("dry-run: enables then returns before any auth work", async () => {
		const program = build();
		await program.parseAsync(["setup", "--server", "https://s", "--agent", "a", "--dry-run"], {
			from: "user",
		});
		expect(nonNull(enableCommand.mock.calls[0])[0]).toMatchObject({
			server: "https://s",
			agent: "a",
			dryRun: true,
		});
		expect(loginCommand).not.toHaveBeenCalled();
		expect(resolveAuthToken).not.toHaveBeenCalled();
		expect(ensureRemoteOnboarding).not.toHaveBeenCalled();
	});

	it("forwards clients + sync-mode into the enable call", async () => {
		resolveAuthToken.mockReturnValue("tok"); // short-circuit after enable
		ensureRemoteOnboarding.mockResolvedValue({ status: "skipped" });
		const program = build();
		await program.parseAsync(
			["setup", "--clients", "claude,cursor", "--sync-mode", "manual"],
			{ from: "user" },
		);
		expect(nonNull(enableCommand.mock.calls[0])[0]).toMatchObject({
			clients: "claude,cursor",
			syncMode: "manual",
			dryRun: undefined,
		});
	});

	it("token branch: logs in with the manual token and returns", async () => {
		const program = build();
		await program.parseAsync(["setup", "--server", "https://s", "--token", "tok"], {
			from: "user",
		});
		expect(loginCommand).toHaveBeenCalledWith({ server: "https://s", token: "tok" });
		expect(resolveAuthToken).not.toHaveBeenCalled();
	});

	it("already-authed + linked with handle: skips login, logs linked agent+handle", async () => {
		resolveAuthToken.mockReturnValue("existing");
		ensureRemoteOnboarding.mockResolvedValue({
			status: "linked",
			agentName: "Robo",
			agentHandle: "@robo",
		});
		const program = build();
		await program.parseAsync(["setup", "--server", "https://s"], { from: "user" });
		expect(ensureRemoteOnboarding).toHaveBeenCalledWith({ serverUrl: "https://s" });
		expect(loginCommand).not.toHaveBeenCalled();
		// "Skipping login" line + "Remote agent linked" line.
		expect(logSpy).toHaveBeenCalledTimes(2);
		expect(logSpy.mock.calls[0][0]).toContain("Auth token already present. Skipping login.");
		const linkedLine = logSpy.mock.calls[1][0];
		expect(linkedLine).toContain("Robo");
		expect(linkedLine).toContain("@robo");
	});

	it("already-authed + linked without handle/name: uses the 'agent' fallback, no parens", async () => {
		resolveAuthToken.mockReturnValue("existing");
		ensureRemoteOnboarding.mockResolvedValue({ status: "linked" });
		const program = build();
		await program.parseAsync(["setup"], { from: "user" });
		expect(loginCommand).not.toHaveBeenCalled();
		const linkedLine = logSpy.mock.calls[1][0];
		expect(linkedLine).toContain("Remote agent linked: agent");
		expect(linkedLine).not.toContain("(");
		expect(linkedLine).not.toContain("Stryker was here!");
	});

	it("already-authed + not linked: only the skip line, no second log", async () => {
		resolveAuthToken.mockReturnValue("existing");
		ensureRemoteOnboarding.mockResolvedValue({ status: "skipped" });
		const program = build();
		await program.parseAsync(["setup"], { from: "user" });
		expect(loginCommand).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledTimes(1); // only "Skipping login"
		expect(logSpy.mock.calls[0]?.[0]).toContain("Auth token already present. Skipping login.");
	});

	it("no token, no existing auth: falls through to interactive login", async () => {
		resolveAuthToken.mockReturnValue(null);
		const program = build();
		await program.parseAsync(["setup", "--server", "https://s"], { from: "user" });
		expect(ensureRemoteOnboarding).not.toHaveBeenCalled();
		expect(loginCommand).toHaveBeenCalledWith({ server: "https://s" });
	});
});
