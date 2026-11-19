import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
	calculateAttribution,
	type PreRunSnapshot,
	readAttributionTrailer,
	snapshotPreRun,
} from "../attribution.js";

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
	vi.restoreAllMocks();
	// Re-mock after restore
	mockExecFileSync.mockImplementation(() => "");
});

function setupGitMock(responses: string[]) {
	let callIndex = 0;
	mockExecFileSync.mockImplementation(() => {
		const response = responses[callIndex] || "";
		callIndex++;
		return response;
	});
}

describe("snapshotPreRun", () => {
	it("captures files with changes", () => {
		setupGitMock([
			"10\t5\tsrc/index.ts\u00003\t1\tsrc/lib/config.ts", // diff --numstat
			"", // ls-files --others
		]);

		const snap = snapshotPreRun("/test/cwd");
		expect(snap.files["src/index.ts"]).toBe(15);
		expect(snap.files["src/lib/config.ts"]).toBe(4);
		expect(snap.timestamp).toBeDefined();
	});

	it("handles no changes gracefully", () => {
		setupGitMock(["", ""]);

		const snap = snapshotPreRun("/test/cwd");
		expect(Object.keys(snap.files)).toHaveLength(0);
	});

	it("handles git errors gracefully", () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error("not a git repo");
		});

		const snap = snapshotPreRun("/test/cwd");
		expect(Object.keys(snap.files)).toHaveLength(0);
	});
});

describe("calculateAttribution", () => {
	it("attributes new lines to agent", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: { "src/index.ts": 5 },
		};

		setupGitMock([
			"15\t0\tsrc/index.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(10);
		expect(result.human_lines).toBe(5);
		expect(result.total_lines).toBe(15);
		expect(result.agent_percentage).toBe(67);
	});

	it("attributes all lines to agent for new files", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: {},
		};

		setupGitMock([
			"20\t0\tnew-file.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(20);
		expect(result.human_lines).toBe(0);
		expect(result.agent_percentage).toBe(100);
	});

	it("handles no changes", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: {},
		};

		setupGitMock(["", ""]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(0);
		expect(result.human_lines).toBe(0);
		expect(result.agent_percentage).toBe(0);
	});

	it("handles all human (pre-existing) lines", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: { "src/index.ts": 10 },
		};

		setupGitMock([
			"10\t0\tsrc/index.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.agent_lines).toBe(0);
		expect(result.human_lines).toBe(10);
		expect(result.agent_percentage).toBe(0);
	});

	it("per_file attribution", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: { "a.ts": 5, "b.ts": 3 },
		};

		setupGitMock([
			"10\t0\ta.ts\u00003\t0\tb.ts\u00008\t0\tc.ts", // diff --numstat
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.per_file["a.ts"]).toEqual({ agent: 5, human: 5 });
		expect(result.per_file["b.ts"]).toEqual({ agent: 0, human: 3 });
		expect(result.per_file["c.ts"]).toEqual({ agent: 8, human: 0 });
	});
});

