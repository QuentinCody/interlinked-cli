import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetCoverageFinalCache } from "./coverage-final-reader.js";
import {
	COVERAGE_FINAL_FILENAME,
	COVERAGE_PY_JSON_FILENAME,
	type CoverageRunOpts,
	coverageLanguageForPath,
	coverageRunnerFor,
	defaultJsTestCommand,
	defaultPythonTestCommand,
	JsCoverageRunner,
	PythonCoverageRunner,
	type SpawnFn,
	type SpawnOutcome,
} from "./coverage-runner.js";

// ==================================================================
// Helpers — stub spawn + a minimal istanbul coverage-final.json fixture
// ==================================================================

/** A successful spawn outcome (no error, exit 0). */
function okSpawnResult(): SpawnOutcome {
	return { stdout: "", stderr: "", status: 0 };
}

/** A spawn outcome with a given exit status and optional captured output. */
function spawnResultWith(
	status: number | null,
	streams: { stdout?: string; stderr?: string } = {},
): SpawnOutcome {
	return { stdout: streams.stdout ?? "", stderr: streams.stderr ?? "", status };
}

/**
 * Build a stub spawn that (a) optionally sleeps `delayMs` to make `suiteMs`
 * measurable, (b) optionally writes a `coverage-final.json` into `coverageDir`,
 * and (c) returns `extra` overrides (e.g. an `error` to simulate ENOENT).
 */
function makeStubSpawn(cfg: {
	coverageDir?: string;
	writeReport?: boolean;
	delayMs?: number;
	extra?: Partial<SpawnOutcome>;
}): { spawn: SpawnFn; calls: Array<{ command: string; args: string[] }> } {
	const calls: Array<{ command: string; args: string[] }> = [];
	const spawn: SpawnFn = async (command, args) => {
		calls.push({ command, args });
		if (cfg.delayMs && cfg.delayMs > 0) {
			// A real async sleep — the spawn seam is async now, so the stub can
			// yield the event loop exactly like the production spawn does.
			await new Promise((resolve) => setTimeout(resolve, cfg.delayMs));
		}
		if (cfg.writeReport && cfg.coverageDir) {
			writeFileSync(join(cfg.coverageDir, COVERAGE_FINAL_FILENAME), istanbulFixture(), "utf-8");
		}
		return { ...okSpawnResult(), ...cfg.extra };
	};
	return { spawn, calls };
}

