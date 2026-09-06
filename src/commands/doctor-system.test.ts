import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execSyncMock, cpusMock, freememMock, reapOrphanHarnessesVerifiedMock } = vi.hoisted(() => ({
	execSyncMock: vi.fn(),
	cpusMock: vi.fn(),
	freememMock: vi.fn(),
	reapOrphanHarnessesVerifiedMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execSync: execSyncMock,
}));

vi.mock("node:os", () => ({
	cpus: cpusMock,
	freemem: freememMock,
}));

vi.mock("./harness-daemon-control.js", () => ({
	reapOrphanHarnessesVerified: reapOrphanHarnessesVerifiedMock,
}));

import {
	bytesToGb,
	checkCliResolvable,
	checkCpuCores,
	checkFreeMemoryGb,
	checkOrphanHarnessCount,
	countVerifiedOrphans,
	formatGb,
	runSystemChecks,
} from "./doctor-system.js";

// Red-team F5 (docs/design/red-team-findings-2026-08-09.md): `interlinked`
// vanished from PATH mid-session while ~/.local/bin/interlinked still existed.
// Every operator flow that shells out to the CLI — including fleet unit
// verification — silently lost its verb, with no probe to catch it.
describe("checkCliResolvable", () => {
	it("P1: fails when the CLI does not resolve on PATH", () => {
		const r = checkCliResolvable({ resolvedPath: null, linkTargetExists: true });
		expect(r.status).toBe("fail");
		expect(r.message).toContain("PATH");
	});

	it("P2: fails when it resolves but its link target is missing", () => {
		const r = checkCliResolvable({ resolvedPath: "/u/.local/bin/interlinked", linkTargetExists: false });
		expect(r.status).toBe("fail");
	});

	it("N1: passes when it resolves and the target exists", () => {
		const r = checkCliResolvable({ resolvedPath: "/u/.local/bin/interlinked", linkTargetExists: true });
		expect(r.status).toBe("pass");
		expect(r.message).toContain("/u/.local/bin/interlinked");
	});

	it("N2: names the repair command when it fails, so the fix is one paste", () => {
		const r = checkCliResolvable({ resolvedPath: null, linkTargetExists: false });
		expect(r.message).toContain("npm run build");
	});
});

describe("checkCpuCores", () => {
	it("passes when at least 4 cores are available", () => {
		const r = checkCpuCores(8);
		expect(r.status).toBe("pass");
	});

	it("warns when between 2 and 3 cores", () => {
		const r = checkCpuCores(2);
		expect(r.status).toBe("warn");
	});

	it("fails when only 1 core", () => {
		const r = checkCpuCores(1);
		expect(r.status).toBe("fail");
	});

	it("includes the core count in the message", () => {
		expect(checkCpuCores(6).message).toContain("6");
	});

	it("passes at the exact 4-core boundary (exact object)", () => {
		expect(checkCpuCores(4)).toEqual({
			name: "CPU cores",
			status: "pass",
			message: "4 cores — full parallel pipeline available",
		});
	});

	it("warns at 3 cores, one below the pass boundary (exact object)", () => {
		expect(checkCpuCores(3)).toEqual({
			name: "CPU cores",
			status: "warn",
			message: "3 cores — parallel pipeline will be throttled (recommended ≥ 4)",
		});
	});

	it("fails at 1 core (exact object)", () => {
		expect(checkCpuCores(1)).toEqual({
			name: "CPU cores",
			status: "fail",
			message: "1 cores — parallel pipeline disabled; expect serial check execution",
		});
	});
});

describe("checkFreeMemoryGb", () => {
	it("passes when free memory is at least 4 GB", () => {
		const r = checkFreeMemoryGb(8 * 1024 ** 3);
		expect(r.status).toBe("pass");
	});

	it("warns when free memory is between 2 and 4 GB", () => {
		const r = checkFreeMemoryGb(3 * 1024 ** 3);
		expect(r.status).toBe("warn");
	});

	it("fails when free memory is below 2 GB", () => {
		const r = checkFreeMemoryGb(1 * 1024 ** 3);
		expect(r.status).toBe("fail");
	});

	it("formats memory as a GB-precision string", () => {
		const r = checkFreeMemoryGb(8.5 * 1024 ** 3);
		expect(r.message).toMatch(/8\.5/);
	});

	it("passes at the exact 4 GB boundary (exact object)", () => {
		expect(checkFreeMemoryGb(4 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "pass",
			message: "4.0 GB free — comfortable headroom",
		});
	});

	it("warns at 3 GB, one below the pass boundary (exact object)", () => {
		expect(checkFreeMemoryGb(3 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "warn",
			message:
				"3.0 GB free — consider closing apps before heavy verify runs (recommended ≥ 4 GB)",
		});
	});

	it("warns at the exact 2 GB boundary (exact object)", () => {
		expect(checkFreeMemoryGb(2 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "warn",
			message:
				"2.0 GB free — consider closing apps before heavy verify runs (recommended ≥ 4 GB)",
		});
	});

	it("fails at 1 GB, one below the warn boundary (exact object)", () => {
		expect(checkFreeMemoryGb(1 * 1024 ** 3)).toEqual({
			name: "Free memory",
			status: "fail",
			message: "1.0 GB free — parallel pipeline may swap or OOM (need ≥ 2 GB)",
		});
	});
});

