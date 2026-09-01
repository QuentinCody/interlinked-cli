// ===========================================
// coverage check/baseline commands — exact-output survivor kills
// ===========================================
// These assert the FULL rendered output string (not substrings) for
// coverageCheckCommand / coverageBaselineCommand so that mutations to
// literal separators, whitespace, and branch conditions inside
// renderNormal/renderPartialReportNotice/coverageBaselineCommand fail the
// suite instead of surviving silently.
//
// Expected strings are built via the SAME formatter helpers
// (`c`, `header`, `kvLine`) the source uses, rather than hardcoded ANSI —
// vitest's non-TTY stdout still resolves color support per-environment.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coverageSetupGuidance, lcovReportPaths } from "../../harness/coverage-adapters.js";
import { loadBaseline, saveBaseline } from "../../harness/coverage-ratchet.js";
import { c, header, kvLine } from "../../lib/formatter.js";
import { nonNull } from "../../lib/non-null.js";
import { coverageBaselineCommand, coverageCheckCommand, loadMergedReport } from "../coverage.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "cov-cmd-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.restoreAllMocks();
	process.exitCode = 0;
});

/** Write a minimal LCOV report: two DA'd lines, both hit (100% lines,
 *  vacuous 100% branches/functions since no BRDA/FN present). */
function writeLcov(rel: string, reportRel = "coverage/lcov.info"): string {
	const lcov = [`SF:${rel}`, "DA:1,1", "DA:2,1", "end_of_record", ""].join("\n");
	const target = join(cwd, reportRel);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, lcov);
	return target;
}

const ISTANBUL_REPORT_PATHS = ["coverage/coverage-summary.json", "coverage/coverage-final.json"];

describe("coverageCheckCommand — no report found (exact message)", () => {
	it("prints the exact 'no report found' error with every default path listed", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await coverageCheckCommand({ cwd });

		const defaultPaths = [...lcovReportPaths(), ...ISTANBUL_REPORT_PATHS];
		const expected =
			`Error: No coverage report found. Expected one of:\n  ${defaultPaths
				.map((p) => `- ${p}`)
				.join("\n  ")}\n\n` +
			`Generate one — each command emits LCOV at a per-language path the ratchet merges:\n${coverageSetupGuidance(cwd)}`;

		expect(errSpy).toHaveBeenCalledTimes(1);
		// SAFETY: console.error is mocked above; its sole call is a string message.
		expect(errSpy.mock.calls[0]?.[0] as string).toBe(expected);
		expect(process.exitCode).toBe(1);
	});
});

describe("coverageCheckCommand — first run, no baseline (exact normal output)", () => {
	it("joins multiple report paths with ' + ' and reports all-new/no-regressions", async () => {
		writeLcov("src/foo.ts", "coverage/lcov.info");
		writeLcov("src/bar.py", "coverage/lcov-python.info");

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await coverageCheckCommand({ cwd, strict: true });

		expect(logSpy).toHaveBeenCalledTimes(1);
		// --strict with ZERO findings must never fail the run (kills a mutant
		// that turns `findings.length > 0` into `>= 0`, which would be true
		// even with no findings and wrongly set exitCode 1 under --strict).
		expect(process.exitCode).toBe(0);
		// No --update-baseline was requested, so neither the "updated" nor the
		// "NOT updated" banner should print at all.
		expect(writeSpy).not.toHaveBeenCalled();
		// SAFETY: console.log is mocked above; its sole call is the rendered string.
		const printed = logSpy.mock.calls[0]?.[0] as string;

		const reportPath = [join(cwd, "coverage/lcov.info"), join(cwd, "coverage/lcov-python.info")].join(
			" + ",
		);
		const expected = [
			header("Coverage Ratchet"),
			kvLine("Report", reportPath),
			kvLine("Files checked", "2"),
			kvLine("New / Improved / Decreased", "2 / 0 / 0"),
			"",
			c.green("  ✓ No per-file coverage regressions."),
		].join("\n");

		expect(printed).toBe(expected);
	});
});