/** Minimal istanbul `coverage-final.json` with one covered + one uncovered fn. */
function istanbulFixture(): string {
	// The reader keys by repo-relative path; use a path under the temp root that
	// each test sets at parse time via opts.projectRoot.
	const fixture = {
		__ABS__: {
			path: "__ABS__",
			fnMap: {
				"0": { name: "covered", decl: { start: { line: 1 }, end: { line: 3 } } },
				"1": { name: "uncovered", decl: { start: { line: 10 }, end: { line: 12 } } },
			},
			f: { "0": 5, "1": 0 },
			statementMap: {
				"0": { start: { line: 1, column: 0 }, end: { line: 1, column: 9 } },
				"1": { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
				"2": { start: { line: 10, column: 0 }, end: { line: 10, column: 9 } },
			},
			s: { "0": 5, "1": 5, "2": 0 },
		},
	};
	return JSON.stringify(fixture);
}

// ==================================================================
// Setup
// ==================================================================

let root: string;
let coverageDir: string;
let absSrc: string;

beforeEach(() => {
	__resetCoverageFinalCache();
	root = mkdtempSync(join(tmpdir(), "cov-runner-"));
	coverageDir = join(root, "coverage");
	mkdirSync(coverageDir, { recursive: true });
	absSrc = join(root, "src/foo.ts");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Rewrite the fixture's `__ABS__` placeholder to this test's absolute src path. */
function writeReportFor(absPath: string): void {
	const json = istanbulFixture().replace(/__ABS__/g, absPath.replace(/\\/g, "\\\\"));
	writeFileSync(join(coverageDir, COVERAGE_FINAL_FILENAME), json, "utf-8");
}

/**
 * A coverage.py `coverage.json` for one project-relative file, with the given
 * executed + missing line lists. The real shape coverage.py emits (per-line,
 * no function ranges); keys are project-relative, as coverage.py writes them.
 */
function coveragePyFixture(relPath: string, executed: number[], missing: number[]): string {
	return JSON.stringify({
		meta: { version: "7.0.0", format: 3 },
		files: {
			[relPath]: {
				executed_lines: executed,
				missing_lines: missing,
				summary: {
					covered_lines: executed.length,
					num_statements: executed.length + missing.length,
					missing_lines: missing.length,
				},
			},
		},
		totals: {},
	});
}

/** Write a coverage.py report into `coverageDir` for `relPath`. */
function writePyReportFor(relPath: string, executed: number[], missing: number[]): void {
	writeFileSync(
		join(coverageDir, COVERAGE_PY_JSON_FILENAME),
		coveragePyFixture(relPath, executed, missing),
		"utf-8",
	);
}

function baseOpts(): CoverageRunOpts {
	return { projectRoot: root, coverageDir };
}

// ==================================================================
// JsCoverageRunner — parses coverage-final.json into PerFileCoverage
// ==================================================================

describe("JsCoverageRunner", () => {
	it("parses a sample coverage-final.json into per-file PerFileCoverage", async () => {
		// Stub spawn writes the report (with the right abs path) when invoked.
		const spawn: SpawnFn = async () => {
			writeReportFor(absSrc);
			return okSpawnResult();
		};
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		expect(res.error).toBeUndefined();
		const entry = res.perFile.get("src/foo.ts");
		expect(entry).toBeDefined();
		expect(entry?.functions.map((f) => f.name).sort()).toEqual(["covered", "uncovered"]);
		const covered = entry?.functions.find((f) => f.name === "covered");
		const uncovered = entry?.functions.find((f) => f.name === "uncovered");
		expect(covered?.hits).toBe(5);
		expect(uncovered?.hits).toBe(0);
	});

	it("measures suiteMs as wall-clock (> 0 with an injected delay)", async () => {
		const { spawn } = makeStubSpawn({ coverageDir, writeReport: false, delayMs: 20 });
		// Write a valid report so the run succeeds; the delay is in the spawn.
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		const runner = new JsCoverageRunner(wrappingSpawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		expect(res.suiteMs).toBeGreaterThan(0);
	});

	it("returns ok:false + error when the spawn fails (ENOENT)", async () => {
		const { spawn } = makeStubSpawn({
			extra: {
				error: Object.assign(new Error("spawn vitest ENOENT"), { code: "ENOENT" }),
			},
		});
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not found|did not run/i);
		expect(res.perFile.size).toBe(0);
	});

	it("returns ok:false + error when the report is missing", async () => {
		// Spawn "succeeds" but writes nothing → no coverage-final.json.
		const { spawn } = makeStubSpawn({ writeReport: false });
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/no parseable coverage/i);
		expect(res.perFile.size).toBe(0);
	});

	it("returns ok:false + error when the spawn rejects", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("boom");
		};
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/spawn threw: boom/);
	});

	it("stringifies a non-Error spawn rejection", async () => {
		const spawn: SpawnFn = async () => {
			// Exercising the non-Error branch of the reason mapping.
			throw "boom-string";
		};
		const runner = new JsCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toBe("spawn threw: boom-string");
	});

	it("returns 'empty test command' when testCommand is []", async () => {
		const runner = new JsCoverageRunner(async () => okSpawnResult());
		const res = await runner.run({ ...baseOpts(), testCommand: [] });

		expect(res.ok).toBe(false);
		expect(res.error).toBe("empty test command");
		expect(res.perFile.size).toBe(0);
	});

	it("uses the default vitest command when none is supplied", async () => {
		const { spawn, calls } = makeStubSpawn({ coverageDir, writeReport: false });
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		const runner = new JsCoverageRunner(wrappingSpawn);
		await runner.run(baseOpts());

		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("vitest");
		expect(calls[0]?.args).toEqual(defaultJsTestCommand(coverageDir).slice(1));
		expect(calls[0]?.args.join(" ")).toContain(`--coverage.reportsDirectory=${coverageDir}`);
	});

	it("honors an explicit testCommand override", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		const runner = new JsCoverageRunner(wrappingSpawn);
		await runner.run({ ...baseOpts(), testCommand: ["my-runner", "--cov"] });

		expect(calls[0]?.command).toBe("my-runner");
		expect(calls[0]?.args).toEqual(["--cov"]);
	});
});

