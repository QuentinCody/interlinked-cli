import { nonNull } from "../../../lib/non-null.js";
import type { SpawnSyncStub } from "./test-process-fixtures.js";
// Behavioral tests for the lizard polyglot-complexity tool-runner.
//
// `spawnSync` (sync path) and `runProcessAsync` (async path) are the only
// mocked boundaries; the real `parseLizardOutput` / `filterResultsToFile`
// run unmocked so the warning-line → CheckResult mapping is exercised end to
// end. Every branch of both runners is covered: ENOENT → [], clean (no
// warnings) → [], warnings → parsed, file-mode filter, project mode
// (unfiltered), and the sync catch block.

import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_CYCLOMATIC, resetMetricCapsCache } from "../../metric-caps.js";
import type { CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn<SpawnSyncStub>();
const runProcessAsyncMock = vi.fn<typeof import("../spawn-async.js").runProcessAsync>();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: Parameters<SpawnSyncStub>) => spawnSyncMock(...args),
}));
vi.mock("../spawn-async.js", () => ({
	runProcessAsync: (...args: Parameters<typeof runProcessAsyncMock>) => runProcessAsyncMock(...args),
}));

const { runLizard, runLizardAsync, parseLizardOutput } = await import("./lizard.js");

const WARN = "src/main.go:42: warning: handleRequest has 31 CCN and 4 params (88 NLOC, 410 token)";

function input(scope: Partial<CheckScope> = {}): ToolRunnerInput {
	return {
		scope: {
			projectRoot: "/work",
			mode: "file",
			targetFile: "src/main.go",
			filterToFile: true,
			...scope,
		},
		timeoutMs: 5000,
	};
}

function spawnResult(over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
		...over,
	};
}

describe("parseLizardOutput", () => {
	it("maps a warning line to a CheckResult", () => {
		const [r] = parseLizardOutput(WARN);
		expect(r).toMatchObject({
			tool: "lizard",
			severity: "warning",
			file: "src/main.go",
			line: 42,
			ruleId: "lizard/cyclomatic",
		});
		expect(r?.message).toContain("handleRequest");
		expect(r?.message).toContain("31");
	});

	it("tolerates a different metric order (CCN not first)", () => {
		const line = "a.rs:7: warning: foo has 60 NLOC, 28 CCN, 200 token";
		expect(parseLizardOutput(line)[0]?.message).toContain("28");
	});

	it("ignores non-warning lines and summaries", () => {
		expect(parseLizardOutput("==== Lizard summary ====\nTotal: 3 functions")).toEqual([]);
		expect(parseLizardOutput("")).toEqual([]);
	});
});

describe("runLizard (sync)", () => {
	it("returns [] when lizard is not installed (ENOENT)", () => {
		spawnSyncMock.mockReturnValueOnce(
			spawnResult({ error: Object.assign(new Error("nope"), { code: "ENOENT" }) }),
		);
		expect(runLizard(input())).toEqual([]);
	});

	it("returns [] when no functions exceed the cap (clean)", () => {
		spawnSyncMock.mockReturnValueOnce(spawnResult({ stdout: "", status: 0 }));
		expect(runLizard(input())).toEqual([]);
	});

	it("parses warnings and filters to the target file in file mode", () => {
		spawnSyncMock.mockReturnValueOnce(
			spawnResult({ stdout: `${WARN}\nother/x.go:9: warning: g has 99 CCN`, status: 1 }),
		);
		const out = runLizard(input());
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("src/main.go");
	});

	it("does not filter in project mode", () => {
		spawnSyncMock.mockReturnValueOnce(
			spawnResult({ stdout: `${WARN}\nother/x.go:9: warning: g has 99 CCN`, status: 1 }),
		);
		const out = runLizard({
			scope: { projectRoot: "/work", mode: "project", filterToFile: false },
			timeoutMs: 5000,
		});
		expect(out).toHaveLength(2);
	});

	it("returns [] when spawnSync throws (catch)", () => {
		spawnSyncMock.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		expect(runLizard(input())).toEqual([]);
	});
});

describe("cyclomatic cap (-C) tracks the repo's configured value", () => {
	// Regression for finding 2026-06: the runner hardcoded `-C 25`, ignoring
	// `interlinked caps set cyclomatic <n>` so lizard's bar diverged from the TS
	// AST gate + radon on every repo that tuned the cap. The cap now flows from
	// `maxCyclomaticFor(projectRoot)`; these pin both the default and the override.
	function lastArgv(): string[] {
		return nonNull(spawnSyncMock.mock.calls.at(-1))[1];
	}

	it("uses DEFAULT_MAX_CYCLOMATIC when no metric-caps.json override is set", () => {
		spawnSyncMock.mockReturnValueOnce(spawnResult({ stdout: "", status: 0 }));
		runLizard(input()); // projectRoot "/work" has no metric-caps.json
		const argv = lastArgv();
		expect(argv[argv.indexOf("-C") + 1]).toBe(String(DEFAULT_MAX_CYCLOMATIC));
	});

	it("honors a tuned `max_cyclomatic` (metric-caps.json) instead of the default", () => {
		const repo = mkdtempSync(join(tmpdir(), "lizard-caps-"));
		mkdirSync(join(repo, ".interlinked"), { recursive: true });
		writeFileSync(
			join(repo, ".interlinked", "metric-caps.json"),
			JSON.stringify({ version: 1, max_cyclomatic: 7 }),
		);
		resetMetricCapsCache(); // pick up the just-written file, not a stale memo
		try {
			spawnSyncMock.mockReturnValueOnce(spawnResult({ stdout: "", status: 0 }));
			runLizard({
				scope: { projectRoot: repo, mode: "project", filterToFile: false },
				timeoutMs: 5000,
			});
			const argv = lastArgv();
			expect(argv[argv.indexOf("-C") + 1]).toBe("7");
			expect(argv[argv.indexOf("-C") + 1]).not.toBe(String(DEFAULT_MAX_CYCLOMATIC));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("runLizardAsync", () => {
	it("parses warnings and filters to the target file", async () => {
		runProcessAsyncMock.mockResolvedValueOnce({ stdout: WARN, stderr: "", code: 1, timedOut: false, killed: false });
		const out = await runLizardAsync(input());
		expect(out).toHaveLength(1);
		expect(out[0]?.file).toBe("src/main.go");
	});

	it("returns [] when the binary is missing (code null, empty stdout)", async () => {
		runProcessAsyncMock.mockResolvedValueOnce({ stdout: "", stderr: "", code: null, timedOut: false, killed: false });
		expect(await runLizardAsync(input())).toEqual([]);
	});
});
