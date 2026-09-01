// ===========================================
// adopt-steps — unit tests for the individual bootstrap steps
// ===========================================
// The end-to-end flow (walk → all five steps → summary) is covered by
// adopt.test.ts; these tests pin each step's direction rules and
// only-if-absent semantics in isolation, with hand-built scan inputs.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoverageRunner, CoverageRunResult } from "../harness/coverage-runner.js";
import { DEFAULT_MAX_LINES, resetLargeFileBaselineCache } from "../harness/large-file-policy.js";
import {
	DEFAULT_MAX_FUNCTION_TOKENS,
	METRIC_DEFS,
	resetMetricCapsCache,
} from "../harness/metric-caps.js";
import { readSuiteBaseline } from "../harness/suite-baseline.js";
import {
	DEFAULT_MIN_COVERAGE_PCT,
	resetUntestedFilesBaselineCache,
} from "../harness/tested-file-policy.js";
import {
	buildIndexStep,
	coverageStep,
	largeFilesStep,
	loadCoverageReport,
	metricCapsStep,
	type RepoScan,
	suiteBaselineStep,
	untestedFilesStep,
} from "./adopt-steps.js";

/** Write a fixture file under the tmp repo, creating parent dirs. */
function put(rel: string, content: string): void {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content, "utf-8");
}

let cwd: string;

/** A RepoScan with the given offenders and default thresholds. */
function scanWith(overrides: Partial<RepoScan> = {}): RepoScan {
	return {
		maxLines: DEFAULT_MAX_LINES,
		minCoveragePct: DEFAULT_MIN_COVERAGE_PCT,
		overCap: new Map(),
		untested: [],
		...overrides,
	};
}

function readJson(rel: string): Record<string, unknown> {
	// SAFETY: test-owned fixture files written by the steps under test; the
	// asserted keys are validated by the expects below.
	return JSON.parse(readFileSync(join(cwd, rel), "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "interlinked-adopt-steps-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	resetLargeFileBaselineCache();
	resetUntestedFilesBaselineCache();
	resetMetricCapsCache();
});

describe("buildIndexStep", () => {
	it("dry-run reports the exact would-write result without touching the index", () => {
		const result = buildIndexStep(cwd, true);
		expect(result).toEqual({
			step: "index",
			label: "Trigram index",
			action: "would-write",
			detail: "would build .interlinked/index/ from the working tree",
		});
		expect(existsSync(join(cwd, ".interlinked/index"))).toBe(false);
	});

	it("builds against the given cwd and reports the exact indexed count", () => {
		put("src/a.ts", "export const a = 1;\n");
		const result = buildIndexStep(cwd, false);
		expect(result.step).toBe("index");
		expect(result.label).toBe("Trigram index");
		expect(result.action).toBe("written");
		expect(result.detail).toBe("1 files indexed");
	});
});

describe("largeFilesStep", () => {
	it("grandfathers each over-cap file at its current line count", () => {
		const scan = scanWith({ overCap: new Map([["src/a.ts", 700]]) });
		const result = largeFilesStep(cwd, scan, false);
		expect(result.action).toBe("written");
		expect(result.label).toBe("Large-files grandfather list");
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 700 });
		expect(baseline.max_lines).toBe(DEFAULT_MAX_LINES);
	});

	it("exact detail text with no kept-tighter / refused notes when there are none", () => {
		const result = largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 700]]) }), false);
		expect(result.kept_tighter).toBe(0);
		expect(result.detail).toBe(
			`1 file(s) over ${DEFAULT_MAX_LINES} lines grandfathered`,
		);
	});

	it("keeps the tighter recorded count when the file grew (never loosens)", () => {
		largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 600]]) }), false);
		const result = largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 650]]) }), false);
		expect(result.kept_tighter).toBe(1);
		expect(result.detail).toBe(
			`1 file(s) over ${DEFAULT_MAX_LINES} lines grandfathered; 1 kept at their tighter recorded count`,
		);
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 600 });
	});

	it("keeps the recorded count exactly at the boundary (recorded === current, not just <)", () => {
		largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 600]]) }), false);
		// Re-run with the SAME line count: recorded === lines, so the file must
		// take the `else` branch (files[rel] = lines) and NOT count as kept-tighter.
		const result = largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 600]]) }), false);
		expect(result.kept_tighter).toBe(0);
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 600 });
	});

	it("refreshes downward and drops entries no longer over cap", () => {
		largeFilesStep(
			cwd,
			scanWith({
				overCap: new Map([
					["src/a.ts", 700],
					["src/b.ts", 800],
				]),
			}),
			false,
		);
		largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 620]]) }), false);
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 620 });
	});

	it("does NOT grow the grandfather set on a re-run: a newly-over-cap file is refused", () => {
		// First adoption grandfathers the current over-cap file.
		largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 700]]) }), false);
		// b.ts went over cap AFTER the first adoption — grandfathering it would
		// pre-authorize a new over-cap file (the loosening the baseline-integrity
		// gate blocks on the agent path). A re-run REFUSES it instead of growing.
		const result = largeFilesStep(
			cwd,
			scanWith({
				overCap: new Map([
					["src/a.ts", 700],
					["src/b.ts", 900],
				]),
			}),
			false,
		);
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 700 }); // b.ts NOT grandfathered
		expect(result.detail).toBe(
			`1 file(s) over ${DEFAULT_MAX_LINES} lines grandfathered; 1 new over-cap file(s) REFUSED (a re-run cannot grow the grandfather set — decompose them)`,
		);
	});

	it("writes nothing under dry-run", () => {
		const result = largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 700]]) }), true);
		expect(result.action).toBe("would-write");
		expect(existsSync(join(cwd, ".interlinked/large-files-baseline.json"))).toBe(false);
	});
});