// ==================================================================
// JsCoverageRunner — testsPassed surfacing (exit-code → pass/fail/null)
// ==================================================================

describe("JsCoverageRunner — testsPassed (red/green via exit code)", () => {
	/** Run with a stub that emits a coverage report AND a chosen spawn outcome. */
	async function runWithStatus(stub: SpawnOutcome) {
		const spawn: SpawnFn = async () => {
			writeReportFor(absSrc);
			return stub;
		};
		return new JsCoverageRunner(spawn).run(baseOpts());
	}

	it("exit 0 → testsPassed:true (ok report, green suite), no failingTests", async () => {
		const res = await runWithStatus(spawnResultWith(0));
		expect(res.ok).toBe(true);
		expect(res.testsPassed).toBe(true);
		expect(res.failingTests).toBeUndefined();
	});

	it("exit 1 → testsPassed:false even though the coverage report parsed (ok:true)", async () => {
		const res = await runWithStatus(spawnResultWith(1));
		expect(res.ok).toBe(true);
		expect(res.testsPassed).toBe(false);
	});

	it("exit >1 (runner error) → testsPassed:null (can't determine ⇒ fail-open)", async () => {
		const res = await runWithStatus(spawnResultWith(2));
		expect(res.ok).toBe(true);
		expect(res.testsPassed).toBeNull();
	});

	it("ENOENT (runner unavailable) → ok:false AND testsPassed:null", async () => {
		const { spawn } = makeStubSpawn({
			extra: { error: Object.assign(new Error("spawn vitest ENOENT"), { code: "ENOENT" }) },
		});
		const res = await new JsCoverageRunner(spawn).run(baseOpts());
		expect(res.ok).toBe(false);
		expect(res.testsPassed).toBeNull();
	});

	it("parses failing test names from vitest FAIL lines on a red run", async () => {
		const stdout = [
			" FAIL  src/a.test.ts > module > does the thing",
			" FAIL  src/b.test.ts > other > second case",
			"some unrelated line",
		].join("\n");
		const res = await runWithStatus(spawnResultWith(1, { stdout }));
		expect(res.testsPassed).toBe(false);
		expect(res.failingTests).toEqual(["does the thing", "second case"]);
	});

	it("never attaches failingTests on a green run, even if output has FAIL-like text", async () => {
		const res = await runWithStatus(spawnResultWith(0, { stdout: "FAIL  noise > nope" }));
		expect(res.testsPassed).toBe(true);
		expect(res.failingTests).toBeUndefined();
	});
});

// ==================================================================
// defaultSpawn (real processes) — the async production spawn's contract
// ==================================================================

