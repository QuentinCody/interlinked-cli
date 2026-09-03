// Behavioral unit tests for the Go tool runners (go build, golangci-lint).
//
// Boundaries mocked at the module edge so the tests are deterministic and
// never spawn a real `go` / `golangci-lint` binary:
//   • node:child_process `spawnSync` — both runners are synchronous.
// The real `parseGoBuildOutput`, `parseGolangciLintJson` and
// `filterResultsToFile` helpers run unmocked so we exercise the actual
// stderr/stdout → CheckResult[] mapping and the file-scope filter branch.

import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import type { CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Imported after the mock is registered.
const { runGoBuild, runGolangciLint } = await import("./go.js");

const PROJECT_ROOT = "/work/repo";
const TARGET = `${PROJECT_ROOT}/cmd/server/main.go`;

/** A `go build` stderr blob with one compile error (the parser's format). */
function goBuildOutput(file = `${PROJECT_ROOT}/cmd/server/main.go`): string {
	return `# example.com/m\n${file}:12:5: undefined: fmt.Prntln\n`;
}

/** A golangci-lint JSON payload with one issue. */
function golangciJson(filename = `${PROJECT_ROOT}/cmd/server/main.go`): string {
	return JSON.stringify({
		Issues: [
			{
				FromLinter: "errcheck",
				Text: "Error return value is not checked",
				Pos: { Filename: filename, Line: 7, Column: 2 },
			},
		],
	});
}

function fileScope(overrides: Partial<CheckScope> = {}): CheckScope {
	return {
		projectRoot: PROJECT_ROOT,
		mode: "file",
		targetFile: TARGET,
		filterToFile: true,
		...overrides,
	};
}

function input(scope: CheckScope, timeoutMs = 5_000): ToolRunnerInput {
	return { scope, timeoutMs };
}

/** Build a minimal SpawnSyncReturns. `stdout`/`stderr` are widened to
 *  `string | undefined` so we can exercise the `result.x || ""` fallbacks. */
function spawnResult(
	over: Partial<Omit<SpawnSyncReturns<string>, "stdout" | "stderr">> & {
		stdout?: string | undefined;
		stderr?: string | undefined;
	},
): SpawnSyncReturns<string> {
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

function enoent(): Error & { code: string } {
	const e = new Error("spawn go ENOENT") as Error & { code: string };
	e.code = "ENOENT";
	return e;
}

beforeEach(() => {
	spawnSyncMock.mockReset();
});

// ---------------------------------------------------------------------------
// runGoBuild
// ---------------------------------------------------------------------------

describe("runGoBuild", () => {
	it("invokes `go build` scoped to the edited package, with cwd, timeout and pipes", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runGoBuild(input(fileScope(), 8_888));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("go");
		// Scoped: findings outside TARGET are discarded by filterToFile anyway,
		// so `./...` only bought a second project-wide compile per edit.
		expect(args).toEqual(["build", "./cmd/server"]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 8_888,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		// The env is passed EXPLICITLY so all three Go invocations share one
		// GOCACHE instead of inheriting whatever launched the daemon.
		expect(opts.env).toBeDefined();
	});

	it("returns [] when the binary is absent (error.code === ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runGoBuild(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (build clean)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stderr: goBuildOutput() }));
		expect(runGoBuild(input(fileScope()))).toEqual([]);
	});

	it("parses build errors from stderr on non-zero status (file mode, matching file)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stderr: goBuildOutput() }));
		const out = runGoBuild(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "go-build",
				severity: "error",
				file: TARGET,
				line: 12,
				column: 5,
				message: "undefined: fmt.Prntln",
			},
		]);
	});

	it("merges stdout into the parsed output (stderr + stdout concat)", () => {
		// Error text delivered via stdout, stderr empty — exercises the `+ stdout` half.
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: "", stdout: goBuildOutput() }));
		const out = runGoBuild(input(fileScope()));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(TARGET);
		expect(nonNull(out[0]).line).toBe(12);
	});

	it("tolerates undefined stderr/stdout via the '' fallbacks (no findings)", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stderr: undefined, stdout: undefined }),
		);
		expect(runGoBuild(input(fileScope()))).toEqual([]);
	});

	it("filters out findings for other files in file mode", () => {
		// Build error in a different file → filterResultsToFile drops it.
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 2, stderr: goBuildOutput(`${PROJECT_ROOT}/cmd/other/x.go`) }),
		);
		expect(runGoBuild(input(fileScope()))).toEqual([]);
	});

	it("returns unfiltered findings in project mode", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 2, stderr: goBuildOutput(`${PROJECT_ROOT}/cmd/other/x.go`) }),
		);
		const out = runGoBuild(input(fileScope({ mode: "project" })));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(`${PROJECT_ROOT}/cmd/other/x.go`);
	});

	it("returns unfiltered findings when filterToFile is not set", () => {
		const scope = fileScope();
		delete (scope as { filterToFile?: boolean }).filterToFile;
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 2, stderr: goBuildOutput(`${PROJECT_ROOT}/cmd/other/x.go`) }),
		);
		const out = runGoBuild(input(scope));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(`${PROJECT_ROOT}/cmd/other/x.go`);
	});

	it("returns unfiltered findings when targetFile is missing in file mode", () => {
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stderr: goBuildOutput() }));
		const out = runGoBuild(input(scope));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(TARGET);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runGoBuild(input(fileScope()))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// runGolangciLint
