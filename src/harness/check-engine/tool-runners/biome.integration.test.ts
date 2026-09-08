import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral unit tests for the Biome tool runners (sync, async, overlay).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `npx biome` and never touch the real filesystem:
//   • node:child_process `spawnSync` — drives runBiome / runBiomeOverlay.
//   • ../spawn-async.js `runProcessAsync` — drives runBiomeAsync.
//   • node:fs `existsSync` / `writeFileSync` / `unlinkSync` — drive the
//     biome-config discovery walk and the overlay temp-file lifecycle.
// The real `parseBiomeOutput` parser runs unmocked so we exercise the actual
// "file:line:col <rule>" → CheckResult[] mapping, the no-diagnostics → tool
// FAILURE synthesis branch, and the overlay tmp-path → target-path rewrite.

import type { SpawnSyncReturns } from "node:child_process";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { RunProcessResult } from "../spawn-async.js";
import type { CheckResult, CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn<SpawnSyncStub>();
const runProcessAsyncMock = vi.fn<typeof import("../spawn-async.js").runProcessAsync>();
const existsSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: Parameters<SpawnSyncStub>) => spawnSyncMock(...args),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: Parameters<typeof runProcessAsyncMock>) => runProcessAsyncMock(...args),
}));

vi.mock("node:fs", () => ({
	existsSync: (...args: unknown[]) => existsSyncMock(...args),
	writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
	unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

// Imported after the mocks are registered.
const { runBiome, runBiomeAsync, runBiomeOverlay } = await import("./biome.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = "src/app.ts";

/** A biome `check` diagnostic header that the parser recognizes — a lint rule
 *  finding on `file`. Trailing content mimics biome's box-drawing rule rows. */
function biomeLintFinding(file = TARGET): string {
	return `${file}:5:3 lint/suspicious/noDoubleEquals ━━━━━━━━━━\n  some context\n`;
}

/** A biome PARSE diagnostic — the parser maps parse/syntax to severity error. */
function biomeParseFinding(file = TARGET): string {
	return `${file}:1:1 parse ━━━━━━━━━━\n`;
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: TARGET,
		...overrides,
	};
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** Build a minimal SpawnSyncReturns. `stdout`/`stderr` widened to
 *  `string | undefined` so we can exercise the `result.x || ""` fallbacks. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
	// SAFETY: this fixture deliberately allows absent stdout/stderr to exercise the runner's fallback for incomplete process results.
	return {
		pid: 123,
		output: [],
		stdout: "",
		stderr: "",
		status: null,
		signal: null,
		...over,
	} as SpawnSyncReturns<string>;
}

function procResult(over: Partial<RunProcessResult>): RunProcessResult {
	return {
		stdout: "",
		stderr: "",
		code: null,
		timedOut: false,
		killed: false,
		...over,
	};
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	runProcessAsyncMock.mockReset();
	existsSyncMock.mockReset();
	writeFileSyncMock.mockReset();
	unlinkSyncMock.mockReset();
	// Default: a biome.json exists at the project root (first probe hits).
	existsSyncMock.mockReturnValue(true);
});

describe("runBiome — .claude/ tooling exclusion", () => {
	it("returns [] without spawning for a .claude/workflows target (file mode)", () => {
		const out = runBiome(input(fileScope({ targetFile: ".claude/workflows/cross-repo.js" })));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
	it("still runs biome for an ordinary source target", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: biomeLintFinding() }));
		const out = runBiome(input(fileScope({ targetFile: "src/app.ts" })));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(out.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// findBiomeConfig (exercised indirectly through runBiome's early return)
// ---------------------------------------------------------------------------

describe("biome-config discovery", () => {
	it("returns [] without spawning when no biome.json/jsonc is found within 5 levels", () => {
		// A deep path: every probe misses, the loop exhausts its 5 iterations.
		existsSyncMock.mockReturnValue(false);
		const out = runBiome(input(fileScope({ projectRoot: "/a/b/c/d/e/f/g" })));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("returns [] without spawning when the walk reaches the filesystem root (parent === dir)", () => {
		// projectRoot "/" → dirname("/") === "/" so the parent === dir guard
		// terminates the walk before the 5-iteration cap.
		existsSyncMock.mockReturnValue(false);
		const out = runBiome(input(fileScope({ projectRoot: "/" })));
		expect(out).toEqual([]);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("discovers biome.jsonc when biome.json is absent (second existsSync probe)", () => {
		// First probe (biome.json) misses, second (biome.jsonc) hits → config found.
		existsSyncMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const out = runBiome(input(fileScope()));
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});

	it("discovers a config in an ANCESTOR directory (walks up past the start dir)", () => {
		// Start dir misses both probes; the parent dir's biome.json hits on the
		// 3rd existsSync call — exercises the parent-ascent + i<5 continue path.
		existsSyncMock
			.mockReturnValueOnce(false) // <root>/biome.json
			.mockReturnValueOnce(false) // <root>/biome.jsonc
			.mockReturnValueOnce(true); // <parent>/biome.json
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		const out = runBiome(input(fileScope()));
		expect(out).toEqual([]);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// runBiome (sync)
// ---------------------------------------------------------------------------

describe("runBiome (sync)", () => {
	it("invokes `npx biome check` on the single file in file mode (cwd/timeout/pipes)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runBiome(input(fileScope(), 9_999));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(spawnSyncMock.mock.calls[0]);
		expect(cmd).toBe("npx");
		expect(args).toEqual(["biome", "check", "--no-errors-on-unmatched", TARGET]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 9_999,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("checks the whole project (`.`) in project mode", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runBiome(input(fileScope({ mode: "project" })));
		expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
			"biome",
			"check",
			"--no-errors-on-unmatched",
			".",
		]);
	});

	it("checks `.` in file mode when targetFile is missing", () => {
		const scope = fileScope();
		delete (scope).targetFile;
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runBiome(input(scope));
		expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
			"biome",
			"check",
			"--no-errors-on-unmatched",
			".",
		]);
	});

	it("returns [] when status === 0 (clean) without parsing", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: biomeLintFinding() }));
		expect(runBiome(input(fileScope()))).toEqual([]);
	});

	it("parses a lint finding on non-zero status (stdout)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: biomeLintFinding() }));
		const out = runBiome(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "biome",
				severity: "warning",
				file: TARGET,
				line: 5,
				column: 3,
				message: "lint/suspicious/noDoubleEquals",
				ruleId: "lint/suspicious/noDoubleEquals",
			},
		]);
	});

	it("maps a parse diagnostic to severity 'error'", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: biomeParseFinding() }));
		const out = runBiome(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ severity: "error", ruleId: "parse", line: 1, column: 1 });
	});

	it("reads a finding from stderr when stdout is undefined ('' fallback)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: undefined, stderr: biomeLintFinding() }),
		);
		const out = runBiome(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).ruleId).toBe("lint/suspicious/noDoubleEquals");
	});

	it("synthesizes a tool-FAILURE finding when biome exits non-zero but parses NO diagnostics", () => {
		// Silence on a non-zero exit must NOT read as clean (round-6 fail-open class).
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 2, stdout: "internal error: panic\n", stderr: "" }),
		);
		const out = runBiome(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ tool: "biome", severity: "warning", file: ".", line: 1 });
		expect(nonNull(out[0]).message).toContain("biome exited 2");
		expect(nonNull(out[0]).message).toContain("NOT validated");
	});

	it("reports the failure with 'without status' when status is null and no diagnostics parse", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, stdout: undefined, stderr: undefined }));
		const out = runBiome(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("biome exited without status");
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runBiome(input(fileScope()))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// runBiomeAsync
// ---------------------------------------------------------------------------

describe("runBiomeAsync", () => {
	it("returns [] without spawning when no biome config is found", async () => {
		existsSyncMock.mockReturnValue(false);
		const out = await runBiomeAsync(input(fileScope({ projectRoot: "/a/b/c/d/e/f/g" })));
		expect(out).toEqual([]);
		expect(runProcessAsyncMock).not.toHaveBeenCalled();
	});

	it("invokes runProcessAsync on the single file in file mode (cwd/timeout)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runBiomeAsync(input(fileScope(), 4_321));
		expect(runProcessAsyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = nonNull(runProcessAsyncMock.mock.calls[0]);
		expect(cmd).toBe("npx");
		expect(args).toEqual(["biome", "check", "--no-errors-on-unmatched", TARGET]);
		expect(opts).toEqual({ cwd: PROJECT_ROOT, timeout: 4_321 });
	});

	it("checks `.` in project mode", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0 }));
		await runBiomeAsync(input(fileScope({ mode: "project" })));
		expect(runProcessAsyncMock.mock.calls[0]?.[1]).toEqual([
			"biome",
			"check",
			"--no-errors-on-unmatched",
			".",
		]);
	});

	it("returns [] when code === 0 (clean)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 0, stdout: biomeLintFinding() }));
		expect(await runBiomeAsync(input(fileScope()))).toEqual([]);
	});

	it("parses a lint finding on non-zero code (stdout + stderr concat)", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 1, stdout: biomeLintFinding() }));
		const out = await runBiomeAsync(input(fileScope()));
		expect(out).toEqual<CheckResult[]>([
			{
				tool: "biome",
				severity: "warning",
				file: TARGET,
				line: 5,
				column: 3,
				message: "lint/suspicious/noDoubleEquals",
				ruleId: "lint/suspicious/noDoubleEquals",
			},
		]);
	});

	it("synthesizes a tool-FAILURE finding on a non-zero code that parses NO diagnostics", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: 2, stdout: "panic\n" }));
		const out = await runBiomeAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("biome exited 2");
		expect(nonNull(out[0]).message).toContain("NOT validated");
	});

	it("reports 'without status' when code is null and no diagnostics parse", async () => {
		runProcessAsyncMock.mockResolvedValue(procResult({ code: null }));
		const out = await runBiomeAsync(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).message).toContain("biome exited without status");
	});
});

