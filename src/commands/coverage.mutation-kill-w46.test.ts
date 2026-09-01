import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import {
	coverageBaselineCommand,
	coverageCheckCommand,
	loadMergedReport,
	resolveReportPaths,
} from "./coverage.js";

let dir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
let logs: string[];
let errs: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "coverage-w46-"));
	logs = [];
	errs = [];
	logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
		logs.push(String(msg));
	});
	errSpy = vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
		errs.push(String(msg));
	});
	stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		errs.push(String(chunk));
		return true;
	});
	process.exitCode = undefined;
});

afterEach(() => {
	logSpy.mockRestore();
	errSpy.mockRestore();
	stderrWriteSpy.mockRestore();
	rmSync(dir, { recursive: true, force: true });
	process.exitCode = undefined;
});

function writeIstanbulSummary(cwd: string, entries: Record<string, { lines: number; branches: number }>) {
	const covDir = join(cwd, "coverage");
	mkdirSync(covDir, { recursive: true });
	const summary: Record<string, unknown> = {};
	for (const [file, { lines, branches }] of Object.entries(entries)) {
		summary[join(cwd, file)] = {
			lines: { pct: lines, covered: lines, total: 100 },
			branches: { pct: branches, covered: branches, total: 100 },
			statements: { pct: lines, covered: lines, total: 100 },
			functions: { pct: lines, covered: lines, total: 100 },
		};
	}
	writeFileSync(join(covDir, "coverage-summary.json"), JSON.stringify(summary), "utf-8");
}

describe("coverageCheckCommand — no report found guidance", () => {
	it("lists at least one default report path with a leading '- ' bullet", async () => {
		// test-contract: public-api — resolveReportPaths([]) drives the
		// "Expected one of:" bullet list; f3399b2f791256cb mutates
		// [...lcovReportPaths(), ...ISTANBUL_REPORT_PATHS] to [], which would
		// empty this list entirely.
		await coverageCheckCommand({ cwd: dir });
		expect(process.exitCode).toBe(1);
		const combined = errs.join("\n");
		expect(combined).toContain("No coverage report found");
		expect(combined).toMatch(/- coverage[\\/]coverage-summary\.json/);
		expect(combined).toMatch(/- .*\.info/);
	});
});

describe("resolveReportPaths", () => {
	it("returns [] when nothing exists", () => {
		// test-contract: public-api — resolveReportPaths is exported and its
		// empty-input behavior is a documented contract ("Empty ⇒ no report
		// anywhere").
		expect(resolveReportPaths(dir)).toEqual([]);
	});

	it("finds the istanbul coverage-summary.json when present", () => {
		// test-contract: public-api — exercises the ISTANBUL_REPORT_PATHS scan
		// and mtime-sort branch (961a0297.../0792219...).
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		const paths = resolveReportPaths(dir);
		expect(paths.length).toBe(1);
		expect(paths[0]).toContain("coverage-summary.json");
	});

	it("prefers explicit --report path when given and it exists", () => {
		// test-contract: public-api — explicit-path early return.
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		const explicitPath = join(dir, "coverage", "coverage-summary.json");
		const paths = resolveReportPaths(dir, join("coverage", "coverage-summary.json"));
		expect(paths).toEqual([explicitPath]);
	});

	it("returns [] for an explicit path that does not exist", () => {
		// test-contract: boundary — existsSync(resolved) guard on the explicit path.
		expect(resolveReportPaths(dir, "does/not/exist.json")).toEqual([]);
	});
});

describe("loadMergedReport", () => {
	it("merges a valid istanbul summary and normalizes absolute keys to repo-relative", () => {
		// test-contract: public-api — loadMergedReport's normalizePath step
		// (2e6e16f2 mutates { cwd } to {}, which would break normalization).
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 77, branches: 55 } });
		const paths = resolveReportPaths(dir);
		const { summary, failedPath } = loadMergedReport(paths, dir);
		expect(failedPath).toBeNull();
		expect(summary["src/a.ts"]).toBeDefined();
		expect(nonNull(summary["src/a.ts"]?.lines).pct).toBe(77);
	});

	it("reports failedPath for a report that parses to zero entries", () => {
		// test-contract: invariant — an empty-entries parse must abort the
		// merge loudly rather than pass vacuously (module doc, "round 6").
		const covDir = join(dir, "coverage");
		mkdirSync(covDir, { recursive: true });
		writeFileSync(join(covDir, "coverage-summary.json"), "{}", "utf-8");
		const paths = resolveReportPaths(dir);
		const { failedPath } = loadMergedReport(paths, dir);
		expect(failedPath).not.toBeNull();
	});
});