describe("coverageCheckCommand — report-path display order survives internal mtime sorting", () => {
	it("keeps the ORIGINAL resolveReportPaths order in the displayed 'Report' line even when mtime order differs", async () => {
		// Canonical lcov.info resolves FIRST in resolveReportPaths' fixed list,
		// but give it the NEWER mtime — the reverse of ascending-mtime order —
		// so a loadMergedReport that sorts `reportPaths` IN PLACE (instead of a
		// defensive copy) would leave the caller's array — and hence the
		// displayed report path — reordered.
		const canonical = writeLcov("src/foo.ts", "coverage/lcov.info");
		const perLang = writeLcov("src/bar.py", "coverage/lcov-python.info");
		utimesSync(perLang, new Date(1000), new Date(1000));
		utimesSync(canonical, new Date(2000), new Date(2000));

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await coverageCheckCommand({ cwd });

		// SAFETY: console.log is mocked above; its sole call is the rendered string.
		const printed = logSpy.mock.calls[0]?.[0] as string;
		const expectedReportPath = [canonical, perLang].join(" + ");
		expect(printed).toContain(kvLine("Report", expectedReportPath));
	});
});

describe("coverageCheckCommand — --update-baseline (exact stderr banner + persisted file)", () => {
	it("writes the baseline and prints the exact green confirmation line", async () => {
		writeLcov("src/foo.ts");
		const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await coverageCheckCommand({ cwd, updateBaseline: true });

		expect(writeSpy).toHaveBeenCalledWith(
			`\n  ${c.green("✓")} Baseline updated at ${join(".interlinked", "coverage-baseline.json")}\n`,
		);

		const baseline = loadBaseline(join(cwd, ".interlinked"));
		expect(baseline.files["src/foo.ts"]).toEqual({ lines_pct: 100, branches_pct: 100 });
	});
});