// ---------------------------------------------------------------------------

describe("runGolangciLint", () => {
	it("invokes golangci-lint with json out-format scoped to the edited package", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
		runGolangciLint(input(fileScope(), 7_777));
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(cmd).toBe("golangci-lint");
		expect(args).toEqual(["run", "--out-format=json", "./cmd/server"]);
		expect(opts).toMatchObject({
			cwd: PROJECT_ROOT,
			timeout: 7_777,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("returns [] when the binary is absent (error.code === ENOENT)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: null, error: enoent() }));
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 0 (clean)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: golangciJson() }));
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 3 (analysis failure — skipped silently)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 3, stdout: golangciJson() }));
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 4 (timeout — skipped silently)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 4, stdout: golangciJson() }));
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 1 but stdout is empty after trim", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: "   \n  " }));
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});

	it("returns [] when status === 1 and stdout is undefined (|| '' fallback)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: undefined }));
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});

	it("parses issues on status === 1 (file mode, matching file)", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: golangciJson() }));
		const out = runGolangciLint(input(fileScope()));
		expect(out).toEqual([
			{
				tool: "golangci-lint",
				severity: "warning",
				file: TARGET,
				line: 7,
				column: 2,
				message: "errcheck: Error return value is not checked",
				ruleId: "errcheck",
			},
		]);
	});

	it("filters out issues for other files in file mode", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: golangciJson(`${PROJECT_ROOT}/cmd/other/x.go`) }),
		);
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});

	it("returns unfiltered issues in project mode", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: golangciJson(`${PROJECT_ROOT}/cmd/other/x.go`) }),
		);
		const out = runGolangciLint(input(fileScope({ mode: "project" })));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(`${PROJECT_ROOT}/cmd/other/x.go`);
	});

	it("returns unfiltered issues when filterToFile is not set", () => {
		const scope = fileScope();
		delete (scope as { filterToFile?: boolean }).filterToFile;
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 1, stdout: golangciJson(`${PROJECT_ROOT}/cmd/other/x.go`) }),
		);
		const out = runGolangciLint(input(scope));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(`${PROJECT_ROOT}/cmd/other/x.go`);
	});

	it("returns unfiltered issues when targetFile is missing in file mode", () => {
		const scope = fileScope();
		delete (scope as { targetFile?: string }).targetFile;
		spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stdout: golangciJson() }));
		const out = runGolangciLint(input(scope));
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).file).toBe(TARGET);
	});

	it("returns [] from the catch block when spawnSync throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(runGolangciLint(input(fileScope()))).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Per-edit compile cost: package scope, build-tag parity, environment parity
// ---------------------------------------------------------------------------
// The defect: every `.go` edit ran `go build ./...` AND `golangci-lint run
// ./...` (plus `go test` on the package) — three project-wide compiles with
// three different loader configurations, so each populated its own build-cache
// key set and re-did what the others had just done.

/** argv of the single recorded spawnSync call. */
function recordedArgs(): string[] {
	const call = spawnSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>];
	return call[1];
}

