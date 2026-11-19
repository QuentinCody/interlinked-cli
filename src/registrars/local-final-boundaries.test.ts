import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDoctestCommand } from "../commands/doctest.js";
import { registerActivityCommands } from "./activity.js";
import { registerHarnessCommands } from "./harness.js";

vi.mock("../lib/api-client.js", () => ({
	getClient: () => ({
		isAuthenticated: () => true,
		isLocalDevServer: () => false,
		getConfig: () => ({ agent_name: "fixture" }),
		healthCheck: async () => null,
	}),
}));

let root: string;
let logs: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "local-cli-boundaries-"));
	vi.spyOn(process, "cwd").mockReturnValue(root);
	vi.stubEnv("INTERLINKED_HOME", join(root, ".interlinked"));
	logs = vi.spyOn(console, "log").mockImplementation(() => {});
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
	process.exitCode = 0;
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = 0;
	rmSync(root, { recursive: true, force: true });
});

describe("local registered command boundaries", () => {
	it("reports a missing doctest target as unavailable", async () => {
		const program = new Command().exitOverride();
		registerDoctestCommand(program);
		await program.parseAsync(["doctest", "--path", join(root, "missing.md"), "--json"], { from: "user" });
		expect(process.exitCode).toBe(1);
		expect(logs).not.toHaveBeenCalled();
		expect(JSON.parse(String(errors.mock.calls[0]?.[0])).error).toContain("missing.md");
	});

	it("accepts an existing empty doctest directory", async () => {
		const program = new Command().exitOverride();
		registerDoctestCommand(program);
		await program.parseAsync(["doctest", "--path", root, "--json"], { from: "user" });
		expect(JSON.parse(String(logs.mock.calls[0]?.[0]))).toEqual({ total: 0, failed: 0, failures: [] });
		expect(process.exitCode).toBe(0);
	});

	it("keeps JSON status refreshes free of human output and terminal escapes", async () => {
		vi.useFakeTimers();
		const writes = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const program = new Command().exitOverride();
		registerActivityCommands(program);
		await program.parseAsync(["status", "--watch", "2", "--json"], { from: "user" });
		await vi.advanceTimersByTimeAsync(4000);
		expect(logs.mock.calls).toHaveLength(3);
		for (const call of logs.mock.calls) {
			expect(JSON.parse(String(call[0]))).toHaveProperty("sessions");
		}
		expect(writes).not.toHaveBeenCalled();
	});

	it.each([false, true])("preserves a listening fixture socket with stale PID present %s", async (hasPid) => {
		mkdirSync(join(root, ".interlinked"));
		const socket = join(root, ".interlinked", "harness.sock");
		const pid = join(root, ".interlinked", "harness.pid");
		if (hasPid) writeFileSync(pid, "999999");
		const server = createServer((connection) => connection.destroy());
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socket, resolve);
		});
		try {
			const program = new Command().exitOverride();
			registerHarnessCommands(program);
			await program.parseAsync(["harness", "clean", "--json"], { from: "user" });
			expect(server.listening).toBe(true);
			expect(existsSync(socket)).toBe(true);
			expect(existsSync(pid)).toBe(hasPid);
			expect(process.exitCode).toBe(1);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("cleans stale socket and PID files after confirming no listener", async () => {
		mkdirSync(join(root, ".interlinked"));
		const socket = join(root, ".interlinked", "harness.sock");
		const pid = join(root, ".interlinked", "harness.pid");
		// Process exit leaves the Unix pathname behind without a listener.
		execFileSync(process.execPath, [
			"-e",
			"require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
			socket,
		]);
		expect(existsSync(socket)).toBe(true);
		writeFileSync(pid, "999999");
		const program = new Command().exitOverride();
		registerHarnessCommands(program);
		await program.parseAsync(["harness", "clean", "--json"], { from: "user" });
		expect(existsSync(socket)).toBe(false);
		expect(existsSync(pid)).toBe(false);
		expect(JSON.parse(String(logs.mock.calls[0]?.[0]))).toEqual({ ok: true, removed: [pid, socket] });
		expect(process.exitCode).toBe(0);
	});
});
