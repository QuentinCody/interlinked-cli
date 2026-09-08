import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxCyclomaticFor } from "../../metric-caps.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";
import { parseLizardOutput, runLizard, runLizardAsync } from "./lizard.js";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

vi.mock("../../metric-caps.js", () => ({
	maxCyclomaticFor: vi.fn(),
}));

vi.mock("../spawn-async.js", () => ({
	runProcessAsync: vi.fn(),
}));

const mockedSpawnSync = vi.mocked(spawnSync);
const mockedMaxCyclomaticFor = vi.mocked(maxCyclomaticFor);
const mockedRunProcessAsync = vi.mocked(runProcessAsync);

function makeInput(overrides: Partial<ToolRunnerInput["scope"]> = {}, timeoutMs = 5000): ToolRunnerInput {
	return {
		scope: {
			projectRoot: "/repo",
			mode: "project",
			...overrides,
		},
		timeoutMs,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockedMaxCyclomaticFor.mockReturnValue(25);
});

describe("parseLizardOutput — positive (must fire)", () => {
	// NOTE (closing-verifier pass): P1/P2/P3 previously asserted `toEqual([])`
	// for zero-whitespace variants around "warning:"/function-name/"CCN",
	// under the assumption the source regex required `\s` (one-or-more) at
	// those positions. The actual source
	// (`check-engine/tool-runners/lizard.ts`) uses `\s*` (zero-or-more) at
	// all three positions, so these inputs genuinely match and produce a
	// CheckResult — the assertions were backwards relative to the real
	// (intended, degrade-gracefully) parser behavior. Deleted rather than
	// "fixed to expect a match" since a zero-whitespace-tolerant parse is the
	// documented behavior, not a mutant to kill.

	// test-contract: invariant — well-formed input still parses to the exact
	// expected CheckResult (baseline sanity, also guards against several
	// regex-lexeme mutants collapsing the match silently)
	it("P4: parses a well-formed warning line to the exact CheckResult", () => {
		const out = "src/main.go:42: warning: handleRequest has 31 CCN and 4 params (88 NLOC, 410 token)\n";
		const expected: CheckResult[] = [
			{
				tool: "lizard",
				severity: "warning",
				file: "src/main.go",
				line: 42,
				message: "Function `handleRequest` has cyclomatic complexity 31 — consider decomposing it.",
				ruleId: "lizard/cyclomatic",
			},
		];
		expect(parseLizardOutput(out)).toEqual(expected);
	});
});

