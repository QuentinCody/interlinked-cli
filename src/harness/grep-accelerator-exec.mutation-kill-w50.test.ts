import { nonNull } from "../lib/non-null.js";
// Mutation-kill tests for wave pass1_w50 survivors in grep-accelerator-exec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fsMod from "node:fs";
import * as cpMod from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn(), execSync: vi.fn(actual.execSync) };
});

import {
	_resetRgPathCache,
	compressGrepOutput,
	findRipgrep,
	matchInProcess,
	runRipgrepOnCandidates,
	safeRegExp,
} from "./grep-accelerator-exec.js";

const mockedExistsSync = vi.mocked(fsMod.existsSync);
const mockedSpawnSync = vi.mocked(cpMod.spawnSync);
const mockedExecSync = vi.mocked(cpMod.execSync);

describe("safeRegExp — MAX_PATTERN_LENGTH boundary (fd331d464b1d3b99)", () => {
	it("compiles a pattern whose length is exactly MAX_PATTERN_LENGTH (1000)", () => {
		const source = "a".repeat(1000);
		const re = safeRegExp(source, "g");
		expect(re).not.toBeNull();
	});

	it("rejects a pattern longer than MAX_PATTERN_LENGTH", () => {
		const source = "a".repeat(1001);
		expect(safeRegExp(source, "g")).toBeNull();
	});
});

describe("matchInProcess", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grep-accel-exec-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("uses utf-8 encoding when reading candidate files (1818fe1108819988)", () => {
		fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello world\n");
		const result = matchInProcess({
			pattern: "hello",
			candidates: ["a.txt"],
			cwd: tmpDir,
			caseInsensitive: false,
			maxOutputLines: 200,
		});
		expect(result).not.toBeNull();
		expect(result?.output).toBe("a.txt:1:hello world");
		expect(result?.matchCount).toBe(1);
	});

	it("truncated is false when lines.length exactly equals maxOutputLines (8caffb5ee320bfa1)", () => {
		fs.writeFileSync(path.join(tmpDir, "a.txt"), "foo\nfoo\n");
		const result = matchInProcess({
			pattern: "foo",
			candidates: ["a.txt"],
			cwd: tmpDir,
			caseInsensitive: false,
			maxOutputLines: 2,
		});
		expect(result).not.toBeNull();
		expect(result?.matchCount).toBe(2);
		expect(result?.truncated).toBe(false);
	});

	it("truncated is true when lines.length exceeds maxOutputLines (fe9b0524f915ae8d)", () => {
		fs.writeFileSync(path.join(tmpDir, "a.txt"), "foo\nfoo\nfoo\n");
		const result = matchInProcess({
			pattern: "foo",
			candidates: ["a.txt"],
			cwd: tmpDir,
			caseInsensitive: false,
			maxOutputLines: 1,
		});
		expect(result).not.toBeNull();
		expect(result?.truncated).toBe(true);
	});

	it("joins output lines with newline separator (2d99a437ba0ace7c)", () => {
		fs.writeFileSync(path.join(tmpDir, "a.txt"), "foo\nfoo\n");
		const result = matchInProcess({
			pattern: "foo",
			candidates: ["a.txt"],
			cwd: tmpDir,
			caseInsensitive: false,
			maxOutputLines: 200,
		});
		expect(result?.output).toBe("a.txt:1:foo\na.txt:2:foo");
	});

	it("slices output to maxOutputLines rather than returning all matches (7d73cd262078d436)", () => {
		fs.writeFileSync(path.join(tmpDir, "a.txt"), "foo\nfoo\nfoo\n");
		const result = matchInProcess({
			pattern: "foo",
			candidates: ["a.txt"],
			cwd: tmpDir,
			caseInsensitive: false,
			maxOutputLines: 1,
		});
		expect(result?.output).toBe("a.txt:1:foo");
		expect(result?.output.split("\n").length).toBe(1);
		// matchCount stays the FULL count even though output is sliced.
		expect(result?.matchCount).toBe(3);
	});

	it("escapes regex-special characters in the pattern so they match literally (7692ec6d87eb14db)", () => {
		fs.writeFileSync(path.join(tmpDir, "a.txt"), "a.b\naxb\n");
		const result = matchInProcess({
			pattern: "a.b",
			candidates: ["a.txt"],
			cwd: tmpDir,
			caseInsensitive: false,
			maxOutputLines: 200,
		});
		expect(result).not.toBeNull();
		// Only the literal "a.b" line matches — "axb" must NOT match if the dot
		// is properly escaped rather than stripped/treated as a wildcard.
		expect(result?.matchCount).toBe(1);
		expect(result?.output).toBe("a.txt:1:a.b");
	});
});