/** spawnSync options of the single recorded call. */
function recordedOpts(): Record<string, unknown> {
	const call = spawnSyncMock.mock.calls[0] as [string, string[], Record<string, unknown>];
	return call[2];
}

describe("Go package scoping — positive (must fire)", () => {
	beforeEach(() => spawnSyncMock.mockReturnValue(spawnResult({ status: 0 })));

	it("P1: go build narrows to the edited package in filtered file mode", () => {
		runGoBuild(input(fileScope()));
		expect(recordedArgs()).toContain("./cmd/server");
		expect(recordedArgs()).not.toContain("./...");
	});

	it("P2: golangci-lint narrows to the edited package in filtered file mode", () => {
		runGolangciLint(input(fileScope()));
		expect(recordedArgs()).toContain("./cmd/server");
		expect(recordedArgs()).not.toContain("./...");
	});
});

describe("Go package scoping — negative (must not fire)", () => {
	beforeEach(() => spawnSyncMock.mockReturnValue(spawnResult({ status: 0 })));

	it("N1: project mode still compiles the whole module (go build)", () => {
		runGoBuild(input(fileScope({ mode: "project" })));
		expect(recordedArgs()).toEqual(["build", "./..."]);
	});

	it("N2: project mode still lints the whole module (golangci-lint)", () => {
		runGolangciLint(input(fileScope({ mode: "project" })));
		expect(recordedArgs()).toEqual(["run", "--out-format=json", "./..."]);
	});

	it("N3: file mode WITHOUT filterToFile keeps the whole module — narrowing there would drop findings", () => {
		runGoBuild(input(fileScope({ filterToFile: false })));
		expect(recordedArgs()).toEqual(["build", "./..."]);
	});
});

describe("Go build-tag + environment parity", () => {
	const savedFlags = process.env.INTERLINKED_GOFLAGS;
	const savedCache = process.env.INTERLINKED_GOCACHE;

	beforeEach(() => spawnSyncMock.mockReturnValue(spawnResult({ status: 0 })));

	afterEach(() => {
		if (savedFlags === undefined) delete process.env.INTERLINKED_GOFLAGS;
		else process.env.INTERLINKED_GOFLAGS = savedFlags;
		if (savedCache === undefined) delete process.env.INTERLINKED_GOCACHE;
		else process.env.INTERLINKED_GOCACHE = savedCache;
	});

	it("P1: threads -tags into go build", () => {
		process.env.INTERLINKED_GOFLAGS = "-tags=integration";
		runGoBuild(input(fileScope()));
		expect(recordedArgs()).toEqual(["build", "-tags=integration", "./cmd/server"]);
	});

	it("P2: threads --build-tags into golangci-lint (it ignores GOFLAGS -tags)", () => {
		process.env.INTERLINKED_GOFLAGS = "-tags=integration";
		runGolangciLint(input(fileScope()));
		expect(recordedArgs()).toEqual([
			"run",
			"--out-format=json",
			"--build-tags=integration",
			"./cmd/server",
		]);
	});

	it("P3: passes the overridden GOCACHE explicitly to go build", () => {
		process.env.INTERLINKED_GOCACHE = "/shell/gocache";
		runGoBuild(input(fileScope()));
		const env = recordedOpts().env as NodeJS.ProcessEnv;
		expect(env.GOCACHE).toBe("/shell/gocache");
	});

	it("N1: adds no tag argv when no build tags are configured", () => {
		delete process.env.INTERLINKED_GOFLAGS;
		runGoBuild(input(fileScope()));
		expect(recordedArgs()).toEqual(["build", "./cmd/server"]);
	});

	it("N2: does not invent a GOCACHE when none is configured", () => {
		delete process.env.INTERLINKED_GOCACHE;
		runGolangciLint(input(fileScope()));
		const env = recordedOpts().env as NodeJS.ProcessEnv;
		expect(env.GOCACHE).toBe(process.env.GOCACHE);
	});
});
