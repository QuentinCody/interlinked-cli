// Companion smoke test for the extracted restart-socket-state module — moved
// verbatim out of harness-lifecycle-helpers.ts. Full behavioral coverage of
// these functions lives in harness-lifecycle-helpers.test.ts and
// harness-lifecycle-helpers.mutation-kill(.-luna).test.ts, which import them
// via the parent's re-export; this file exercises the module directly at its
// new home, one path per export.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isHarnessRunning: vi.fn(),
	stopAllDaemons: vi.fn(),
	reapOrphanHarnessesVerified: vi.fn(),
	outputError: vi.fn(),
	getPidPath: vi.fn(() => "/repo/.interlinked/harness.pid"),
	getSocketPath: vi.fn(() => "/repo/.interlinked/harness.sock"),
}));

vi.mock("./harness-daemon-control.js", () => ({
	reapOrphanHarnessesVerified: mocks.reapOrphanHarnessesVerified,
	stopAllDaemons: mocks.stopAllDaemons,
}));
vi.mock("./harness-process.js", () => ({
	getPidPath: mocks.getPidPath,
	getSocketPath: mocks.getSocketPath,
	isHarnessRunning: mocks.isHarnessRunning,
}));
vi.mock("../lib/output.js", () => ({
	outputError: mocks.outputError,
}));
vi.mock("../lib/formatter.js", () => ({
	c: { dim: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s },
}));

import { cleanStaleRestartFiles, stopRunningHarnessForRestart } from "./harness-lifecycle-helpers-restart-socket-state.js";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.reapOrphanHarnessesVerified.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("stopRunningHarnessForRestart (extracted module)", () => {
	it("returns the empty-result shape when nothing was stopped", async () => {
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		mocks.stopAllDaemons.mockResolvedValue({ stopped: [], survived: [] });
		expect(await stopRunningHarnessForRestart("/repo", "json")).toEqual({ oldPid: undefined, survived: false });
	});
});

describe("cleanStaleRestartFiles (extracted module)", () => {
	it("no-ops when nothing is on disk and nothing is running", async () => {
		mocks.getPidPath.mockReturnValue("/nowhere/harness.pid");
		mocks.getSocketPath.mockReturnValue("/nowhere/harness.sock");
		mocks.isHarnessRunning.mockReturnValue({ running: false });
		await expect(cleanStaleRestartFiles("/repo")).resolves.toBeUndefined();
		expect(mocks.reapOrphanHarnessesVerified).toHaveBeenCalledWith("/repo", {}, {});
	});
});

// Both cleanup steps are best-effort: a probe or a read that THROWS must leave
// the file it could not judge alone, never delete it on a failed observation.
describe("cleanStaleRestartFiles — a failed observation never deletes the file", () => {
	const SOCK = "/repo/.interlinked/harness.sock";
	const PID = "/repo/.interlinked/harness.pid";

	beforeEach(() => {
		mocks.getSocketPath.mockReturnValue(SOCK);
		mocks.getPidPath.mockReturnValue(PID);
		mocks.isHarnessRunning.mockReturnValue({ running: false });
	});

	it("keeps the socket when the classify probe throws (probe_failed is not 'absent')", async () => {
		const unlinked: string[] = [];
		await cleanStaleRestartFiles("/repo", {
			fileExists: () => true,
			classifySocket: () => {
				throw new Error("EACCES: socket probe refused");
			},
			readText: () => "1234\n",
			unlinkFile: (path: string) => {
				unlinked.push(path);
			},
		});
		// Only the pid file goes. Were the throw classified as "absent", the
		// socket would have been unlinked in the same run.
		expect(unlinked).toEqual([PID]);
	});

	it("keeps the pid file when reading it throws (an unreadable snapshot is not an unchanged one)", async () => {
		const unlinked: string[] = [];
		const readText = vi.fn((_path: string): string => {
			throw new Error("EACCES: pid file unreadable");
		});
		await cleanStaleRestartFiles("/repo", {
			fileExists: (path: string) => path === PID,
			readText,
			unlinkFile: (path: string) => {
				unlinked.push(path);
			},
		});
		expect(unlinked).toEqual([]);
		// The null snapshot short-circuits before the confirming second read.
		expect(readText).toHaveBeenCalledTimes(1);
		expect(readText).toHaveBeenCalledWith(PID);
	});
});