describe("coverageCheckCommand — regression findings (exact multi-line block)", () => {
	it("prints one '✗' line per finding with the exact glyph/percent formatting", async () => {
		// Report: only 1 of 2 lines hit (50%) against a 100% baseline — a real
		// regression to force the findings block.
		const lcov = ["SF:src/foo.ts", "DA:1,1", "DA:2,0", "end_of_record", ""].join("\n");
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		writeFileSync(join(cwd, "coverage/lcov.info"), lcov);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		saveBaseline(join(cwd, ".interlinked"), {
			version: 1,
			updated_at: new Date(0).toISOString(),
			files: { "src/foo.ts": { lines_pct: 100, branches_pct: 100 } },
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await coverageCheckCommand({ cwd, strict: true });

		// SAFETY: console.log is mocked above; its sole call is the rendered string.
		const printed = logSpy.mock.calls[0]?.[0] as string;
		const reportPath = join(cwd, "coverage/lcov.info");
		const expected = [
			header("Coverage Ratchet"),
			kvLine("Report", reportPath),
			kvLine("Files checked", "1"),
			kvLine("New / Improved / Decreased", "0 / 0 / 1"),
			"",
			c.red("  1 regression(s):"),
			`    ${c.red("✗")} src/foo.ts ${c.dim("[lines]")} 100% → 50% ${c.dim("(-50.0%)")}`,
			"",
			c.dim("  Add tests to restore coverage, or run with --update-baseline to accept."),
		].join("\n");
		expect(printed).toBe(expected);
		expect(process.exitCode).toBe(1); // error severity always fails regardless of --strict
	});
});

describe("coverageCheckCommand — partial report + --update-baseline + json mode", () => {
	it("suppresses BOTH the 'updated' and 'NOT updated' stderr banners in json mode", async () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		// 20 baseline files, all well-covered (>= 50%) — the partial-report
		// detector's minimum comparable-files floor.
		const files: Record<string, { lines_pct: number; branches_pct: number }> = {};
		for (let i = 0; i < 20; i++) {
			files[`src/f${String(i).padStart(2, "0")}.ts`] = { lines_pct: 100, branches_pct: 100 };
		}
		saveBaseline(join(cwd, ".interlinked"), {
			version: 1,
			updated_at: new Date(0).toISOString(),
			files,
		});

		// Current report: 5/20 (25%, at the threshold) read as EXACTLY 0% on
		// both metrics — the scoped-run shape the detector treats as partial.
		const lcovLines: string[] = [];
		for (let i = 0; i < 20; i++) {
			const rel = `src/f${String(i).padStart(2, "0")}.ts`;
			const zeroed = i < 5;
			lcovLines.push(
				`SF:${rel}`,
				zeroed ? "DA:1,0" : "DA:1,1",
				zeroed ? "BRDA:1,0,0,0" : "BRDA:1,0,0,1",
				"end_of_record",
			);
		}
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		writeFileSync(join(cwd, "coverage/lcov.info"), `${lcovLines.join("\n")}\n`);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		await coverageCheckCommand({ cwd, updateBaseline: true, json: true });

		expect(logSpy).toHaveBeenCalledTimes(1);
		// SAFETY: console.log is mocked above; its sole call is the JSON payload.
		const printed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
		expect(printed.partialReport.partial).toBe(true);
		// Neither banner may print in json mode, regardless of --update-baseline
		// or which branch (updated / not-updated) would otherwise fire.
		expect(writeSpy).not.toHaveBeenCalled();
	});
});

describe("coverageCheckCommand — partial report, normal mode (exact notice text)", () => {
	it("prints the exact partial-report banner instead of stats/findings", async () => {
		const files: Record<string, { lines_pct: number; branches_pct: number }> = {};
		for (let i = 0; i < 20; i++) {
			files[`src/f${String(i).padStart(2, "0")}.ts`] = { lines_pct: 100, branches_pct: 100 };
		}
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		saveBaseline(join(cwd, ".interlinked"), {
			version: 1,
			updated_at: new Date(0).toISOString(),
			files,
		});

		const lcovLines: string[] = [];
		for (let i = 0; i < 20; i++) {
			const rel = `src/f${String(i).padStart(2, "0")}.ts`;
			const zeroed = i < 5; // 5/20 = 25%, at the partial-report threshold
			lcovLines.push(
				`SF:${rel}`,
				zeroed ? "DA:1,0" : "DA:1,1",
				zeroed ? "BRDA:1,0,0,0" : "BRDA:1,0,0,1",
				"end_of_record",
			);
		}
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		writeFileSync(join(cwd, "coverage/lcov.info"), `${lcovLines.join("\n")}\n`);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await coverageCheckCommand({ cwd });

		// SAFETY: console.log is mocked above; its sole call is the rendered string.
		const printed = logSpy.mock.calls[0]?.[0] as string;
		const reportPath = join(cwd, "coverage/lcov.info");
		const expected = [
			header("Coverage Ratchet"),
			kvLine("Report", reportPath),
			"",
			c.yellow("  ⚠ Coverage report looks PARTIAL — findings suppressed, not measured."),
			c.dim("    5/20 previously well-covered files now read as exactly 0%."),
			c.dim(
				"    Likely cause: a scoped `vitest run --coverage <files>` overwrote the shared report.",
			),
			c.dim("    Re-run the full suite before trusting this report."),
		].join("\n");
		expect(printed).toBe(expected);
		expect(process.exitCode).toBe(0); // partial can never fail the run
	});
});

describe("coverageCheckCommand — changedFiles filter (split + trim + Boolean)", () => {
	it("only checks the listed file, trimming whitespace around commas", async () => {
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		writeFileSync(
			join(cwd, "coverage/lcov.info"),
			[
				"SF:src/foo.ts",
				"DA:1,1",
				"DA:2,1",
				"end_of_record",
				"SF:src/bar.ts",
				"DA:1,1",
				"DA:2,1",
				"end_of_record",
				"",
			].join("\n"),
		);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		// Deliberately pad with spaces around the comma — must still resolve.
		await coverageCheckCommand({ cwd, changedFiles: " src/bar.ts , " });

		// SAFETY: console.log is mocked above; its sole call is the rendered string.
		const printed = logSpy.mock.calls[0]?.[0] as string;
		expect(printed).toBe(
			[
				header("Coverage Ratchet"),
				kvLine("Report", join(cwd, "coverage/lcov.info")),
				kvLine("Files checked", "1"),
				kvLine("New / Improved / Decreased", "1 / 0 / 0"),
				"",
				c.green("  ✓ No per-file coverage regressions."),
			].join("\n"),
		);
	});
});

describe("coverageBaselineCommand — exact output", () => {
	it("prints the exact empty-baseline message", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		coverageBaselineCommand({ cwd });

		// SAFETY: console.log is mocked above; its sole call is the rendered string.
		const printed = logSpy.mock.calls[0]?.[0] as string;
		const expected = [
			header("Coverage Baseline"),
			kvLine("Updated", new Date(0).toISOString()),
			kvLine("Files", "0"),
			"",
			c.dim("  (no baseline yet — run `interlinked coverage check --update-baseline`)"),
		].join("\n");
		expect(printed).toBe(expected);
	});

	it("prints exact rows for a populated baseline, sorted, with truncation past 25", () => {
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		const files: Record<string, { lines_pct: number; branches_pct: number }> = {};
		for (let i = 0; i < 27; i++) {
			// Zero-padded so string sort order == numeric order.
			const name = `src/f${String(i).padStart(2, "0")}.ts`;
			files[name] = { lines_pct: 80 + (i % 5), branches_pct: 70 + (i % 5) };
		}
		saveBaseline(join(cwd, ".interlinked"), {
			version: 1,
			updated_at: "2026-01-01T00:00:00.000Z",
			files,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		coverageBaselineCommand({ cwd });
		// SAFETY: console.log is mocked above; its sole call is the rendered string.
		const printed = logSpy.mock.calls[0]?.[0] as string;

		const sortedNames = Object.keys(files)
			.sort((a, b) => a.localeCompare(b))
			.slice(0, 25);
		const expectedLines = [
			header("Coverage Baseline"),
			kvLine("Updated", "2026-01-01T00:00:00.000Z"),
			kvLine("Files", "27"),
			"",
			...sortedNames.map((file) => {
				const m = files[file] as { lines_pct: number; branches_pct: number };
				return `  ${file} ${c.dim(`lines=${m.lines_pct.toFixed(1)}% branches=${m.branches_pct.toFixed(1)}%`)}`;
			}),
			c.dim("  … and 2 more"),
		];
		expect(printed).toBe(expectedLines.join("\n"));
	});
});

describe("loadReport (via loadMergedReport) — LCOV with an ABSOLUTE SF path", () => {
	it("relativizes an absolute SF path against the given cwd, not left absolute", () => {
		// Some LCOV producers (e.g. certain Rust/Go tooling) emit absolute
		// source paths. loadReport must pass `cwd` through to loadLcovFile so
		// these relativize the same way relative SF paths already do.
		const absoluteSf = join(cwd, "src/abs.ts");
		const target = join(cwd, "coverage/lcov.info");
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		writeFileSync(target, [`SF:${absoluteSf}`, "DA:1,1", "DA:2,1", "end_of_record", ""].join("\n"));

		const { summary, failedPath } = loadMergedReport([target], cwd);
		expect(failedPath).toBeNull();
		expect(summary["src/abs.ts"]).toBeDefined();
		expect(summary[absoluteSf]).toBeUndefined();
	});
});

describe("loadMergedReport — per-entry skip guards (nullish entry, out-of-repo key)", () => {
	it("skips a nullish entry and a key that normalizes outside repoRoot, keeping only the valid one", () => {
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		const target = join(cwd, "coverage/coverage-summary.json");
		writeFileSync(
			target,
			JSON.stringify({
				"src/good.ts": { lines: { pct: 100 }, branches: { pct: 100 } },
				"src/bogus.ts": null,
				"/elsewhere/outside.ts": { lines: { pct: 50 }, branches: { pct: 50 } },
			}),
		);

		const { summary, failedPath } = loadMergedReport([target], cwd);
		expect(failedPath).toBeNull();
		expect(summary).toEqual({
			"src/good.ts": { lines: { pct: 100 }, branches: { pct: 100 } },
		});
	});
});

describe("loadMergedReport — mtime ordering (freshest wins)", () => {
	it("a NEWER report's entry overwrites an OLDER report's entry for the same key", () => {
		const older = join(cwd, "coverage/lcov-a.info");
		const newer = join(cwd, "coverage/lcov-b.info");
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		writeFileSync(older, ["SF:src/dual.ts", "DA:1,1", "DA:2,0", "end_of_record", ""].join("\n"));
		writeFileSync(newer, ["SF:src/dual.ts", "DA:1,1", "DA:2,1", "end_of_record", ""].join("\n"));
		utimesSync(older, new Date(1000), new Date(1000));
		utimesSync(newer, new Date(2000), new Date(2000));

		const { summary, failedPath } = loadMergedReport([older, newer], cwd);
		expect(failedPath).toBeNull();
		expect(nonNull(summary["src/dual.ts"]?.lines).pct).toBe(100); // newer (100%) wins, not older (50%)
	});

	it("passing the paths in reverse order still resolves to the freshest content (sort is by mtime, not array order)", () => {
		const older = join(cwd, "coverage/lcov-a.info");
		const newer = join(cwd, "coverage/lcov-b.info");
		mkdirSync(join(cwd, "coverage"), { recursive: true });
		writeFileSync(older, ["SF:src/dual.ts", "DA:1,1", "DA:2,0", "end_of_record", ""].join("\n"));
		writeFileSync(newer, ["SF:src/dual.ts", "DA:1,1", "DA:2,1", "end_of_record", ""].join("\n"));
		utimesSync(older, new Date(1000), new Date(1000));
		utimesSync(newer, new Date(2000), new Date(2000));

		// newer listed FIRST — if the sort direction flips (mutant: `+` for `-`,
		// or dropping the `[...]` copy so order is left as array-order), the
		// merge would let the OLDER (50%) entry win instead.
		const { summary } = loadMergedReport([newer, older], cwd);
		expect(nonNull(summary["src/dual.ts"]?.lines).pct).toBe(100);
	});
});