describe("defaultSpawn (real process) — async spawn contract", () => {
	it(
		"kills a run exceeding timeoutMs and reports a timeout error (never hangs)",
		async () => {
			const runner = new JsCoverageRunner(); // real defaultSpawn
			const res = await runner.run({
				...baseOpts(),
				testCommand: ["node", "-e", "setTimeout(() => {}, 60000)"],
				timeoutMs: 300,
			});
			expect(res.ok).toBe(false);
			expect(res.testsPassed).toBeNull();
			expect(res.error).toMatch(/timed out/i);
		},
		15_000,
	);

	it(
		"resolves (never rejects) with a not-found error for a missing binary",
		async () => {
			const runner = new JsCoverageRunner(); // real defaultSpawn
			const res = await runner.run({
				...baseOpts(),
				testCommand: ["interlinked-definitely-missing-bin-xyz"],
				timeoutMs: 5_000,
			});
			expect(res.ok).toBe(false);
			expect(res.testsPassed).toBeNull();
			expect(res.error).toMatch(/not found/i);
		},
		15_000,
	);

	it(
		"captures stdout from a real child for failing-test parsing",
		async () => {
			const runner = new JsCoverageRunner(); // real defaultSpawn
			// Exit 1 (vitest's "tests failed" code) after printing a FAIL line, and
			// emit a parseable report so ok:true + testsPassed:false + names.
			writeReportFor(absSrc);
			const script =
				"console.log(' FAIL  src/x.test.ts > suite > real child case'); process.exit(1)";
			const res = await runner.run({
				...baseOpts(),
				testCommand: ["node", "-e", script],
				timeoutMs: 10_000,
			});
			expect(res.ok).toBe(true);
			expect(res.testsPassed).toBe(false);
			expect(res.failingTests).toEqual(["real child case"]);
		},
		15_000,
	);

	it(
		"captures stderr output for failing-test parsing (real defaultSpawn stderr handler)",
		async () => {
			writeReportFor(absSrc);
			const runner = new JsCoverageRunner(); // real defaultSpawn
			const script =
				"console.error(' FAIL  src/y.test.ts > suite > stderr case'); process.exit(1)";
			const res = await runner.run({
				...baseOpts(),
				testCommand: ["node", "-e", script],
				timeoutMs: 5_000,
			});
			expect(res.ok).toBe(true);
			expect(res.testsPassed).toBe(false);
			expect(res.failingTests).toEqual(["stderr case"]);
		},
		15_000,
	);

	it(
		"merges perEditBudgetEnv into the real child's env for a scoped run",
		async () => {
			const envFile = join(coverageDir, "env-out.txt");
			writeReportFor(absSrc);
			const runner = new JsCoverageRunner(); // real defaultSpawn
			const script = `require("node:fs").writeFileSync(${JSON.stringify(
				envFile,
			)}, process.env.INTERLINKED_PROPERTY_NUMRUNS || "unset")`;
			const res = await runner.run({
				...baseOpts(),
				testCommand: ["node", "-e", script],
				selectedTests: ["src/x.test.ts"],
				timeoutMs: 5_000,
			});
			expect(res.ok).toBe(true);
			expect(readFileSync(envFile, "utf-8")).toBe("25");
		},
		15_000,
	);

	it(
		"SIGKILLs a child that ignores SIGTERM after the grace period",
		async () => {
			const runner = new JsCoverageRunner(); // real defaultSpawn
			// Ignore SIGTERM so the outer kill timer's grace-period SIGKILL fires.
			const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
			const res = await runner.run({
				...baseOpts(),
				testCommand: ["node", "-e", script],
				timeoutMs: 200,
			});
			expect(res.ok).toBe(false);
			expect(res.testsPassed).toBeNull();
			expect(res.error).toMatch(/timed out/i);
		},
		12_000,
	);
});

// ==================================================================
// PythonCoverageRunner — parses coverage.py coverage.json into PerFileCoverage
// ==================================================================

