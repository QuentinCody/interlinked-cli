import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOrphanedPidFiles, terminateCandidates, type OrphanCandidate } from "./harness-process-reap.js";

const CWD = "/repo";
const CANDIDATE: OrphanCandidate = {
	pid: 4242,
	ppid: 1,
	command: "node /repo/dist/harness/server.js --cwd /repo",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("terminateCandidates process identity fencing", () => {
	it.each([50, 3_001])("recognizes delayed exit after %i ms without escalating to SIGKILL", elapsed => {
		let alive = true;
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(Atomics, "wait").mockImplementation(() => {
			alive = false;
			now += elapsed;
			return "timed-out";
		});
		const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			if (signal === 0 && !alive) throw Object.assign(new Error("exited"), { code: "ESRCH" });
			return true;
		});
		expect(terminateCandidates([CANDIDATE], CWD, () => alive ? "original" : null)).toEqual([4242]);
		expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
		expect(kill).not.toHaveBeenCalledWith(4242, "SIGKILL");
	});

	it("retains pid and socket metadata when another process has reused the killed PID", () => {
		const cwd = mkdtempSync(join(tmpdir(), "reap-reused-pid-"));
		const dataDir = join(cwd, ".interlinked");
		mkdirSync(dataDir);
		writeFileSync(join(dataDir, "harness.pid"), "4242");
		writeFileSync(join(dataDir, "harness.sock"), "replacement socket");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		try {
			clearOrphanedPidFiles(cwd, [4242]);
			expect(readFileSync(join(dataDir, "harness.pid"), "utf8")).toBe("4242");
			expect(existsSync(join(dataDir, "harness.sock"))).toBe(true);
			expect(kill.mock.calls).toEqual([[4242, 0]]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("never SIGTERMs a replacement that appears after candidate authentication", () => {
		const identify = vi
			.fn<(cwd: string, pid: number) => string | null>()
			.mockReturnValueOnce("original")
			.mockReturnValue("replacement");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		expect(terminateCandidates([CANDIDATE], CWD, identify)).toEqual([]);
		expect(kill.mock.calls.filter((call) => call[1] !== 0)).toEqual([]);
	});

	it("never signals a pid that cannot be authenticated", () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(terminateCandidates([CANDIDATE], CWD, () => null)).toEqual([]);
		expect(kill).not.toHaveBeenCalled();
	});

	it("does not SIGKILL when the original exits and the pid is reused after SIGTERM", () => {
		const identify = vi
			.fn<(cwd: string, pid: number) => string | null>()
			.mockReturnValueOnce("original")
			.mockReturnValueOnce("original")
			.mockReturnValue("replacement");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		expect(terminateCandidates([CANDIDATE], CWD, identify)).toEqual([4242]);
		expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
		expect(kill).not.toHaveBeenCalledWith(4242, "SIGKILL");
	});

	it("marks a term-survivor killed instead of escalating when its identity flips right before the SIGKILL check", () => {
		// The pid keeps matching for the whole SIGTERM grace window (a real
		// survivor, not an immediate exit), so Date.now is nudged straight past
		// the deadline after the window opens instead of sleeping through it.
		vi.spyOn(Date, "now")
			.mockImplementationOnce(() => 1_000)
			.mockImplementation(() => 1_000_000);
		const identify = vi
			.fn<(cwd: string, pid: number) => string | null>()
			.mockReturnValueOnce("original")
			.mockReturnValueOnce("original")
			.mockReturnValueOnce("original")
			.mockReturnValueOnce("original")
			.mockReturnValue("replacement");
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);

		expect(terminateCandidates([CANDIDATE], CWD, identify)).toEqual([4242]);
		expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
		expect(kill).not.toHaveBeenCalledWith(4242, "SIGKILL");
	});
});