describe("coverageCheckCommand — full run against a report", () => {
	it("succeeds with no findings on first run and does not set exitCode", async () => {
		// test-contract: public-api — first-run baseline is empty, so every
		// file is "new" and no finding fires; text asserts the exact
		// "No per-file coverage regressions." string (245d6893 / d599a42e
		// mutate the findings.length > 0 branch condition).
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir });
		expect(process.exitCode).toBeUndefined();
		const combined = logs.join("\n");
		expect(combined).toContain("No per-file coverage regressions");
		expect(combined).not.toContain("Stryker was here");
	});

	it("--update-baseline persists baseline and prints the Updated banner to stderr", async () => {
		// test-contract: public-api — the exact banner text + path segments
		// ("Baseline updated", ".interlinked", "coverage-baseline.json") are
		// literal strings targeted by e7e08cf4/06079499/2fa6d16d mutants.
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		const combinedErr = errs.join("\n");
		expect(combinedErr).toContain("Baseline updated");
		expect(combinedErr).toContain(".interlinked");
		expect(combinedErr).toContain("coverage-baseline.json");

		logs = [];
		coverageBaselineCommand({ cwd: dir });
		const baselineOut = logs.join("\n");
		expect(baselineOut).toContain("Files");
		expect(baselineOut).toContain("1");
	});

	it("--update-baseline in json mode suppresses the Updated banner", async () => {
		// test-contract: public-api — mode !== "json" guards the stderr write
		// (8473ecae / 26b1eb7a / 72e2205e mutate this condition).
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir, updateBaseline: true, json: true });
		expect(errs.join("\n")).not.toContain("Baseline updated");
	});

	it("without --update-baseline, baseline stays empty even after a run", async () => {
		// test-contract: invariant — opts.updateBaseline && !partial gates the
		// saveBaseline call (d808624e mutates changedFiles!==undefined which
		// feeds the compareCoverage options spread but must not affect this).
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir });
		logs = [];
		coverageBaselineCommand({ cwd: dir });
		expect(logs.join("\n")).toContain("no baseline yet");
	});

	it("detects a per-file regression on the second run, reported as a warning (exitCode stays unset without --strict)", async () => {
		// test-contract: public-api — coverage_decrease findings are always
		// severity "warning" in this codebase (buildFinding), so hasErrors is
		// always false; only --strict promotes a warning to a failing run
		// (26b1eb7a / 72e2205e mutate the strict-gating condition at L119).
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		logs = [];
		errs = [];
		process.exitCode = undefined;

		writeIstanbulSummary(dir, { "src/a.ts": { lines: 10, branches: 5 } });
		await coverageCheckCommand({ cwd: dir });
		const combined = logs.join("\n");
		expect(combined).toContain("regression");
		expect(combined).toContain("✗");
		expect(combined).toContain("src/a.ts");
		expect(combined).not.toContain("Stryker was here");
		expect(process.exitCode).toBeUndefined();
	});

	it("--strict escalates a warning-only regression to exitCode=1", async () => {
		// test-contract: public-api — opts.strict && hasWarnings at L119;
		// 8473ecae/26b1eb7a/72e2205e mutate the surrounding conditions to
		// always-true or OR, which would flip this from a targeted case into
		// an unconditional block.
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		logs = [];
		process.exitCode = undefined;

		writeIstanbulSummary(dir, { "src/a.ts": { lines: 10, branches: 5 } });
		await coverageCheckCommand({ cwd: dir, strict: true });
		expect(process.exitCode).toBe(1);
	});

	it("changedFiles filter restricts findings to the named file", async () => {
		// test-contract: public-api — parseChangedFiles + the changedFiles
		// spread into compareCoverage's options (d808624e mutates the
		// undefined-check that gates this spread to always true).
		writeIstanbulSummary(dir, {
			"src/a.ts": { lines: 90, branches: 80 },
			"src/b.ts": { lines: 90, branches: 80 },
		});
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		logs = [];
		process.exitCode = undefined;

		writeIstanbulSummary(dir, {
			"src/a.ts": { lines: 10, branches: 5 },
			"src/b.ts": { lines: 10, branches: 5 },
		});
		await coverageCheckCommand({ cwd: dir, changedFiles: "src/a.ts" });
		const combined = logs.join("\n");
		expect(combined).toContain("src/a.ts");
		expect(combined).not.toContain("src/b.ts");
	});

	it("json output mode emits parseable JSON with report/findings/stats keys", async () => {
		// test-contract: public-api — buildJsonPayload's shape is the json-mode
		// contract consumed by scripting callers.
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir, json: true });
		const parsed = JSON.parse(logs.join(""));
		expect(parsed).toHaveProperty("report");
		expect(parsed).toHaveProperty("findings");
		expect(parsed).toHaveProperty("stats");
	});
});