describe("PythonCoverageRunner", () => {
	it("parses executed_lines + missing_lines into per-line PerFileCoverage", async () => {
		// Stub spawn writes a coverage.py report (covered lines 1,2; missing line 3).
		const spawn: SpawnFn = async () => {
			writePyReportFor("src/foo.py", [1, 2], [3]);
			return okSpawnResult();
		};
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		expect(res.error).toBeUndefined();
		const entry = res.perFile.get("src/foo.py");
		expect(entry).toBeDefined();
		// coverage.py has no function ranges → empty functions list.
		expect(entry?.functions).toEqual([]);
		expect([...(entry?.coveredLines ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
		expect([...(entry?.uncoveredLines ?? [])]).toEqual([3]);
	});

	it("a fully-covered file has zero uncovered lines (block would allow)", async () => {
		const spawn: SpawnFn = async () => {
			writePyReportFor("src/foo.py", [1, 2, 3], []);
			return okSpawnResult();
		};
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		const entry = res.perFile.get("src/foo.py");
		expect(entry?.uncoveredLines?.size).toBe(0);
		expect([...(entry?.coveredLines ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
	});

	it("flags a file's missing_lines as uncovered (block would block that line)", async () => {
		// Line 7 is executable but never executed — the per-edit gate keys on this.
		const spawn: SpawnFn = async () => {
			writePyReportFor("src/foo.py", [5, 6], [7]);
			return okSpawnResult();
		};
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		const entry = res.perFile.get("src/foo.py");
		expect(entry?.uncoveredLines?.has(7)).toBe(true);
		expect(entry?.coveredLines?.has(7)).toBe(false);
	});

	it("measures suiteMs as wall-clock (> 0 with an injected delay)", async () => {
		const { spawn } = makeStubSpawn({ delayMs: 20 });
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writePyReportFor("src/foo.py", [1], []);
			return r;
		};
		const runner = new PythonCoverageRunner(wrappingSpawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(true);
		expect(res.suiteMs).toBeGreaterThan(0);
	});

	it("returns ok:false + error when the spawn fails (ENOENT)", async () => {
		const { spawn } = makeStubSpawn({
			extra: { error: Object.assign(new Error("spawn pytest ENOENT"), { code: "ENOENT" }) },
		});
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/not found|did not run/i);
		expect(res.perFile.size).toBe(0);
	});

	it("returns ok:false + error when the report is missing", async () => {
		// Spawn "succeeds" but writes nothing → no coverage.json.
		const { spawn } = makeStubSpawn({ writeReport: false });
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/no parseable coverage/i);
		expect(res.perFile.size).toBe(0);
	});

	it("returns ok:false when the report is present but unparseable JSON", async () => {
		const spawn: SpawnFn = async () => {
			writeFileSync(join(coverageDir, COVERAGE_PY_JSON_FILENAME), "{ not json", "utf-8");
			return okSpawnResult();
		};
		const runner = new PythonCoverageRunner(spawn);
		const res = await runner.run(baseOpts());

		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/no parseable coverage/i);
	});

	it("uses the default pytest --cov-report=json command pointed at coverageDir", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writePyReportFor("src/foo.py", [1], []);
			return r;
		};
		const runner = new PythonCoverageRunner(wrappingSpawn);
		await runner.run(baseOpts());

		expect(calls[0]?.command).toBe("pytest");
		expect(calls[0]?.args).toEqual(defaultPythonTestCommand(coverageDir).slice(1));
		expect(calls[0]?.args.join(" ")).toContain(
			`--cov-report=json:${join(coverageDir, COVERAGE_PY_JSON_FILENAME)}`,
		);
	});
});

// ==================================================================
// PythonCoverageRunner — testsPassed surfacing (exit-code → pass/fail/null)
// ==================================================================

describe("PythonCoverageRunner — testsPassed (red/green via exit code)", () => {
	/** Run with a stub that emits a coverage.py report AND a chosen spawn outcome. */
	async function runWithStatus(stub: SpawnOutcome) {
		const spawn: SpawnFn = async () => {
			writePyReportFor("src/foo.py", [1, 2], [3]);
			return stub;
		};
		return new PythonCoverageRunner(spawn).run(baseOpts());
	}

	it("exit 0 → testsPassed:true (green suite)", async () => {
		const res = await runWithStatus(spawnResultWith(0));
		expect(res.ok).toBe(true);
		expect(res.testsPassed).toBe(true);
	});

	it("exit 1 → testsPassed:false (pytest test failures) with a parseable report", async () => {
		const res = await runWithStatus(spawnResultWith(1));
		expect(res.ok).toBe(true);
		expect(res.testsPassed).toBe(false);
	});

	it("exit 5 (no tests collected) → testsPassed:null (runner-level, not a red bar)", async () => {
		const res = await runWithStatus(spawnResultWith(5));
		expect(res.ok).toBe(true);
		expect(res.testsPassed).toBeNull();
	});

	it("ENOENT (pytest unavailable) → ok:false AND testsPassed:null", async () => {
		const { spawn } = makeStubSpawn({
			extra: { error: Object.assign(new Error("spawn pytest ENOENT"), { code: "ENOENT" }) },
		});
		const res = await new PythonCoverageRunner(spawn).run(baseOpts());
		expect(res.ok).toBe(false);
		expect(res.testsPassed).toBeNull();
	});

	it("parses failing test ids from pytest FAILED summary lines on a red run", async () => {
		const stdout = [
			"FAILED tests/test_a.py::test_one - AssertionError",
			"FAILED tests/test_b.py::TestX::test_two",
			"passed garbage",
		].join("\n");
		const res = await runWithStatus(spawnResultWith(1, { stdout }));
		expect(res.testsPassed).toBe(false);
		expect(res.failingTests).toEqual([
			"tests/test_a.py::test_one",
			"tests/test_b.py::TestX::test_two",
		]);
	});

	it("parses pytest default-verbosity '<nodeid> FAILED' lines too", async () => {
		const stdout = "tests/test_a.py::test_one FAILED                 [ 50%]\n";
		const res = await runWithStatus(spawnResultWith(1, { stdout }));
		expect(res.failingTests).toEqual(["tests/test_a.py::test_one"]);
	});
});

// ==================================================================
// selectedTests — scoped per-edit run (only the affected tests)
// ==================================================================

describe("CoverageRunner — selectedTests scoping", () => {
	it("JS: a non-empty selectedTests scopes vitest to exactly those paths", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		const runner = new JsCoverageRunner(wrappingSpawn);
		await runner.run({ ...baseOpts(), selectedTests: ["src/a.test.ts", "src/b.test.ts"] });

		expect(calls[0]?.command).toBe("vitest");
		// `run <paths…> --coverage …` — the affected tests sit right after `run`.
		expect(calls[0]?.args.slice(0, 3)).toEqual(["run", "src/a.test.ts", "src/b.test.ts"]);
		expect(calls[0]?.args).toContain("--coverage");
		expect(calls[0]?.args.join(" ")).toContain(`--coverage.reportsDirectory=${coverageDir}`);
	});

	it("JS: omitting selectedTests runs the full suite (no path args — unchanged)", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		await new JsCoverageRunner(wrappingSpawn).run(baseOpts());
		expect(calls[0]?.args).toEqual(defaultJsTestCommand(coverageDir).slice(1));
	});

	it("JS: an empty selectedTests array also runs the full suite", () => {
		// The command builder treats [] the same as omitted (full suite).
		expect(defaultJsTestCommand(coverageDir, [])).toEqual(defaultJsTestCommand(coverageDir));
	});

	it("Python: a non-empty selectedTests scopes pytest to exactly those paths", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writePyReportFor("src/foo.py", [1], []);
			return r;
		};
		const runner = new PythonCoverageRunner(wrappingSpawn);
		await runner.run({ ...baseOpts(), selectedTests: ["tests/test_a.py"] });

		expect(calls[0]?.command).toBe("pytest");
		// `pytest <paths…> --cov …` — paths immediately follow the verb.
		expect(calls[0]?.args.slice(0, 2)).toEqual(["tests/test_a.py", "--cov"]);
		expect(calls[0]?.args.join(" ")).toContain(
			`--cov-report=json:${join(coverageDir, COVERAGE_PY_JSON_FILENAME)}`,
		);
	});

	it("an explicit testCommand wins over selectedTests (caller owns the argv)", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const wrappingSpawn: SpawnFn = async (cmd, args, optsArg) => {
			const r = await spawn(cmd, args, optsArg);
			writeReportFor(absSrc);
			return r;
		};
		await new JsCoverageRunner(wrappingSpawn).run({
			...baseOpts(),
			testCommand: ["custom", "--flag"],
			selectedTests: ["src/a.test.ts"],
		});
		expect(calls[0]?.command).toBe("custom");
		expect(calls[0]?.args).toEqual(["--flag"]);
	});
});