describe("untestedFilesStep", () => {
	it("exempts the scanned untested files, sorted", () => {
		const result = untestedFilesStep(cwd, scanWith({ untested: ["src/z.ts", "src/a.ts"] }), false);
		expect(result).toEqual({
			step: "untested_files",
			label: "Untested-files exemption list",
			action: "written",
			detail: "2 untested file(s) exempted (2 new, 0 dropped)",
		});
		const baseline = readJson(".interlinked/untested-files-baseline.json");
		expect(baseline.files).toEqual(["src/a.ts", "src/z.ts"]);
		expect(baseline.min_coverage_pct).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});

	it("does NOT grow the exemption list on a re-run: keeps still-untested exemptions, refuses new offenders", () => {
		// First adoption bootstraps the current offenders.
		untestedFilesStep(cwd, scanWith({ untested: ["src/keep.ts", "src/fixed.ts"] }), false);
		// Re-run: keep.ts is still untested (stays); fixed.ts gained a test (drops
		// off — a safe shrink); new.ts became untested AFTER the first adoption.
		// Exempting a newly-appeared offender loosens the coverage floor, so the
		// re-run REFUSES it — the list may shrink but never grow. (adopt writes via
		// plain fs and bypasses the baseline-integrity gate, so the rule lives here.)
		const result = untestedFilesStep(
			cwd,
			scanWith({ untested: ["src/keep.ts", "src/new.ts"] }),
			false,
		);
		const baseline = readJson(".interlinked/untested-files-baseline.json");
		expect(baseline.files).toEqual(["src/keep.ts"]); // new.ts NOT added; fixed.ts dropped
		expect(result.detail).toBe(
			"1 untested file(s) exempted (0 new, 1 dropped); 1 new offender(s) REFUSED (a re-run cannot grow the exemption list — cover them)",
		);
	});

	it("counts refusals per-file, not by a constant (asymmetric exempted/new split)", () => {
		// existing exemption: {a}. scanned (still untested): {a, b, c} — b and c
		// are BOTH new offenders (refused=2). Negating the has() check would
		// instead count only `a` (refused=1), so the two disagree.
		untestedFilesStep(cwd, scanWith({ untested: ["src/a.ts"] }), false);
		const result = untestedFilesStep(
			cwd,
			scanWith({ untested: ["src/a.ts", "src/b.ts", "src/c.ts"] }),
			false,
		);
		expect(result.detail).toContain("2 new offender(s) REFUSED");
		const baseline = readJson(".interlinked/untested-files-baseline.json");
		expect(baseline.files).toEqual(["src/a.ts"]); // b, c refused
	});

	it("preserves an existing threshold verbatim", () => {
		writeFileSync(
			join(cwd, ".interlinked-seed.json"),
			"", // placeholder so mkdtemp dir is non-empty before the step creates .interlinked/
		);
		untestedFilesStep(cwd, scanWith({ untested: [] }), false);
		// hand-tighten the threshold, then refresh
		writeFileSync(
			join(cwd, ".interlinked/untested-files-baseline.json"),
			`${JSON.stringify({ version: 1, min_coverage_pct: 80, files: [] })}\n`,
		);
		resetUntestedFilesBaselineCache();
		untestedFilesStep(cwd, scanWith({ untested: ["src/a.ts"] }), false);
		const baseline = readJson(".interlinked/untested-files-baseline.json");
		expect(baseline.min_coverage_pct).toBe(80);
	});
});

