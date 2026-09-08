import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn<(binary: string, args: string[], options: { cwd: string }) => SpawnSyncReturns<string>>(),
	existsSync: vi.fn<typeof import("node:fs").existsSync>(),
	mkdirSync: vi.fn<typeof import("node:fs").mkdirSync>(),
	rmSync: vi.fn<typeof import("node:fs").rmSync>(),
	writeFileSync: vi.fn<typeof import("node:fs").writeFileSync>(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
	rmSync: mocks.rmSync,
	writeFileSync: mocks.writeFileSync,
}));

class ExitError extends Error {
	constructor(public readonly code: number) {
		super(`exit:${code}`);
	}
}

const originalArgv = process.argv;
let hookInstalled = false;
let installCount = 0;
let statusReply: string | undefined;

function response(stdout = "", status = 0, stderr = ""): SpawnSyncReturns<string> {
	return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null };
}

/** Scripted CLI replies; the real scenario chooses and evaluates every command. */
function runCommand(command: string, cwd: string): SpawnSyncReturns<string> {
	if (command.includes("guard install --json")) {
		hookInstalled = true;
		return response(JSON.stringify({ mode: "warn", pre_commit: { installed: installCount++ === 0 } }));
	}
	if (command.includes("guard install --mode block")) return response('{"mode":"block"}');
	if (command.includes("guard status --json")) {
		return response(statusReply ?? '{"mode":"warn","hooks":{"pre_commit":true},"git_repo":true}');
	}
	if (command.includes("git context --json")) {
		if (cwd.endsWith("not-a-repo")) return response("", 1, "Not a git repository");
		return response(JSON.stringify({
			branch: "main", head: "abc123",
			trailers: { "Interlinked-Checkpoint": "42", "Interlinked-Agent": "Worker-Alpha" },
		}));
	}
	if (command.includes("guard check")) return response('{"clean":true,"files_checked":1}');
	if (command.includes("git log -1")) return response("Test with guard hook");
	if (command.includes("guard uninstall")) {
		hookInstalled = false;
		return response('{"pre_commit":{"removed":true},"mode":"off"}');
	}
	if (command.includes("attach --auto")) return response('{"default_workspace_key":"my-cool-project"}');
	return response();
}

function recordedReport(): unknown {
	const write = mocks.writeFileSync.mock.calls.find(([path]) => String(path).includes("/reports/"));
	const body = write?.[1];
	if (typeof body !== "string") throw new Error("scenario did not write its JSON report");
	return JSON.parse(body);
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	hookInstalled = false;
	installCount = 0;
	statusReply = undefined;
	process.argv = ["node", "run-scenario.ts", "claude-code-solo-offline"];
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation((code) => { throw new ExitError(Number(code ?? 0)); });
	mocks.existsSync.mockImplementation((path) => String(path).endsWith("/.git/hooks/pre-commit") && hookInstalled);
	mocks.spawnSync.mockImplementation((_binary, args, options) => runCommand(args[1] ?? "", options.cwd));
});

afterEach(() => {
	process.argv = originalArgv;
	vi.restoreAllMocks();
});

describe("agent-driven scenario reporting", () => {
	it("reports every offline scenario check passing for valid CLI responses", async () => {
		await import("./run-scenario.js");
		expect(recordedReport()).toMatchObject({
			scenario: "claude-code-solo-offline", summary: { passed: 12, failed: 0, skipped: 0 },
			results: expect.arrayContaining([
				{ test: "guard_status", status: "pass", duration_ms: expect.any(Number), notes: "" },
			]),
		});
		expect(mocks.rmSync).toHaveBeenCalledWith(expect.stringContaining("interlinked-agent-test-"), {
			recursive: true, force: true,
		});
	});

	it.each(["{not-json", '{"mode":"warn","hooks":{"pre_commit":"yes"},"git_repo":true}'])(
		"records invalid guard output as a failed check: %s", async (output) => {
			statusReply = output;
			await expect(import("./run-scenario.js")).rejects.toThrow("exit:1");
			expect(recordedReport()).toMatchObject({
				summary: { passed: 11, failed: 1, skipped: 0 },
				results: expect.arrayContaining([
					{ test: "guard_status", status: "fail", duration_ms: expect.any(Number), notes: "" },
				]),
			});
		},
	);
});
