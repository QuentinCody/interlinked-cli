// ===========================================
// interlinked harness stop / test — behavioral coverage
// ===========================================
// Companion test for the harness-stop-command.ts split (extracted from
// harness.ts, 2026-09-02). Mirrors the mocking approach used by
// harness.test.ts for the same two handlers, scoped to just this module's
// dependencies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	stopAllDaemons: vi.fn(),
	getSocketPath: vi.fn(),
	queryHarness: vi.fn(),
	resolveHarnessTestInput: vi.fn(),
	buildHarnessTestEvent: vi.fn(),
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
}));

vi.mock("./harness-daemon-control.js", () => ({
	stopAllDaemons: mocks.stopAllDaemons,
}));

vi.mock("./harness-process.js", () => ({
	getSocketPath: mocks.getSocketPath,
}));

vi.mock("./harness-status-helpers.js", () => ({
	queryHarness: mocks.queryHarness,
}));

vi.mock("./harness-test-event.js", () => ({
	resolveHarnessTestInput: mocks.resolveHarnessTestInput,
	buildHarnessTestEvent: mocks.buildHarnessTestEvent,
}));

vi.mock("../lib/formatter.js", () => ({
	c: {
		bold: (s: string) => s,
		dim: (s: string) => s,
		red: (s: string) => s,
		green: (s: string) => s,
		yellow: (s: string) => s,
		cyan: (s: string) => s,
		blue: (s: string) => s,
	},
}));

import { harnessStopCommand, harnessTestCommand } from "./harness-stop-command.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	mocks.getSocketPath.mockReturnValue("/tmp/repo/.interlinked/harness.sock");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("harnessStopCommand", () => {
	it("reports not-running when nothing was stopped and nothing survived", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
		await harnessStopCommand({});
		const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printed).toContain("not running");
	});

	it("reports success and lists stopped PIDs when the stop fully succeeds", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [123, 456], survived: [] });
		await harnessStopCommand({});
		const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printed).toContain("Harness stopped");
		expect(printed).toContain("123");
	});

	it("warns about survivors when a PID resists SIGKILL", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [123], survived: [456] });
		await harnessStopCommand({});
		const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printed).toContain("survived SIGKILL");
	});

	it("emits the JSON shape under --json", async () => {
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [123], survived: [] });
		await harnessStopCommand({ json: true });
		const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]);
		expect(printed).toEqual({ status: "stopped", pids: [123], survived: [] });
	});

	it("reports an error to outputError on a thrown failure", async () => {
		mocks.stopAllDaemons.mockRejectedValue(new Error("boom"));
		await harnessStopCommand({});
		const printedErr = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printedErr).toContain("boom");
	});
});

describe("harnessTestCommand", () => {
	beforeEach(() => {
		mocks.resolveHarnessTestInput.mockResolvedValue({ kind: "bash", command: "ls" });
		mocks.buildHarnessTestEvent.mockReturnValue({
			toolName: "Bash",
			displayLabel: "ls",
			event: {},
		});
	});

	it("reports harness_not_running when the socket file is absent", async () => {
		mocks.existsSync.mockReturnValue(false);
		await harnessTestCommand("ls", {});
		const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printed).toContain("Harness not running");
	});

	it("prints ALLOWED for a non-blocking decision and leaves exitCode untouched", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		process.exitCode = undefined;
		await harnessTestCommand("ls", {});
		const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printed).toContain("ALLOWED");
		expect(process.exitCode).toBeUndefined();
	});

	it("prints BLOCKED, the reason, and warnings, and sets exitCode 1 for a block", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({
			decision: "block",
			reason: "nope",
			warnings: ["careful"],
		});
		process.exitCode = undefined;
		await harnessTestCommand("rm -rf /", {});
		const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printed).toContain("BLOCKED");
		expect(printed).toContain("nope");
		expect(printed).toContain("careful");
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
	});

	it("emits the JSON shape under --json", async () => {
		mocks.existsSync.mockReturnValue(true);
		mocks.queryHarness.mockResolvedValue({ decision: "allow" });
		await harnessTestCommand("ls", { json: true });
		const printed = JSON.parse((logSpy.mock.calls[0] as [string])[0]);
		expect(printed).toEqual({ decision: "allow" });
	});

	it("reports an error to outputError on a thrown failure", async () => {
		mocks.resolveHarnessTestInput.mockRejectedValue(new Error("boom"));
		await harnessTestCommand("ls", {});
		const printedErr = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(printedErr).toContain("boom");
	});
});