// ---------------------------------------------------------------------------
// runBiomeOverlay
// ---------------------------------------------------------------------------

describe("runBiomeOverlay", () => {
	const overlayInput = (filePath = `${PROJECT_ROOT}/src/app.ts`) => ({
		projectRoot: PROJECT_ROOT,
		timeoutMs: 5_000,
		filePath,
		content: "const x = 1;\n",
	});

	it("returns [] without writing or spawning when no biome config is found", () => {
		existsSyncMock.mockReturnValue(false);
		const out = runBiomeOverlay({ ...overlayInput(), projectRoot: "/a/b/c/d/e/f/g" });
		expect(out).toEqual([]);
		expect(writeFileSyncMock).not.toHaveBeenCalled();
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("writes the overlay content to a sibling temp file, then deletes it", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runBiomeOverlay(overlayInput());
		expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
		const writtenPath = writeFileSyncMock.mock.calls[0]?.[0];
		assert(typeof writtenPath === "string");
		// Same directory as the target, base name preserved, `.ts` extension kept.
		expect(writtenPath.startsWith(`${PROJECT_ROOT}/src/app.overlay-`)).toBe(true);
		expect(writtenPath.endsWith(".ts")).toBe(true);
		// The same temp path is unlinked in the finally block.
		expect(unlinkSyncMock).toHaveBeenCalledWith(writtenPath);
	});

	it("returns [] when biome exits clean (status === 0) on the overlay file", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: biomeLintFinding() }));
		expect(runBiomeOverlay(overlayInput())).toEqual([]);
		expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
	});

	it("rewrites tmp-file diagnostic paths back to the target file path", () => {
		// biome reports the diagnostic against the temp file; the runner must
		// rewrite that path to the real target so downstream diffing matches.
		let tmpPath = "";
		writeFileSyncMock.mockImplementation((p: string) => {
			tmpPath = p;
		});
		spawnSyncMock.mockImplementation(() => {
			// The diagnostic file equals the tmp path (relativized by the runner).
			const tmpRel = tmpPath.slice(`${PROJECT_ROOT}/`.length);
			return spawnResult({ status: 1, stdout: biomeLintFinding(tmpRel) });
		});
		const out = runBiomeOverlay(overlayInput());
		expect(out).toHaveLength(1);
		// Path rewritten from the tmp file back to the target's relative path.
		expect(nonNull(out[0]).file).toBe("src/app.ts");
		expect(nonNull(out[0]).ruleId).toBe("lint/suspicious/noDoubleEquals");
	});

	it("leaves non-tmp diagnostic paths untouched (only the overlay file is rewritten)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: biomeLintFinding("src/other.ts") }),
		);
		const out = runBiomeOverlay(overlayInput());
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("src/other.ts");
	});

	it("reads a finding from stderr when stdout is undefined ('' fallback on the stdout side)", () => {
		// stdout undefined → `result.stdout || ""`; the diagnostic arrives via
		// stderr, exercising the stderr half of the output concat.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: undefined, stderr: biomeLintFinding("src/other.ts") }),
		);
		const out = runBiomeOverlay(overlayInput());
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe("src/other.ts");
		expect(nonNull(out[0]).ruleId).toBe("lint/suspicious/noDoubleEquals");
	});

	it("returns [] from the catch block when spawnSync throws (and still unlinks)", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runBiomeOverlay(overlayInput())).toEqual([]);
		// finally still runs the cleanup.
		expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
	});

	it("swallows a cleanup failure when unlinkSync throws in the finally block", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		unlinkSyncMock.mockImplementation(() => {
			throw new Error("ENOENT unlink");
		});
		// The unlink error is caught — the overlay result is unaffected.
		expect(runBiomeOverlay(overlayInput())).toEqual([]);
		expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
	});
});
