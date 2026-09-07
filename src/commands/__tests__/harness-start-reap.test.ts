import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessStartCommand } from "../harness.js";

const probeSpy = vi.fn<() => Promise<boolean>>();
const reapSpy = vi.fn();
const runningSpy = vi.fn<() => { running: boolean; pid?: number }>();

vi.mock("../../harness/startup-lock.js", () => ({
	acquireStartupLock: () => ({ acquired: true, path: "/tmp/test.lock", release: vi.fn() }),
}));

vi.mock("../harness-liveness.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../harness-liveness.js")>();
	return { ...actual, probeHarnessSocket: () => probeSpy() };
});

vi.mock("../harness-daemon-control.js", () => ({
	reapOrphanHarnessesVerified: (...args: unknown[]) => reapSpy(...args),
	stopAllDaemons: vi.fn(),
}));

vi.mock("../harness-process.js", () => ({
	isHarnessRunning: () => runningSpy(),
	reapOrphanHarnesses: () => reapSpy(),
	getHarnessServerPath: () => "/nonexistent/server.js",
	getSocketPath: () => "/tmp/x.sock",
	getFramedSocketPath: () => "/tmp/x-framed.sock",
	ensureDistFresh: vi.fn(),
}));

let logged: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let previousExitCode: number | string | undefined;

beforeEach(() => {
	logged = [];
	previousExitCode = process.exitCode;
	process.exitCode = 0;
	logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logged.push(a.map(String).join(" "));
	});
	reapSpy.mockReset();
	runningSpy.mockReset();
	probeSpy.mockReset();
});

afterEach(() => {
	logSpy.mockRestore();
	process.exitCode = previousExitCode;
});

describe("harness start — socket-first protection and verified reaping", () => {
	it("protects a healthy socket with no pid file before any reap", async () => {
		probeSpy.mockResolvedValue(true);
		runningSpy.mockReturnValue({ running: false });

		await harnessStartCommand({ json: true });

		expect(reapSpy).not.toHaveBeenCalled();
		expect(logged.join("\n")).toContain('"status": "already_running"');
		expect(logged.join("\n")).toContain('"reaped": []');
	});

	it("performs the kill-all verified reap when no socket answers", async () => {
		probeSpy.mockResolvedValue(false);
		reapSpy.mockResolvedValue({
			candidates: [{ pid: 9829 }],
			killed: [9829],
			dryRun: false,
		});

		await harnessStartCommand({ json: true });

		expect(reapSpy).toHaveBeenCalledWith(expect.any(String), { killAll: true });
		// Keep this result non-empty: an empty fixture would not pin that a real
		// orphan remains eligible after the socket-first protection branch.
		await expect(reapSpy.mock.results[0]?.value).resolves.toMatchObject({ killed: [9829] });
	});
});
