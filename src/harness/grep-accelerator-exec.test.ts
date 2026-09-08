import { nonNull } from "../lib/non-null.js";
// Coverage for grep-accelerator-exec.ts: the ripgrep executor
// (runRipgrepOnCandidates + its internal processRgOutput), the rg binary
// resolver (findRipgrep), and the matchInProcess ReDoS-safe-regex-null
// branch. node:child_process and node:fs are mocked — no real subprocess,
// no real disk reads for the execution-path tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
	execSync: vi.fn<(cmd: string, opts?: unknown) => string>(),
	spawnSync: vi.fn<
		(
			cmd: string,
			args: string[],
			opts?: unknown,
		) => { status: number | null; stdout?: string; error?: Error }
	>(),
}));
vi.mock("node:child_process", () => childProcessMock);

const fsMock = vi.hoisted(() => ({
	existsSync: vi.fn<(p: string) => boolean>(),
	readFileSync: vi.fn<(p: string, enc?: string) => string>(),
}));
vi.mock("node:fs", () => fsMock);

// Imported AFTER the mocks above are registered (vi.mock is hoisted).
import {
	_resetRgPathCache,
	findRipgrep,
	matchInProcess,
	runRipgrepOnCandidates,
} from "./grep-accelerator-exec.js";
import type { GrepAcceleratorConfig } from "./grep-accelerator.js";

const CFG: Required<GrepAcceleratorConfig> = {
	rgTimeout: 5000,
	maxOutputLines: 3,
	maxCandidates: 1000,
	maxCandidateRatio: 0.3,
	inProcessThreshold: 50,
	indexFresh: true,
	minFilesForAccel: 0,
};

beforeEach(() => {
	_resetRgPathCache();
	fsMock.existsSync.mockReset();
	fsMock.readFileSync.mockReset();
	childProcessMock.execSync.mockReset();
	childProcessMock.spawnSync.mockReset();
});

afterEach(() => {
	_resetRgPathCache();
});

describe("findRipgrep", () => {
	it("returns a common install path when it exists (positive)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		expect(findRipgrep()).toBe("/opt/homebrew/bin/rg");
		expect(childProcessMock.execSync).not.toHaveBeenCalled();
	});

	it("falls back to PATH lookup when no common path exists (positive)", () => {
		fsMock.existsSync.mockReturnValue(false);
		childProcessMock.execSync.mockReturnValue("/usr/bin/rg\n");
		expect(findRipgrep()).toBe("/usr/bin/rg");
	});

	it("rejects a multi-line PATH lookup result (negative)", () => {
		fsMock.existsSync.mockReturnValue(false);
		childProcessMock.execSync.mockReturnValue("/usr/bin/rg\n/opt/bin/rg\n");
		expect(findRipgrep()).toBeNull();
	});

	it("rejects a shell-function PATH lookup result (negative)", () => {
		fsMock.existsSync.mockReturnValue(false);
		childProcessMock.execSync.mockReturnValue("rg is a function\nfunction rg() { ... }");
		expect(findRipgrep()).toBeNull();
	});

	it("returns null when existsSync throws for every common path (negative)", () => {
		fsMock.existsSync.mockImplementation(() => {
			throw new Error("EPERM");
		});
		childProcessMock.execSync.mockReturnValue("");
		expect(findRipgrep()).toBeNull();
	});

	it("returns null when execSync throws (negative)", () => {
		fsMock.existsSync.mockReturnValue(false);
		childProcessMock.execSync.mockImplementation(() => {
			throw new Error("no such command");
		});
		expect(findRipgrep()).toBeNull();
	});

	it("caches the resolved path across calls (positive)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/usr/local/bin/rg");
		expect(findRipgrep()).toBe("/usr/local/bin/rg");
		fsMock.existsSync.mockReturnValue(false);
		// Second call must return the cached value without re-probing fs.
		expect(findRipgrep()).toBe("/usr/local/bin/rg");
	});
});

