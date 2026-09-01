import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn();
const runProcessAsyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: unknown[]) => runProcessAsyncMock(...args),
}));

import { runSwiftBuild, runSwiftLint, runSwiftLintAsync } from "./swift.js";

function scope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: "/repo",
		mode: "project",
		...overrides,
	};
}

function input(overrides: Partial<CheckScope> = {}): ToolRunnerInput {
	return { scope: scope(overrides), timeoutMs: 5000 };
}

describe("swift.ts mutation-kill w43", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
		runProcessAsyncMock.mockReset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// --- parseSwiftLintJson: !Array.isArray(findings) (42b193e351bd1833) ---
	describe("runSwiftLint — non-array JSON payload", () => {
		it("P: a JSON string payload (iterable but not an array) yields no findings", () => {
			// JSON.parse('"hello"') => "hello" (a string). A string IS iterable, so if the
			// Array.isArray guard were disabled, the for..of loop would silently iterate
			// its characters and push 5 bogus findings instead of returning [].
			spawnSyncMock.mockReturnValue({
				error: undefined,
				stdout: JSON.stringify("hello"),
				status: 0,
			});
			const results = runSwiftLint(input());
			expect(results).toEqual([]);
		});
	});

	// --- runSwiftLint ENOENT guard (4330bfcc14a357f3, cac5adb742e8862d,
	//     e37d65116705e7e1, fee52567bb45334b, d6a722454205e218) ---
	describe("runSwiftLint — ENOENT guard short-circuits before parsing", () => {
		it("P: error.code === ENOENT returns [] even though stdout has valid findings", () => {
			spawnSyncMock.mockReturnValue({
				error: { code: "ENOENT" } as NodeJS.ErrnoException,
				stdout: JSON.stringify([
					{ file: "/repo/a.swift", line: 1, severity: "warning", type: "x", rule_id: "r", reason: "why" },
				]),
				status: 0,
			});
			const results = runSwiftLint(input());
			expect(results).toEqual([]);
		});

		it("N: a non-ENOENT error does NOT short-circuit — findings are still parsed", () => {
			spawnSyncMock.mockReturnValue({
				error: { code: "EACCES" } as NodeJS.ErrnoException,
				stdout: JSON.stringify([
					{ file: "/repo/a.swift", line: 3, severity: "warning", type: "x", rule_id: "r1", reason: "why" },
				]),
				status: 0,
			});
			const results = runSwiftLint(input());
			expect(results).toHaveLength(1);
			expect(results[0]?.ruleId).toBe("r1");
		});
	});

	// --- runSwiftLint fallback "" and trim()/output guards
	//     (af148cbdd09555dd, 6c91893d23f6f993, 73051e757db3b425) ---
	describe("runSwiftLint — empty/whitespace stdout never reaches JSON.parse", () => {
		it("P: whitespace-only stdout short-circuits without invoking JSON.parse", () => {
			const parseSpy = vi.spyOn(JSON, "parse");
			spawnSyncMock.mockReturnValue({
				error: undefined,
				stdout: "   ",
				status: 0,
			});
			const results = runSwiftLint(input());
			expect(results).toEqual([]);
			expect(parseSpy).not.toHaveBeenCalled();
		});

		it("P: undefined stdout falls back to empty string, not a literal placeholder", () => {
			const parseSpy = vi.spyOn(JSON, "parse");
			spawnSyncMock.mockReturnValue({
				error: undefined,
				stdout: undefined,
				status: 0,
			});
			const results = runSwiftLint(input());
			expect(results).toEqual([]);
			expect(parseSpy).not.toHaveBeenCalled();
		});
	});

	// --- runSwiftLint scope.mode/targetFile arg-building
	//     (39dc454a8880d773, a7dfe57e9053fcab, e3b996c1de7005f4) ---
	describe("runSwiftLint — only pushes --path when mode is exactly 'file'", () => {
		it("N: mode='project' with a targetFile set does NOT add --path", () => {
			spawnSyncMock.mockReturnValue({ error: undefined, stdout: "[]", status: 0 });
			runSwiftLint(input({ mode: "project", targetFile: "a.swift" }));
			const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
			expect(args).not.toContain("--path");
		});

		it("P: mode='file' with a targetFile set DOES add --path <file>", () => {
			spawnSyncMock.mockReturnValue({ error: undefined, stdout: "[]", status: 0 });
			runSwiftLint(input({ mode: "file", targetFile: "a.swift" }));
			const args = spawnSyncMock.mock.calls[0]?.[1] as string[];
			expect(args).toContain("--path");
			expect(args).toContain("a.swift");
		});
	});

	// --- runSwiftLintAsync mirrors: ENOENT-independent trim guard
	//     (e11671cc88e1c4e0, 92ff1206534f11fa) ---
	describe("runSwiftLintAsync — whitespace-only stdout never invokes JSON.parse", () => {
		it("P: whitespace-only stdout short-circuits without invoking JSON.parse", async () => {
			const parseSpy = vi.spyOn(JSON, "parse");
			runProcessAsyncMock.mockResolvedValue({
				stdout: "   ",
				stderr: "",
				code: 0,
				timedOut: false,
				killed: false,
			});
			const results = await runSwiftLintAsync(input());
			expect(results).toEqual([]);
			expect(parseSpy).not.toHaveBeenCalled();
		});
	});

	// --- runSwiftLintAsync scope.mode/targetFile arg-building
	//     (02f1da62c894a69f, 668d7e52d81bfb8e, 85d16147bd4fe31c) ---
	describe("runSwiftLintAsync — only pushes --path when mode is exactly 'file'", () => {
		it("N: mode='project' with a targetFile set does NOT add --path", async () => {
			runProcessAsyncMock.mockResolvedValue({
				stdout: "[]",
				stderr: "",
				code: 0,
				timedOut: false,
				killed: false,
			});
			await runSwiftLintAsync(input({ mode: "project", targetFile: "a.swift" }));
			const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
			expect(args).not.toContain("--path");
		});

		it("P: mode='file' with a targetFile set DOES add --path <file>", async () => {
			runProcessAsyncMock.mockResolvedValue({
				stdout: "[]",
				stderr: "",
				code: 0,
				timedOut: false,
				killed: false,
			});
			await runSwiftLintAsync(input({ mode: "file", targetFile: "a.swift" }));
			const args = runProcessAsyncMock.mock.calls[0]?.[1] as string[];
			expect(args).toContain("--path");
			expect(args).toContain("a.swift");
		});
	});

	// --- parseSwiftBuildOutput regex (866d75dbfe987557, d528476ef7aa46f4,
	//     93b84185cc6fca3f, 5d55fb71d5d54271) ---
	describe("runSwiftBuild — diagnostic regex is anchored and exact", () => {
		function buildInput() {
			return input({ mode: "project" });
		}

		it("P: a diagnostic line preceded by a carriage return does NOT match (anchor matters)", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: "\r/repo/File.swift:10:5: error: bad thing\n",
				stdout: "",
			});
			const results = runSwiftBuild(buildInput());
			expect(results).toEqual([]);
		});

		it("P: a multi-digit column number is captured in full", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: "/repo/File.swift:10:25: error: bad thing\n",
				stdout: "",
			});
			const results = runSwiftBuild(buildInput());
			expect(results).toHaveLength(1);
			expect(results[0]?.column).toBe(25);
			expect(results[0]?.line).toBe(10);
		});

		it("P: zero whitespace before the error/warning keyword still matches", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: "/repo/File.swift:10:5:error: bad thing\n",
				stdout: "",
			});
			const results = runSwiftBuild(buildInput());
			expect(results).toHaveLength(1);
			expect(results[0]?.severity).toBe("error");
		});

		it("P: zero whitespace before the message still matches and captures the full message", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: "/repo/File.swift:10:5: error:message text\n",
				stdout: "",
			});
			const results = runSwiftBuild(buildInput());
			expect(results).toHaveLength(1);
			expect(results[0]?.message).toBe("message text");
		});
	});

	// --- runSwiftBuild ENOENT guard
	//     (8ad060a5e3fe43d1, d1fbf08a8057d207, 3981817f8b962bbe,
	//      aaeca8082ce1b669, 43affbf4b38aa9e7) ---
	describe("runSwiftBuild — ENOENT guard short-circuits before parsing", () => {
		it("P: error.code === ENOENT returns [] even with a nonzero status and diagnostics on stderr", () => {
			spawnSyncMock.mockReturnValue({
				error: { code: "ENOENT" } as NodeJS.ErrnoException,
				status: 1,
				stderr: "/repo/File.swift:10:5: error: bad thing\n",
				stdout: "",
			});
			const results = runSwiftBuild(input());
			expect(results).toEqual([]);
		});

		it("N: a non-ENOENT error does NOT short-circuit — diagnostics are still parsed", () => {
			spawnSyncMock.mockReturnValue({
				error: { code: "EACCES" } as NodeJS.ErrnoException,
				status: 1,
				stderr: "/repo/File.swift:10:5: error: bad thing\n",
				stdout: "",
			});
			const results = runSwiftBuild(input());
			expect(results).toHaveLength(1);
			expect(results[0]?.message).toBe("bad thing");
		});
	});

	// --- runSwiftBuild stderr/stdout concatenation fallback ""
	//     (3fe03e89cf1c5cb8, c6db99ab3c5de5f5) ---
	describe("runSwiftBuild — stderr/stdout concatenation uses empty-string fallback exactly", () => {
		it("P: undefined stderr contributes nothing before stdout's diagnostic", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: undefined,
				stdout: "/repo/File.swift:10:5: error: from stdout\n",
			});
			const results = runSwiftBuild(input());
			expect(results).toHaveLength(1);
			expect(results[0]?.file).toBe("/repo/File.swift");
		});

		it("P: undefined stdout contributes nothing after stderr's diagnostic (no trailing junk in message)", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: "/repo/File.swift:10:5: error: bad message",
				stdout: undefined,
			});
			const results = runSwiftBuild(input());
			expect(results).toHaveLength(1);
			expect(results[0]?.message).toBe("bad message");
		});
	});

	// --- runSwiftBuild scope.mode/targetFile output filtering
	//     (b5043f963ba1c633, b5a65b16e0021ab6, 1f6cfc4a33f97bee) ---
	describe("runSwiftBuild — only filters results to targetFile when mode is exactly 'file'", () => {
		it("N: mode='project' with targetFile+filterToFile set returns ALL diagnostics, unfiltered", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: "/repo/X.swift:1:1: error: x issue\n/repo/Y.swift:2:2: error: y issue\n",
				stdout: "",
			});
			const results = runSwiftBuild(
				input({ mode: "project", targetFile: "/repo/X.swift", filterToFile: true }),
			);
			expect(results).toHaveLength(2);
		});

		it("P: mode='file' with targetFile+filterToFile set returns only the matching file's diagnostics", () => {
			spawnSyncMock.mockReturnValue({
				error: undefined,
				status: 1,
				stderr: "/repo/X.swift:1:1: error: x issue\n/repo/Y.swift:2:2: error: y issue\n",
				stdout: "",
			});
			const results = runSwiftBuild(
				input({ mode: "file", targetFile: "/repo/X.swift", filterToFile: true }),
			);
			expect(results).toHaveLength(1);
			expect(results[0]?.file).toBe("/repo/X.swift");
		});
	});
});