// ==================================================================
// Factory
// ==================================================================

describe("coverageRunnerFor", () => {
	it("returns a JsCoverageRunner for js and ts", () => {
		expect(coverageRunnerFor("js")).toBeInstanceOf(JsCoverageRunner);
		expect(coverageRunnerFor("ts")).toBeInstanceOf(JsCoverageRunner);
	});

	it("returns a PythonCoverageRunner for python", () => {
		expect(coverageRunnerFor("python")).toBeInstanceOf(PythonCoverageRunner);
	});

	it("forwards an injected spawn into the runner", async () => {
		const { spawn, calls } = makeStubSpawn({});
		const runner = coverageRunnerFor("python", spawn);
		expect(runner).not.toBeNull();
		await runner?.run(baseOpts());
		expect(calls).toHaveLength(1);
	});

	it("returns null for an unsupported language (default branch)", () => {
		expect(coverageRunnerFor("go")).toBeNull();
	});
});

describe("coverageLanguageForPath — the ONE extension→language table", () => {
	it("maps the executable source extensions", () => {
		expect(coverageLanguageForPath("src/a.ts")).toBe("ts");
		expect(coverageLanguageForPath("src/a.tsx")).toBe("ts");
		expect(coverageLanguageForPath("src/a.mjs")).toBe("js");
		expect(coverageLanguageForPath("pkg/mod.py")).toBe("python");
	});

	it("EXEMPTS .pyi stubs — coverage.py never executes or reports them (finding 2026-06)", () => {
		// A type-stub edit must not enter the default-on coverage gates: a stub
		// like `class Api: ...` has no runtime behavior a suite could measure, so
		// gating it blocked every ordinary stub change as "missing coverage".
		expect(coverageLanguageForPath("pkg/mod.pyi")).toBeNull();
	});

	it("returns null for non-code and unsupported extensions", () => {
		expect(coverageLanguageForPath("README.md")).toBeNull();
		expect(coverageLanguageForPath("Makefile")).toBeNull();
		expect(coverageLanguageForPath("src/lib.rs")).toBeNull();
	});
});

describe("perEditBudgetEnv (P0.1 property budget)", () => {
	const base: CoverageRunOpts = { projectRoot: "/repo", coverageDir: "/repo/.cov" };

	it("caps fast-check numRuns for a scoped (per-edit) run", async () => {
		const { perEditBudgetEnv } = await import("./coverage-runner.js");
		expect(perEditBudgetEnv({ ...base, selectedTests: ["a.test.ts"] })).toEqual({
			INTERLINKED_PROPERTY_NUMRUNS: "25",
		});
	});

	it("returns undefined for a full (unscoped) run — keeps default numRuns", async () => {
		const { perEditBudgetEnv } = await import("./coverage-runner.js");
		expect(perEditBudgetEnv(base)).toBeUndefined();
		expect(perEditBudgetEnv({ ...base, selectedTests: [] })).toBeUndefined();
	});
});