describe("countVerifiedOrphans", () => {
	afterEach(() => {
		reapOrphanHarnessesVerifiedMock.mockReset();
	});

	it("returns null, never 0, when the verified orphan sweep throws", async () => {
		reapOrphanHarnessesVerifiedMock.mockRejectedValueOnce(new Error("sweep failed"));
		const result = await countVerifiedOrphans("/repo");
		expect(result).toBeNull();
	});
});

describe("checkOrphanHarnessCount", () => {
	it("passes when no orphans", () => {
		const r = checkOrphanHarnessCount(0);
		expect(r.status).toBe("pass");
	});

	it("warns on a small number of orphans", () => {
		const r = checkOrphanHarnessCount(3);
		expect(r.status).toBe("warn");
	});

	it("fails on a large number of orphans (≥10)", () => {
		const r = checkOrphanHarnessCount(15);
		expect(r.status).toBe("fail");
	});

	it("provides a fix hint when orphans are present", () => {
		const r = checkOrphanHarnessCount(5);
		expect(r.message.toLowerCase()).toContain("reap");
	});

	it("passes at 0 orphans (exact object)", () => {
		expect(checkOrphanHarnessCount(0)).toEqual({
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		});
	});

	it("uses singular 'daemon' at exactly 1 orphan (exact object)", () => {
		expect(checkOrphanHarnessCount(1)).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"1 orphan daemon found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("uses plural 'daemons' at 2 orphans (exact object)", () => {
		expect(checkOrphanHarnessCount(2)).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"2 orphan daemons found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("warns at 9 orphans, one below the fail boundary (exact object)", () => {
		expect(checkOrphanHarnessCount(9)).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"9 orphan daemons found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("fails at the exact 10-orphan boundary (exact object)", () => {
		expect(checkOrphanHarnessCount(10)).toEqual({
			name: "Orphan harness daemons",
			status: "fail",
			message:
				"10 orphan daemons found — significant memory pressure. Run 'interlinked harness reap --force' to clean up",
		});
	});
});

// The private `ps` scanner these cases used to drive is DELETED: it was a
// second, disagreeing definition of "orphan" that counted every daemon (a
// daemon is re-parented to pid 1 by definition) and made doctor offer a reap
// that would have killed the working one. The count is now supplied by the
// caller from the canonical protection-aware sweep, so what belongs here is
// the PASS-THROUGH and the unavailable rendering — not a reimplementation.
describe("runSystemChecks (orphan count supplied by the caller)", () => {
	beforeEach(() => {
		cpusMock.mockReset().mockReturnValue(new Array(4));
		freememMock.mockReset().mockReturnValue(4 * 1024 ** 3);
		execSyncMock.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("P: passes the supplied count straight through to the orphan row", () => {
		execSyncMock.mockReturnValue("");
		const results = runSystemChecks(3);
		expect(results[2]).toEqual({
			name: "Orphan harness daemons",
			status: "warn",
			message:
				"3 orphan daemons found — using extra memory. Run 'interlinked harness reap --force' to clean up",
		});
	});

	it("P: zero renders the healthy row", () => {
		execSyncMock.mockReturnValue("");
		expect(runSystemChecks(0)[2]).toEqual({
			name: "Orphan harness daemons",
			status: "pass",
			message: "0 orphans — auto-reaper working as expected",
		});
	});

	// The load-bearing one: an unanswerable probe must not render as clean.
	it("P: null renders 'could not determine', NOT a green zero", () => {
		execSyncMock.mockReturnValue("");
		const row = runSystemChecks(null)[2];
		expect(row?.status).toBe("warn");
		expect(row?.message).toContain("could not determine orphan count");
		expect(row?.message).not.toContain("0 orphans");
	});

	it("N: it no longer shells out to `ps` at all (the duplicate scanner is gone)", () => {
		execSyncMock.mockReturnValue("");
		runSystemChecks(0);
		for (const call of execSyncMock.mock.calls) {
			expect(String(call[0])).not.toContain("ps -ax");
		}
	});

	it("builds the full four-check array in order (cpu, memory, orphans, cli)", () => {
		cpusMock.mockReset().mockReturnValue(new Array(8));
		freememMock.mockReset().mockReturnValue(8 * 1024 ** 3);
		execSyncMock.mockReturnValue("");
		const results = runSystemChecks(0);
		expect(results).toEqual([
			{
				name: "CPU cores",
				status: "pass",
				message: "8 cores — full parallel pipeline available",
			},
			{
				name: "Free memory",
				status: "pass",
				message: "8.0 GB free — comfortable headroom",
			},
			{
				name: "Orphan harness daemons",
				status: "pass",
				message: "0 orphans — auto-reaper working as expected",
			},
			// The CLI probe (red-team F5) runs last. Under the mocked execSync
			// `command -v` yields "", so it reports the not-on-PATH failure —
			// asserted by shape, since its message embeds a repair hint.
			{
				name: "interlinked CLI on PATH",
				status: "fail",
				message: expect.stringContaining("does not resolve on PATH"),
			},
		]);
	});
});

describe("bytesToGb / formatGb", () => {
	it("bytesToGb converts byte counts to GB doubles", () => {
		expect(bytesToGb(1024 ** 3)).toBeCloseTo(1, 5);
		expect(bytesToGb(2 * 1024 ** 3)).toBeCloseTo(2, 5);
	});

	it("formatGb renders a single-decimal string with a `GB` suffix", () => {
		expect(formatGb(8.5 * 1024 ** 3)).toBe("8.5 GB");
	});
});