describe("runRipgrepOnCandidates", () => {
	it("returns null when rg is not found on the system (negative)", () => {
		fsMock.existsSync.mockReturnValue(false);
		childProcessMock.execSync.mockImplementation(() => {
			throw new Error("not found");
		});
		const result = runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, false, CFG);
		expect(result).toBeNull();
	});

	it("passes --fixed-strings when isRegex is false (positive)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({ status: 1 });
		runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", false, false, CFG);
		const args = nonNull(childProcessMock.spawnSync.mock.calls[0]?.[1]);
		expect(args).toContain("--fixed-strings");
	});

	it("omits --fixed-strings when isRegex is true (negative)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({ status: 1 });
		runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, false, CFG);
		const args = nonNull(childProcessMock.spawnSync.mock.calls[0]?.[1]);
		expect(args).not.toContain("--fixed-strings");
	});

	it("passes --ignore-case when caseInsensitive is true (positive)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({ status: 1 });
		runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, true, CFG);
		const args = nonNull(childProcessMock.spawnSync.mock.calls[0]?.[1]);
		expect(args).toContain("--ignore-case");
	});

	it("omits --ignore-case when caseInsensitive is false (negative)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({ status: 1 });
		runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, false, CFG);
		const args = nonNull(childProcessMock.spawnSync.mock.calls[0]?.[1]);
		expect(args).not.toContain("--ignore-case");
	});

	it("returns an empty no-match result on rg exit code 1 (positive)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({ status: 1 });
		const result = runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, false, CFG);
		expect(result).toEqual({ output: "", matchCount: 0, truncated: false });
	});

	it("returns null on a non-zero, non-1 exit status (negative)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({ status: 2 });
		const result = runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, false, CFG);
		expect(result).toBeNull();
	});

	it("returns null when spawnSync reports an error even with status 0 (negative)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({ status: 0, error: new Error("ENOENT") });
		const result = runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, false, CFG);
		expect(result).toBeNull();
	});

	it("processes successful output under the line cap without truncation (positive)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		childProcessMock.spawnSync.mockReturnValue({
			status: 0,
			stdout: "a.ts:1:hello\nb.ts:2:world\n",
		});
		const result = runRipgrepOnCandidates("foo", ["a.ts", "b.ts"], "/tmp", true, false, CFG);
		expect(result).toEqual({
			output: "a.ts:1:hello\nb.ts:2:world",
			matchCount: 2,
			truncated: false,
		});
	});

	it("truncates output over the configured maxOutputLines (positive branch of truncation)", () => {
		fsMock.existsSync.mockImplementation((p: string) => p === "/opt/homebrew/bin/rg");
		// CFG.maxOutputLines is 3; stdout splits into 5 lines (4 content + trailing empty).
		childProcessMock.spawnSync.mockReturnValue({
			status: 0,
			stdout: "a.ts:1:one\na.ts:2:two\na.ts:3:three\na.ts:4:four\n",
		});
		const result = runRipgrepOnCandidates("foo", ["a.ts"], "/tmp", true, false, CFG);
		expect(result).toEqual({
			output: "a.ts:1:one\na.ts:2:two\na.ts:3:three",
			matchCount: 4,
			truncated: true,
		});
	});
});

describe("matchInProcess", () => {
	it("returns null when the pattern fails safeRegExp (negative)", () => {
		const overLength = "a".repeat(1001);
		const result = matchInProcess({
			pattern: overLength,
			candidates: ["a.ts"],
			cwd: "/tmp",
			caseInsensitive: false,
			maxOutputLines: 10,
		});
		expect(result).toBeNull();
		expect(fsMock.readFileSync).not.toHaveBeenCalled();
	});

	it("returns matches when the pattern compiles (positive)", () => {
		fsMock.readFileSync.mockReturnValue("hello world\nfoo bar\n");
		const result = matchInProcess({
			pattern: "foo",
			candidates: ["a.ts"],
			cwd: "/tmp",
			caseInsensitive: false,
			maxOutputLines: 10,
		});
		expect(result).toEqual({
			output: "a.ts:2:foo bar",
			matchCount: 1,
			truncated: false,
		});
	});
});