describe("metricCapsStep", () => {
	it("writes shipped defaults when metric-caps.json is absent", () => {
		const result = metricCapsStep(cwd, false);
		expect(result.action).toBe("written");
		const caps = readJson(".interlinked/metric-caps.json");
		expect(caps.max_lines).toBe(DEFAULT_MAX_LINES);
		expect(caps.max_function_tokens).toBe(DEFAULT_MAX_FUNCTION_TOKENS);
		expect(caps.version).toBe(1);
	});

	// The exact defaults summary the detail text embeds — computed the same way
	// the source does, so this test tracks METRIC_DEFS without hardcoding it,
	// while still pinning the exact string (kills the `.map`/`.join(" ")`/`{}`
	// template mutants that a `toContain` on a substring would miss).
	const summary = METRIC_DEFS.map((d) => `${d.key}=${d.defaultValue}`).join(" ");

	it("written detail carries the exact label and defaults summary", () => {
		const result = metricCapsStep(cwd, false);
		expect(result.label).toBe("Metric caps");
		expect(result.detail).toBe(`defaults written (${summary})`);
		// File content ends with a trailing newline (not silently dropped).
		const raw = readFileSync(join(cwd, ".interlinked/metric-caps.json"), "utf-8");
		expect(raw.endsWith("}\n")).toBe(true);
	});

	it("dry-run detail carries the exact 'would write' summary", () => {
		const result = metricCapsStep(cwd, true);
		expect(result.detail).toBe(`would write defaults (${summary})`);
	});

	it("respects an existing metric-caps.json (only-if-absent)", () => {
		metricCapsStep(cwd, false);
		writeFileSync(
			join(cwd, ".interlinked/metric-caps.json"),
			`${JSON.stringify({ version: 1, max_lines: 400 })}\n`,
		);
		resetMetricCapsCache();
		const result = metricCapsStep(cwd, false);
		expect(result.action).toBe("unchanged");
		expect(result.detail).toBe("existing metric-caps.json respected");
		expect(readJson(".interlinked/metric-caps.json").max_lines).toBe(400);
	});

	it("writes nothing under dry-run", () => {
		const result = metricCapsStep(cwd, true);
		expect(result.action).toBe("would-write");
		expect(existsSync(join(cwd, ".interlinked/metric-caps.json"))).toBe(false);
	});
});

describe("loadCoverageReport", () => {
	it("returns the exact empty-report shape when no report file exists", () => {
		const result = loadCoverageReport(cwd);
		expect(result).toEqual({
			summary: null,
			reportLabel: "",
			failedPath: null,
			perFileLinesPct: new Map(),
		});
	});

	it("merges a found report into perFileLinesPct and reportLabel, skipping 'total'", () => {
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({
				total: { lines: { pct: 99 } },
				"src/a.ts": { lines: { pct: 80 } },
			}),
		);
		const result = loadCoverageReport(cwd);
		expect(result.failedPath).toBeNull();
		expect(result.reportLabel).toBe("coverage/coverage-summary.json");
		expect(result.perFileLinesPct).toEqual(new Map([["src/a.ts", 80]]));
	});

	it("treats a file entry with no lines field as 0% instead of throwing", () => {
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({
				"src/a.ts": { branches: { pct: 50 } },
			}),
		);
		const result = loadCoverageReport(cwd);
		expect(result.failedPath).toBeNull();
		expect(result.perFileLinesPct).toEqual(new Map([["src/a.ts", 0]]));
	});

	it("joins multiple merged report labels with ' + ', not concatenated", () => {
		put(
			"coverage/lcov.info",
			"SF:src/b.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n",
		);
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({ "src/a.ts": { lines: { pct: 80 }, branches: { pct: 70 } } }),
		);
		const result = loadCoverageReport(cwd);
		expect(result.failedPath).toBeNull();
		expect(result.reportLabel).toBe("coverage/lcov.info + coverage/coverage-summary.json");
	});

	it("reports the failed path on a malformed report instead of throwing", () => {
		put("coverage/coverage-summary.json", "{ not valid json");
		const result = loadCoverageReport(cwd);
		expect(result.failedPath).toBe(join(cwd, "coverage/coverage-summary.json"));
		expect(result.summary).toBeNull();
	});
});

