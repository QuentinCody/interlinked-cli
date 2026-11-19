import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { mcpStdioCommand } from "../commands/mcp.js";
import { registerMcpCommands } from "./mcp.js";

// Mock the action layer (a different module from the registrar SUT) so parsing
// exercises the `.action(...)` wiring without spawning a real MCP server process.
vi.mock("../commands/mcp.js", () => ({
	mcpStdioCommand: vi.fn().mockResolvedValue(undefined),
}));

describe("registerMcpCommands", () => {
	it("registers the mcp command group with a stdio subcommand and its options", () => {
		const program = new Command();
		registerMcpCommands(program);
		const mcp = program.commands.find((c) => c.name() === "mcp");
		expect(mcp).toBeDefined();
		const stdio = mcp?.commands.find((c) => c.name() === "stdio");
		expect(stdio).toBeDefined();
		const optionNames = (stdio?.options ?? []).map((o) => o.long).sort();
		expect(optionNames).toEqual([
			"--cwd",
			"--inline-limit",
			"--server",
			"--server-cwd",
			"--session",
		]);
		const inlineLimitOpt = stdio?.options.find((o) => o.long === "--inline-limit");
		expect(inlineLimitOpt?.defaultValue).toBe("262144");
	});

	it("requires --server", async () => {
		const program = new Command();
		program.exitOverride();
		program.configureOutput({ writeErr: () => {} });
		registerMcpCommands(program);
		await expect(
			program.parseAsync(["node", "interlinked", "mcp", "stdio", "real-cmd"]),
		).rejects.toThrow();
	});

	it("reports command input errors through Commander", async () => {
		const program = new Command().exitOverride();
		const writeErr = vi.fn();
		program.configureOutput({ writeErr });
		registerMcpCommands(program);
		const message = 'invalid --inline-limit "1.5"; expected a non-negative integer';
		vi.mocked(mcpStdioCommand).mockRejectedValueOnce(new Error(message));
		await expect(program.parseAsync(["mcp", "stdio", "--server", "demo", "--inline-limit", "1.5", "--", "node"], { from: "user" }))
			.rejects.toMatchObject({ exitCode: 1, message });
		expect(writeErr).toHaveBeenCalledWith(`${message}\n`);
	});

	it("forwards required + optional string options to mcpStdioCommand", async () => {
		vi.mocked(mcpStdioCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerMcpCommands(program);
		await program.parseAsync([
			"node",
			"interlinked",
			"mcp",
			"stdio",
			"--server",
			"my-server",
			"--cwd",
			"/tmp/workspace",
			"--server-cwd",
			"/tmp/server",
			"--session",
			"sess-1",
			"--inline-limit",
			"2048",
			"real-cmd",
			"arg1",
			"arg2",
		]);
		expect(vi.mocked(mcpStdioCommand)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(mcpStdioCommand)).toHaveBeenCalledWith("real-cmd", ["arg1", "arg2"], {
			server: "my-server",
			cwd: "/tmp/workspace",
			serverCwd: "/tmp/server",
			session: "sess-1",
			inlineLimit: "2048",
		});
	});

	it("passes undefined for omitted optional options, keeping the default inline limit", async () => {
		vi.mocked(mcpStdioCommand).mockClear();
		const program = new Command();
		program.exitOverride();
		registerMcpCommands(program);
		await program.parseAsync([
			"node",
			"interlinked",
			"mcp",
			"stdio",
			"--server",
			"my-server",
			"real-cmd",
		]);
		expect(vi.mocked(mcpStdioCommand)).toHaveBeenCalledWith("real-cmd", [], {
			server: "my-server",
			cwd: undefined,
			serverCwd: undefined,
			session: undefined,
			inlineLimit: "262144",
		});
	});
});