describe("lizardArgs (via runLizard) — target-selection branch", () => {
	function argsOf(scopeOverrides: Partial<ToolRunnerInput["scope"]>): string[] {
		mockedSpawnSync.mockReturnValueOnce({
			stdout: "",
			stderr: "",
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			// SAFETY: test double for SpawnSyncReturns<string> — only the
			// fields runLizard reads (stdout/error) matter to the test.
		});
		runLizard(makeInput(scopeOverrides));
		const call = mockedSpawnSync.mock.calls[0];
		// SAFETY: spawnSync(cmd, args, opts) — args is always string[].
		return call?.[1] as string[];
	}

	// test-contract: invariant — mode="file" with a targetFile set must target the
	// file (kills d7e2fa "&&"->false and 8e837bc "file"->"" which both
	// force target back to ".")
	it("N1: mode=file + targetFile targets the file, not '.'", () => {
		const args = argsOf({ mode: "file", targetFile: "/repo/src/foo.go" });
		expect(args[args.length - 1]).toBe("/repo/src/foo.go");
	});

	// test-contract: invariant — mode="project" with a truthy targetFile must
	// still target "." (kills 7c63a51 "&&"->true, c101ae "&&"->"||",
	// 2bc9633 "mode===file"->true, c1dfd4e "==="->"!==")
	it("N2: mode=project ignores a truthy targetFile and targets '.'", () => {
		const args = argsOf({ mode: "project", targetFile: "/repo/src/foo.go" });
		expect(args[args.length - 1]).toBe(".");
	});

	// test-contract: invariant — mode="project" with no targetFile must fall back
	// to the literal "." (kills e308a13 '"."'->'""')
	it("N3: mode=project + no targetFile falls back to the literal '.'", () => {
		const args = argsOf({ mode: "project" });
		expect(args[args.length - 1]).toBe(".");
	});

	// test-contract: invariant — the exact argv shape, including every flag
	// literal (kills every StringLiteral/'' mutant on --warnings_only, -L,
	// 100000, -a, 1000)
	it("N4: builds the exact argv for a file-mode target", () => {
		mockedMaxCyclomaticFor.mockReturnValue(25);
		const args = argsOf({ mode: "file", targetFile: "/repo/src/foo.go" });
		expect(args).toEqual([
			"--warnings_only",
			"-C",
			"25",
			"-L",
			"100000",
			"-a",
			"1000",
			"/repo/src/foo.go",
		]);
	});

	// test-contract: invariant — runLizard's spawnSync call carries the exact
	// executable name and options object (kills 140bfe4 '"lizard"'->"",
	// c892eca options-object->{}, eba4bd5 '"utf-8"'->"", 974266c stdio->[],
	// and the three per-slot '"pipe"'->"" mutants)
	it("N5: invokes spawnSync with the exact command and options, and returns no results for empty stdout", () => {
		mockedSpawnSync.mockReturnValueOnce({
			stdout: "",
			stderr: "",
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			// SAFETY: test double for SpawnSyncReturns<string> — only stdout
			// (consumed via parseLizardOutput/scoped) matters to the test.
		});
		const results = runLizard(makeInput({ mode: "project" }));
		expect(mockedSpawnSync).toHaveBeenCalledWith("lizard", expect.any(Array), {
			cwd: "/repo",
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		expect(results).toEqual([]);
	});
});

describe("scoped (via runLizard) — filter-gate branch", () => {
	function scopedResultsOf(scopeOverrides: Partial<ToolRunnerInput["scope"]>): CheckResult[] {
		const line =
			"src/other.go:1: warning: helper has 30 CCN and 1 params (5 NLOC, 5 token)\n" +
			"src/target.go:2: warning: main has 30 CCN and 1 params (5 NLOC, 5 token)\n";
		mockedSpawnSync.mockReturnValueOnce({
			stdout: line,
			stderr: "",
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			// SAFETY: test double for SpawnSyncReturns<string> — only stdout
			// (consumed via parseLizardOutput/scoped) matters to the test.
		});
		return runLizard(makeInput(scopeOverrides));
	}

	// test-contract: invariant — mode="file" + targetFile + filterToFile=false must
	// return BOTH results unfiltered (kills c230fad's last "&&"->"||", which
	// would filter down to just the target-file result even though
	// filterToFile is false)
	it("N1: filterToFile=false with mode=file returns unfiltered results", () => {
		const results = scopedResultsOf({
			mode: "file",
			targetFile: "src/target.go",
			filterToFile: false,
		});
		expect(results).toHaveLength(2);
	});

	// test-contract: invariant — mode="project" (not "file") with filterToFile=true
	// must return unfiltered results regardless of targetFile (kills
	// 0bbcdcf "mode===file&&targetFile"->true, 62f6c9b "&&"->"||", and
	// 31f052b "mode===file"->true, all of which would apply the filter here)
	it("N2: mode=project never filters even when filterToFile=true", () => {
		const results = scopedResultsOf({
			mode: "project",
			targetFile: "src/target.go",
			filterToFile: true,
		});
		expect(results).toHaveLength(2);
	});
});

describe("runLizard — ENOENT / spawn-error handling", () => {
	// test-contract: invariant — error present with code ENOENT must short-circuit
	// to [] even though stdout looks parseable (kills e7bc66b cond->false,
	// ea9194202 empty-block, c86ed326 "==="->"!==", ee921eab '"ENOENT"'->"")
	it("N1: an ENOENT spawn error returns [] and ignores stdout", () => {
		mockedSpawnSync.mockReturnValueOnce({
			stdout: "src/main.go:1: warning: foo has 5 CCN and 1 params (1 NLOC, 1 token)\n",
			stderr: "",
			status: null,
			signal: null,
			pid: 0,
			output: [],
			error: Object.assign(new Error("spawn lizard ENOENT"), { code: "ENOENT" }),
			// SAFETY: test double for SpawnSyncReturns<string> with a
			// synthetic ENOENT spawn error — matches Node's real shape.
		});
		expect(runLizard(makeInput({ mode: "project" }))).toEqual([]);
	});

	// test-contract: invariant — a spawn error with a DIFFERENT code must NOT
	// short-circuit — stdout is still parsed (kills 35e81515 "code===ENOENT"
	// forced to true, which would treat ANY error as ENOENT)
	it("N2: a non-ENOENT spawn error still parses stdout", () => {
		mockedSpawnSync.mockReturnValueOnce({
			stdout: "src/main.go:1: warning: foo has 5 CCN and 1 params (1 NLOC, 1 token)\n",
			stderr: "",
			status: null,
			signal: null,
			pid: 0,
			output: [],
			error: Object.assign(new Error("spawn lizard EACCES"), { code: "EACCES" }),
			// SAFETY: test double for SpawnSyncReturns<string> with a
			// non-ENOENT spawn error — matches Node's real shape.
		});
		const results = runLizard(makeInput({ mode: "project" }));
		expect(results).toHaveLength(1);
		expect(results[0]?.file).toBe("src/main.go");
	});
});

describe("runLizardAsync — argv + call shape", () => {
	// test-contract: invariant — runLizardAsync invokes runProcessAsync with
	// "lizard" + exact options AND returns its parsed CheckResult (kills
	// 7709b87 '"lizard"'->"" and e4975c7 options-object->{}); asserting the
	// return value too, not just the call, per mock_only_test.
	it("N1: calls runProcessAsync with the tool name and exact options, and returns its parsed result", async () => {
		mockedRunProcessAsync.mockResolvedValueOnce({
			stdout: "src/main.go:1: warning: foo has 5 CCN and 1 params (1 NLOC, 1 token)\n",
			stderr: "",
			code: 0,
			timedOut: false,
			killed: false,
		});
		const results = await runLizardAsync(makeInput({ mode: "project" }, 7000));
		expect(mockedRunProcessAsync).toHaveBeenCalledWith(
			"lizard",
			expect.any(Array),
			{ cwd: "/repo", timeout: 7000 },
		);
		expect(results).toEqual([
			{
				tool: "lizard",
				severity: "warning",
				file: "src/main.go",
				line: 1,
				message: "Function `foo` has cyclomatic complexity 5 — consider decomposing it.",
				ruleId: "lizard/cyclomatic",
			},
		]);
	});
});
