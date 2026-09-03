// ===========================================
// Multi-workspace integration tests using the shared ps-fixture helper
// ===========================================
//
// Pins the cross-workspace contract: with daemons from two different
// workspaces alive at the same time, `reapOrphanHarnesses("/repoA")` may
// only consider candidates whose `--cwd` equals `/repoA`. Daemons in
// `/repoB` are someone else's hooks and must remain untouched.
//
// The single-workspace tests in `harness-reap.test.ts` cover the
// per-rule semantics (ancestor protection, active-daemon protection,
// kill-all). This file is specifically the multi-workspace lens.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execSync: vi.fn(),
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execSync: mocks.execSync }));
vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	readFileSync: mocks.readFileSync,
}));

import { reapOrphanHarnesses } from "../harness-process.js";
import { buildPsFixture, type FixtureDaemon } from "./multi-workspace-fixture.js";

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockReset();
	vi.spyOn(process, "cwd").mockReturnValue("/repoA");
	mocks.existsSync.mockReturnValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function setupPs(daemons: FixtureDaemon[]): void {
	mocks.execSync.mockImplementation((cmd: string) => buildPsFixture(cmd, daemons));
}

describe("reapOrphanHarnesses — multi-workspace contract", () => {
	it("from /repoA: only /repoA orphans are candidates; /repoB daemons are untouched", () => {
		const daemons: FixtureDaemon[] = [
			{ pid: 1001, ppid: 1, cwd: "/repoA" }, // orphan in our workspace
			{ pid: 1002, ppid: 1, cwd: "/repoB" }, // sibling repo orphan
			{ pid: 1003, ppid: 1, cwd: "/repoB", role: "active" }, // sibling repo active
		];
		setupPs(daemons);
		const result = reapOrphanHarnesses("/repoA", { dryRun: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).toContain(1001);
		expect(pids).not.toContain(1002);
		expect(pids).not.toContain(1003);
	});

	it("`killAll` from /repoA does NOT include /repoB daemons", () => {
		// Even with --all (the equivalent of pkill -f), the scope must
		// remain this workspace. --all widens past the active-pid
		// protection but never crosses into another workspace.
		const daemons: FixtureDaemon[] = [
			{ pid: 1001, ppid: 1, cwd: "/repoA" },
			{ pid: 1002, ppid: 1, cwd: "/repoA", role: "active" },
			{ pid: 1003, ppid: 1, cwd: "/repoB" },
		];
		setupPs(daemons);
		const result = reapOrphanHarnesses("/repoA", { dryRun: true, killAll: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).toContain(1001);
		// killAll widens scope to active-in-this-workspace
		expect(pids).toContain(1002);
		// but not to other workspaces
		expect(pids).not.toContain(1003);
	});

	it("legacy daemons without `--cwd` are skipped (cannot be attributed)", () => {
		// A daemon that predates the cwd-tagging change can't be safely
		// reaped from any workspace — we don't know which one it serves.
		const daemons: FixtureDaemon[] = [
			{ pid: 1001, ppid: 1, cwd: "/repoA" },
			{
				pid: 1002,
				ppid: 1,
				cwd: "/legacy",
				cmd: "node /home/u/interlinked-cli/dist/harness/server.js --verbose",
			},
		];
		setupPs(daemons);
		const result = reapOrphanHarnesses("/repoA", { dryRun: true });
		const pids = result.candidates.map((c) => c.pid);
		expect(pids).toContain(1001);
		expect(pids).not.toContain(1002);
	});

	it("zero workspace overlap yields zero candidates", () => {
		// All daemons belong to other workspaces. /repoA's reaper sees nothing.
		const daemons: FixtureDaemon[] = [
			{ pid: 1001, ppid: 1, cwd: "/repoB" },
			{ pid: 1002, ppid: 1, cwd: "/repoC" },
		];
		setupPs(daemons);
		const result = reapOrphanHarnesses("/repoA", { dryRun: true });
		expect(result.candidates).toEqual([]);
	});
});