describe("snapshotPreRun — untracked files", () => {
	it("includes untracked files using wc line count", () => {
		mockExecFileSync.mockImplementationOnce(() => "3\t0\ttracked.ts") // diff --numstat
			.mockImplementationOnce(() => "untracked.ts") // ls-files --others
			.mockImplementationOnce(() => "patch\n".repeat(7)); // patch newline count

		const snap = snapshotPreRun("/test/cwd");
		expect(snap.files["untracked.ts"]).toBe(7);
	});

	it("falls back to 1 line when wc invocation throws", () => {
		mockExecFileSync
			.mockImplementationOnce(() => "3\t0\ttracked.ts") // diff --numstat
			.mockImplementationOnce(() => "untracked.ts") // ls-files --others
			.mockImplementationOnce(() => {
				throw new Error("wc failed");
			});

		const snap = snapshotPreRun("/test/cwd");
		expect(snap.files["untracked.ts"]).toBe(1);
	});

	it("falls back to 1 line when wc output is not a number", () => {
		mockExecFileSync
			.mockImplementationOnce(() => "3\t0\ttracked.ts") // diff --numstat
			.mockImplementationOnce(() => "untracked.ts") // ls-files --others
			.mockImplementationOnce(() => "not-a-number");

		const snap = snapshotPreRun("/test/cwd");
		expect(snap.files["untracked.ts"]).toBe(1);
	});

	it("falls back to 0 added/deleted lines for non-numeric numstat fields and skips empty filenames", () => {
		mockExecFileSync
			.mockImplementationOnce(() => "abc\txyz\t\u00005\t2\tvalid.ts") // diff --numstat
			.mockImplementationOnce(() => ""); // ls-files --others

		const snap = snapshotPreRun("/test/cwd");
		expect(snap.files).toEqual({ "valid.ts": 7 });
	});

	it("skips malformed numstat lines with fewer than 3 fields", () => {
		mockExecFileSync
			.mockImplementationOnce(() => "10\t5") // malformed: missing filename
			.mockImplementationOnce(() => ""); // ls-files --others

		const snap = snapshotPreRun("/test/cwd");
		expect(Object.keys(snap.files)).toHaveLength(0);
	});

	it("uses process.cwd() when no cwd argument is given", () => {
		mockExecFileSync.mockReset();
		mockExecFileSync.mockImplementation(() => "");
		const snap = snapshotPreRun();
		expect(snap.files).toEqual({});
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"git",
			expect.any(Array),
			expect.objectContaining({ cwd: process.cwd() }),
		);
	});
});

describe("calculateAttribution — reverted files and defaults", () => {
	it("attributes reverted (pre-run only) files entirely to human", () => {
		const preSnapshot: PreRunSnapshot = {
			timestamp: "2025-01-01T00:00:00Z",
			files: { "reverted.ts": 12 },
		};

		setupGitMock([
			"", // diff --numstat: no current changes at all
			"", // ls-files --others
		]);

		const result = calculateAttribution(preSnapshot, "/test/cwd");
		expect(result.per_file["reverted.ts"]).toEqual({ agent: 0, human: 12 });
		expect(result.human_lines).toBe(12);
		expect(result.agent_lines).toBe(0);
	});

	it("uses process.cwd() when no cwd argument is given", () => {
		mockExecFileSync.mockReset();
		mockExecFileSync.mockImplementation(() => "");
		const preSnapshot: PreRunSnapshot = { timestamp: "2025-01-01T00:00:00Z", files: {} };
		const result = calculateAttribution(preSnapshot);
		expect(result.total_lines).toBe(0);
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"git",
			expect.any(Array),
			expect.objectContaining({ cwd: process.cwd() }),
		);
	});
});

describe("readAttributionTrailer", () => {
	it("parses attribution trailer from commit message", () => {
		setupGitMock([
			"Fix bug in login flow\n\nInterlinked-Attribution: 73% agent (146/200 lines)",
		]);

		const result = readAttributionTrailer("HEAD", "/test/cwd");
		expect(result).not.toBeNull();
		expect(result!.agent_percentage).toBe(73);
		expect(result!.agent_lines).toBe(146);
		expect(result!.total_lines).toBe(200);
		expect(result!.human_lines).toBe(54);
	});

	it("returns null when no trailer", () => {
		setupGitMock(["Fix bug in login flow"]);

		const result = readAttributionTrailer("HEAD", "/test/cwd");
		expect(result).toBeNull();
	});

	it("defaults ref to HEAD and cwd to process.cwd() when omitted", () => {
		setupGitMock(["Fix bug\n\nInterlinked-Attribution: 50% agent (5/10 lines)"]);

		const result = readAttributionTrailer();
		expect(result).toEqual({
			agent_lines: 5,
			human_lines: 5,
			total_lines: 10,
			agent_percentage: 50,
			per_file: {},
		});
		expect(mockExecFileSync).toHaveBeenCalledWith(
			"git",
			["log", "-1", "--format=%B", "--end-of-options", "HEAD", "--"],
			expect.objectContaining({ cwd: process.cwd() }),
		);
	});

	it("returns null on git error", () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error("bad ref");
		});

		const result = readAttributionTrailer("badref", "/test/cwd");
		expect(result).toBeNull();
	});
});