describe("coverageCheckCommand — partial/scoped report", () => {
	function manyFiles(pct: number): Record<string, { lines: number; branches: number }> {
		const out: Record<string, { lines: number; branches: number }> = {};
		for (let i = 0; i < 25; i++) {
			out[`src/f${i}.ts`] = { lines: pct, branches: pct };
		}
		return out;
	}

	it("uses the ⚠ warning icon (not the checkmark) when --update-baseline hits a partial report", async () => {
		// test-contract: public-api — 5c71a427981ca948 mutates the literal "⚠"
		// used only on this NOT-updated-baseline path (L110); a scoped run of
		// 25 previously well-covered files all reading 0% must be detected as
		// partial and refuse to persist a corrupted baseline.
		writeIstanbulSummary(dir, manyFiles(90));
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		errs = [];
		writeIstanbulSummary(dir, manyFiles(0));
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		const combined = errs.join("\n");
		expect(combined).toContain("⚠");
		expect(combined).toContain("Baseline NOT updated");
		expect(combined).not.toContain("✓ Baseline updated");
	});

	it("renders the partial-report notice in normal mode instead of the regular findings summary", async () => {
		// test-contract: public-api — renderPartialReportNotice's exact copy
		// ("Coverage report looks PARTIAL", the zeroed/comparable count line,
		// and the re-run guidance) is asserted verbatim so any StringLiteral
		// mutation inside it (ee9f59ca/1ba6a79c/43d3328f) breaks the match.
		writeIstanbulSummary(dir, manyFiles(90));
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		logs = [];
		writeIstanbulSummary(dir, manyFiles(0));
		await coverageCheckCommand({ cwd: dir });
		const combined = logs.join("\n");
		expect(combined).toContain("Coverage report looks PARTIAL");
		expect(combined).toContain("25/25 previously well-covered files now read as exactly 0%");
		expect(combined).toContain("Re-run the full suite before trusting this report");
		expect(combined).not.toContain("Files checked");
		expect(combined).not.toContain("Stryker was here");
	});

	it("never sets exitCode for a partial report, even with --strict", async () => {
		// test-contract: invariant — module doc: "A partial report can never
		// fail the run" (coverage.ts L114-116).
		writeIstanbulSummary(dir, manyFiles(90));
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		process.exitCode = undefined;
		writeIstanbulSummary(dir, manyFiles(0));
		await coverageCheckCommand({ cwd: dir, strict: true });
		expect(process.exitCode).toBeUndefined();
	});
});

describe("coverageCheckCommand — malformed report", () => {
	it("reports a parse-failure error and sets exitCode=1 for an unparsable json-summary", async () => {
		// test-contract: bug — loadMergedReport's failedPath surfaces as this
		// exact error text; a silent-partial merge would misreport like the
		// clobbering bug documented on loadMergedReport.
		const covDir = join(dir, "coverage");
		mkdirSync(covDir, { recursive: true });
		writeFileSync(join(covDir, "coverage-summary.json"), "not json{{{", "utf-8");
		await coverageCheckCommand({ cwd: dir });
		expect(process.exitCode).toBe(1);
		expect(errs.join("\n")).toContain("Failed to parse coverage report");
	});
});

describe("coverageBaselineCommand", () => {
	it("shows the 'no baseline yet' guidance when nothing has been saved", () => {
		// test-contract: public-api — the exact empty-state copy is targeted
		// by StringLiteral mutants on the coverageBaselineCommand renderer.
		coverageBaselineCommand({ cwd: dir });
		const combined = logs.join("\n");
		expect(combined).toContain("no baseline yet");
		expect(combined).toContain("Coverage Baseline");
	});

	it("lists a saved baseline file with its lines/branches percentages", async () => {
		// test-contract: public-api — the per-file row template
		// (`lines=${pct}% branches=${pct}%`) exercises FileCoverageEntry
		// rendering distinct from the empty-baseline branch.
		writeIstanbulSummary(dir, { "src/a.ts": { lines: 90, branches: 80 } });
		await coverageCheckCommand({ cwd: dir, updateBaseline: true });
		logs = [];
		coverageBaselineCommand({ cwd: dir });
		const combined = logs.join("\n");
		expect(combined).toContain("src/a.ts");
		expect(combined).toMatch(/lines=90\.0% branches=80\.0%/);
		expect(combined).toContain("Updated");
		expect(combined).not.toContain("Stryker was here");
	});
});