describe("coverageStep", () => {
	it("propagates a failed parse as action:'failed' with the exact detail", () => {
		put("coverage/coverage-summary.json", "{ not valid json");
		const coverage = loadCoverageReport(cwd);
		const result = coverageStep(cwd, coverage, false);
		expect(result.step).toBe("coverage");
		expect(result.label).toBe("Coverage baseline");
		expect(result.action).toBe("failed");
		expect(result.detail).toBe(
			`could not parse coverage report at ${join(cwd, "coverage/coverage-summary.json")}`,
		);
	});

	it("writes an empty baseline (once) when no report is found", () => {
		const coverage = loadCoverageReport(cwd);
		const result = coverageStep(cwd, coverage, false);
		expect(result.action).toBe("written");
		expect(result.detail).toBe("no coverage report found; wrote an empty baseline");
		expect(existsSync(join(cwd, ".interlinked/coverage-baseline.json"))).toBe(true);
	});

	it("leaves an already-seeded empty baseline unchanged on a second no-report run", () => {
		coverageStep(cwd, loadCoverageReport(cwd), false);
		const result = coverageStep(cwd, loadCoverageReport(cwd), false);
		expect(result.label).toBe("Coverage baseline");
		expect(result.action).toBe("unchanged");
		expect(result.detail).toBe("no coverage report found; existing baseline kept");
	});

	it("dry-run never writes the baseline even when a report is found", () => {
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({ "src/a.ts": { lines: { pct: 80 }, branches: { pct: 70 } } }),
		);
		const result = coverageStep(cwd, loadCoverageReport(cwd), true);
		expect(result.action).toBe("would-write");
		expect(existsSync(join(cwd, ".interlinked/coverage-baseline.json"))).toBe(false);
	});

	it("dry-run with no report: exact 'would write an empty baseline' detail, nothing written", () => {
		const result = coverageStep(cwd, loadCoverageReport(cwd), true);
		expect(result.action).toBe("would-write");
		expect(result.detail).toBe("no coverage report found; would write an empty baseline");
		expect(existsSync(join(cwd, ".interlinked/coverage-baseline.json"))).toBe(false);
	});

	it("snapshots a found report's per-file high-waters, written detail exact", () => {
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({ "src/a.ts": { lines: { pct: 80 }, branches: { pct: 70 } } }),
		);
		const coverage = loadCoverageReport(cwd);
		const result = coverageStep(cwd, coverage, false);
		expect(result.step).toBe("coverage");
		expect(result.label).toBe("Coverage baseline");
		expect(result.action).toBe("written");
		expect(result.kept_tighter).toBe(0);
		expect(result.detail).toBe(
			"1 per-file high-water(s) from coverage/coverage-summary.json",
		);
		const baseline = readJson(".interlinked/coverage-baseline.json");
		// SAFETY: test-owned fixture written by coverageStep under test; shape
		// matches CoverageBaseline.files (per-file lines_pct high-water).
		expect(
			(baseline.files as Record<string, { lines_pct: number }>)["src/a.ts"]?.lines_pct,
		).toBe(80);
	});

	it("keeps the tighter recorded value when a re-run's report regresses, note in detail", () => {
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({ "src/a.ts": { lines: { pct: 90 }, branches: { pct: 90 } } }),
		);
		coverageStep(cwd, loadCoverageReport(cwd), false);
		// Regress the report — the baseline must hold at the prior high-water.
		put(
			"coverage/coverage-summary.json",
			JSON.stringify({ "src/a.ts": { lines: { pct: 40 }, branches: { pct: 40 } } }),
		);
		const result = coverageStep(cwd, loadCoverageReport(cwd), false);
		expect(result.kept_tighter).toBe(1);
		expect(result.detail).toBe(
			"1 per-file high-water(s) from coverage/coverage-summary.json; 1 below their high-water kept at the tighter value",
		);
		const baseline = readJson(".interlinked/coverage-baseline.json");
		// SAFETY: test-owned fixture written by coverageStep under test; shape
		// matches CoverageBaseline.files (per-file lines_pct high-water).
		expect(
			(baseline.files as Record<string, { lines_pct: number }>)["src/a.ts"]?.lines_pct,
		).toBe(90);
	});
});

