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