describe("compressGrepOutput (sanity — unaffected by targeted mutants but exercises module)", () => {
	it("groups content-mode lines by file", () => {
		const input = "a.ts:1:foo\na.ts:2:bar";
		expect(compressGrepOutput(input)).toBe("a.ts\n1:foo\n2:bar");
	});
});

describe("findRipgrep — binary resolution", () => {
	beforeEach(() => {
		_resetRgPathCache();
		mockedExistsSync.mockReset();
		mockedExecSync.mockReset();
	});

	afterEach(() => {
		_resetRgPathCache();
	});

	it("resolves via the exact /usr/bin/rg literal (20a70641e1a2b468)", () => {
		mockedExistsSync.mockImplementation((p: fs.PathLike) => p === "/usr/bin/rg");
		const result = findRipgrep();
		expect(result).toBe("/usr/bin/rg");
	});

	it("resolves via the exact ~/.cargo/bin/rg literal when earlier paths are absent (363b91e6bfa717e0)", () => {
		const cargoPath = `${process.env.HOME}/.cargo/bin/rg`;
		mockedExistsSync.mockImplementation((p: fs.PathLike) => p === cargoPath);
		const result = findRipgrep();
		expect(result).toBe(cargoPath);
	});

	it("falls back to the exact `which rg` shell command with utf-8/2000ms/sh options (5872b05761613fe4, dd71f26cb6b815d1, 5eefac84a33eddaa, 7966251d6be5380c)", () => {
		mockedExistsSync.mockReturnValue(false);
		mockedExecSync.mockImplementation(() => "/fallback/bin/rg\n");
		const result = findRipgrep();
		expect(result).toBe("/fallback/bin/rg");
		expect(mockedExecSync).toHaveBeenCalledTimes(1);
		expect(mockedExecSync).toHaveBeenCalledWith(
			"which rg 2>/dev/null || command -v rg 2>/dev/null",
			{ encoding: "utf-8", timeout: 2000, shell: "/bin/sh" },
		);
	});

	it("returns null when nothing is found on disk or PATH", () => {
		mockedExistsSync.mockReturnValue(false);
		mockedExecSync.mockImplementation(() => {
			throw new Error("not found");
		});
		expect(findRipgrep()).toBeNull();
	});
});

describe("runRipgrepOnCandidates — exact argv/options construction", () => {
	beforeEach(() => {
		_resetRgPathCache();
		mockedExistsSync.mockReset();
		mockedExistsSync.mockImplementation((p: fs.PathLike) => p === "/usr/bin/rg");
		mockedSpawnSync.mockReset();
	});

	afterEach(() => {
		_resetRgPathCache();
	});

	it("passes the exact args array and options object to spawnSync", () => {
		mockedSpawnSync.mockReturnValue({
			status: 0,
			stdout: "src/a.ts:1:hello\n",
			pid: 42,
			output: [null, "src/a.ts:1:hello\n", ""],
			stderr: "",
			signal: null,
		});

		const cfg = {
			maxCandidates: 500,
			maxCandidateRatio: 0.3,
			maxOutputLines: 200,
			rgTimeout: 10_000,
			inProcessThreshold: 50,
			indexFresh: false,
			minFilesForAccel: 25_000,
		};

		const result = runRipgrepOnCandidates(
			"hello",
			["src/a.ts", "src/b.ts"],
			"/repo",
			false,
			false,
			cfg,
		);

		expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
		const call = nonNull(mockedSpawnSync.mock.calls[0]);
		const [rgPath, args, options] = call;
		expect(rgPath).toBe("/usr/bin/rg");
		expect(args).toEqual([
			"--no-heading",
			"--color=never",
			"--with-filename",
			"--line-number",
			"--fixed-strings",
			"--",
			"hello",
			"src/a.ts",
			"src/b.ts",
		]);
		expect(options).toEqual({
			cwd: "/repo",
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
		expect(result).not.toBeNull();
		expect(result?.output).toBe("src/a.ts:1:hello");
	});

	it("passes maxBuffer computed as 1024*1024 (not 1024/1024) (0dc20de7cf9e4e0b)", () => {
		mockedSpawnSync.mockReturnValue({
			status: 1, stdout: "",
			pid: 42, output: [null, "", ""], stderr: "", signal: null,
		});
		const cfg = {
			maxCandidates: 500,
			maxCandidateRatio: 0.3,
			maxOutputLines: 200,
			rgTimeout: 10_000,
			inProcessThreshold: 50,
			indexFresh: false,
			minFilesForAccel: 25_000,
		};
		runRipgrepOnCandidates("x", ["f.ts"], "/repo", false, false, cfg);
		const call = nonNull(mockedSpawnSync.mock.calls[0]);
		const options = nonNull(call[2]);
		expect(options.maxBuffer).toBe(1024 * 1024);
		expect(options.maxBuffer).not.toBe(1024 / 1024);
	});
});