describe("suiteBaselineStep (opt-in step 6)", () => {
	/** A repo whose profile detects a js runner (vitest in devDependencies). */
	function writeVitestManifest(): void {
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({ name: "fixture", devDependencies: { vitest: "^3.0.0" } }),
			"utf-8",
		);
	}

	function stubRunner(result: Partial<CoverageRunResult>): CoverageRunner {
		const full: CoverageRunResult = {
			suiteMs: 5,
			perFile: new Map(),
			ok: true,
			testsPassed: true,
			...result,
		};
		return { id: "stub", run: async () => full };
	}

	it("invokes the runner with the exact projectRoot and coverageDir", async () => {
		writeVitestManifest();
		let capturedOpts: { projectRoot: string; coverageDir: string } | undefined;
		const runner: CoverageRunner = {
			id: "stub",
			run: async (opts) => {
				capturedOpts = opts;
				return {
					suiteMs: 5,
					perFile: new Map(),
					ok: true,
					testsPassed: true,
				};
			},
		};
		await suiteBaselineStep(cwd, false, () => runner);
		expect(capturedOpts).toEqual({
			projectRoot: cwd,
			coverageDir: join(cwd, ".interlinked", "coverage"),
		});
	});

	it("records a GREEN suite (empty failing set)", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () => stubRunner({ testsPassed: true }));
		expect(result.step).toBe("suite_baseline");
		expect(result.label).toBe("Suite baseline");
		expect(result.action).toBe("written");
		expect(result.detail).toBe(
			"suite is GREEN — recorded (the commit-gate red-bar blocks any future failure)",
		);
		const baseline = readSuiteBaseline(cwd);
		expect(baseline?.green).toBe(true);
		expect(baseline?.failing_tests).toEqual([]);
		expect(baseline?.language).toBe("ts");
	});

	it("records a RED suite with its pre-existing failing tests", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () =>
			stubRunner({ testsPassed: false, failingTests: ["a.test.ts > breaks", "b.test.ts > also"] }),
		);
		expect(result.action).toBe("written");
		expect(result.detail).toContain("2 pre-existing failing test(s)");
		const baseline = readSuiteBaseline(cwd);
		expect(baseline?.green).toBe(false);
		expect(baseline?.failing_tests).toEqual(["a.test.ts > breaks", "b.test.ts > also"]);
	});

	it("is unchanged when no coverage runner exists for the detected language", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () => null);
		expect(result.action).toBe("unchanged");
		expect(result.detail).toBe("no coverage runner for ts");
		expect(readSuiteBaseline(cwd)).toBeNull();
	});

	it("does NOT record when the runner could not establish a result (ok: false)", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () =>
			stubRunner({ ok: false, error: "vitest not launchable", testsPassed: null }),
		);
		expect(result.action).toBe("failed");
		expect(result.detail).toBe(
			"suite run failed (vitest not launchable) — baseline not recorded",
		);
		expect(readSuiteBaseline(cwd)).toBeNull();
	});

	it("falls back to 'runner error' in the detail when the runner reports no error message", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () =>
			// `error` is OMITTED, not set to undefined: under
			// exactOptionalPropertyTypes an explicit `undefined` is not assignable
			// to an optional property. Omitting it is what "runner reported no
			// error message" actually looks like at runtime.
			stubRunner({ ok: false, testsPassed: null }),
		);
		expect(result.action).toBe("failed");
		expect(result.detail).toBe("suite run failed (runner error) — baseline not recorded");
	});

	it("picks python when only a python runner is detected (no js manifest)", async () => {
		writeFileSync(join(cwd, "pytest.ini"), "[pytest]\n", "utf-8");
		const result = await suiteBaselineStep(cwd, false, () => stubRunner({ testsPassed: true }));
		expect(result.action).toBe("written");
		const baseline = readSuiteBaseline(cwd);
		expect(baseline?.language).toBe("python");
	});

	it("skips (unchanged) when no supported runner is detected — never spawns", async () => {
		// Bare tmp dir: no package.json, no pytest markers → profile finds nothing.
		let resolverCalled = false;
		const result = await suiteBaselineStep(cwd, false, () => {
			resolverCalled = true;
			return stubRunner({});
		});
		expect(result.action).toBe("unchanged");
		expect(result.detail).toBe(
			"no supported test runner detected (vitest/jest/pytest) — nothing recorded",
		);
		expect(resolverCalled).toBe(false);
		expect(readSuiteBaseline(cwd)).toBeNull();
	});

	it("writes nothing under dry-run even with a runner present", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, true, () => stubRunner({}));
		expect(result.action).toBe("would-write");
		expect(result.detail).toBe("would run the ts suite once and record red/green + failing tests");
		expect(readSuiteBaseline(cwd)).toBeNull();
	});
});
