// ===========================================
// coverage check — report-path resolution (round 5, finding 2026-06)
// ===========================================
// The resolver returned ONLY the LCOV set whenever any LCOV file existed, so a
// polyglot repo with stale Python/Rust LCOV and a fresh JS run that emits only
// istanbul JSON had its current JS coverage silently omitted from the ratchet.
// The istanbul report now always rides along; the mtime-ordered merge keeps
// the fresher run's numbers on any overlap.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { loadMergedReport, resolveReportPaths } from "../coverage.js";

let cwd: string;

function writeReport(rel: string): string {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, "{}\n");
	return abs;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "cov-resolve-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

describe("resolveReportPaths", () => {
	it("includes the istanbul summary ALONGSIDE existing LCOV reports", () => {
		const lcov = writeReport("coverage/lcov.info");
		const rust = writeReport("coverage/lcov-rust.info");
		const summary = writeReport("coverage/coverage-summary.json");
		const paths = resolveReportPaths(cwd);
		expect(paths).toContain(lcov);
		expect(paths).toContain(rust);
		expect(paths).toContain(summary);
	});

	it("falls back to coverage-final.json when no summary exists", () => {
		writeReport("coverage/lcov-python.info");
		const final = writeReport("coverage/coverage-final.json");
		expect(resolveReportPaths(cwd)).toContain(final);
	});

	it("returns only the istanbul report when no LCOV exists", () => {
		const summary = writeReport("coverage/coverage-summary.json");
		expect(resolveReportPaths(cwd)).toEqual([summary]);
	});

	it("prefers the NEWEST istanbul report when both summary and final exist", () => {
		const summary = writeReport("coverage/coverage-summary.json");
		const final = writeReport("coverage/coverage-final.json");
		// A stale summary from a previous run lingering beside a fresh final: make
		// summary OLDER, final NEWER. Before the fix the resolver broke on summary
		// (listed first) and never considered final, so the mtime merge never saw
		// the fresh JS data and the ratchet ran stale (finding 2026-06).
		utimesSync(summary, new Date(1_000), new Date(1_000));
		utimesSync(final, new Date(2_000), new Date(2_000));
		const paths = resolveReportPaths(cwd);
		expect(paths).toContain(final);
		expect(paths).not.toContain(summary);
	});

	it("returns only the LCOV set when no istanbul report exists", () => {
		const lcov = writeReport("coverage/lcov.info");
		expect(resolveReportPaths(cwd)).toEqual([lcov]);
	});

	it("an explicit --report path overrides everything", () => {
		writeReport("coverage/lcov.info");
		writeReport("coverage/coverage-summary.json");
		const explicit = writeReport("custom/report.info");
		expect(resolveReportPaths(cwd, "custom/report.info")).toEqual([explicit]);
		expect(resolveReportPaths(cwd, "missing/report.info")).toEqual([]);
	});

	it("returns [] when no report exists anywhere", () => {
		expect(resolveReportPaths(cwd)).toEqual([]);
	});
});

// Round 6 (finding 2026-06): coverage-final.json is the istanbul FULL format
// (statementMap/s), not json-summary — fed to the summary parser it yielded
// ZERO entries and the ratchet passed vacuously while writing an invalid
// baseline. The merge now parses it natively and treats any zero-entry parse
// of an existing report as a LOUD failure.
describe("loadMergedReport — istanbul-final parsing + the vacuous-success guard", () => {
	function writeFinalReport(): string {
		const abs = join(cwd, "src/app.ts");
		const final = {
			[abs]: {
				path: abs,
				statementMap: {
					"0": { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
					"1": { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
				},
				s: { "0": 3, "1": 0 },
				fnMap: {},
				f: {},
				branchMap: { "0": { line: 1, locations: [{}, {}] } },
				b: { "0": [2, 0] },
			},
		};
		const target = join(cwd, "coverage/coverage-final.json");
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, JSON.stringify(final));
		return target;
	}

	it("derives real lines/branches percentages from coverage-final.json", () => {
		const target = writeFinalReport();
		const { summary, failedPath } = loadMergedReport([target], cwd);
		expect(failedPath).toBeNull();
		const entry = summary["src/app.ts"];
		expect(entry).toBeDefined();
		expect(nonNull(entry?.lines).pct).toBe(50); // 1 of 2 statement-start lines covered
		expect(nonNull(entry?.lines).total).toBe(2);
		expect(nonNull(entry?.branches).pct).toBe(50); // 1 of 2 branch paths taken
		expect(nonNull(entry?.branches).total).toBe(2);
	});

	it("fails LOUDLY on a report that parses to zero file entries", () => {
		const empty = join(cwd, "coverage/coverage-summary.json");
		mkdirSync(join(empty, ".."), { recursive: true });
		writeFileSync(empty, "{}");
		const { failedPath } = loadMergedReport([empty], cwd);
		expect(failedPath).toBe(empty);
	});

	it("fails LOUDLY on a coverage-final.json with no usable entries", () => {
		const target = join(cwd, "coverage/coverage-final.json");
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, JSON.stringify({ bogus: { not: "istanbul" } }));
		const { failedPath } = loadMergedReport([target], cwd);
		expect(failedPath).toBe(target);
	});
});
