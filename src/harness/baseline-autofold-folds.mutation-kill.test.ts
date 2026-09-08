// Mutation-kill campaign for baseline-autofold-folds.ts survivors (wave pass1_w22).
//
// Each case is placed directly against the surviving mutant it targets, with
// exact-observable assertions derived by hand-tracing the pristine source.
// `// test-contract: <public-api|invariant|bug|security|boundary> — <rationale>`
// sits directly above each case.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FOLD_DETAIL_CAP,
	findCoverageSummary,
	foldCoverage,
	foldLargeFiles,
	foldUntestedFiles,
	isCoverageReportFresh,
	planExemptionDrops,
	planGrandfatherShrink,
	toRepoRelative,
} from "./baseline-autofold-folds.js";
import { resetLargeFileBaselineCache } from "./large-file-policy.js";
import { resetUntestedFilesBaselineCache } from "./tested-file-policy.js";

let cwd = "";
/** Same rationale as the companion test file: a session-start far in the
 *  future so a backdated report reads as stale, never the real clock. */
const FIXED_SESSION_START_MS = 4_000_000_000_000;

function write(rel: string, body: string): string {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body, "utf-8");
	return abs;
}

function writeCoverageBaseline(files: Record<string, { lines_pct: number; branches_pct: number }>) {
	write(
		".interlinked/coverage-baseline.json",
		JSON.stringify({ version: 1, updated_at: new Date(0).toISOString(), files }),
	);
}

function writeCoverageReport(files: Record<string, number>, mtimeSec?: number) {
	const summary: Record<string, unknown> = {};
	for (const [file, pct] of Object.entries(files)) {
		summary[file] = { lines: { pct }, branches: { pct }, statements: { pct }, functions: { pct } };
	}
	const abs = write("coverage/coverage-summary.json", JSON.stringify(summary));
	if (mtimeSec !== undefined) utimesSync(abs, mtimeSec, mtimeSec);
}

function writeUntestedBaseline(files: string[]) {
	write(".interlinked/untested-files-baseline.json", JSON.stringify({ version: 1, min_coverage_pct: 60, files }));
	resetUntestedFilesBaselineCache();
}

function writeLargeFileBaseline(maxLines: number, files: Record<string, number>) {
	write(".interlinked/large-files-baseline.json", JSON.stringify({ version: 1, max_lines: maxLines, files }));
	resetLargeFileBaselineCache();
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "autofold-folds-mutkill-"));
});

afterEach(() => {
	resetUntestedFilesBaselineCache();
	resetLargeFileBaselineCache();
	rmSync(cwd, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────
describe("skippedOutcome — shared skip shape", () => {
	// test-contract: invariant — skippedOutcome's `details` must be a fresh
	// [] (not a canary literal) and `dryRun` hardcoded false regardless of the
	// caller's requested dryRun.
	it("a skip outcome carries empty details and false dryRun even when dryRun was requested", () => {
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: true });
		expect(out.skipped).toBe("no-input");
		expect(out.details).toEqual([]);
		expect(out.dryRun).toBe(false);
	});
});

// ───────────────────────────────────────────────────────────────────
describe("findCoverageSummary — candidate selection", () => {
	// test-contract: public-api — with neither candidate on disk, present
	// must end up genuinely empty (the existsSync filter must run), not a
	// 2-element array of unfiltered, nonexistent paths.
	it("returns null when neither candidate report exists on disk", () => {
		expect(findCoverageSummary(cwd)).toBeNull();
	});

	// test-contract: public-api — when both candidates exist, the NEWER one
	// must win (the mtime sort/comparator must actually run), not just the
	// first candidate in COVERAGE_SUMMARY_CANDIDATES order.
	it("picks the candidate with the newer mtime, not just the first in list order", () => {
		const older = write("coverage/coverage-summary.json", "{}");
		const newer = write(".interlinked/coverage/coverage-summary.json", "{}");
		utimesSync(older, 1000, 1000);
		utimesSync(newer, 2000, 2000);
		expect(findCoverageSummary(cwd)).toBe(newer);
	});
});

describe("isCoverageReportFresh — pure boundary cases", () => {
	// test-contract: public-api — the sessionStart clause alone must be able
	// to prove freshness (left operand of the ||), independent of the baseline
	// clause reading false.
	it("is fresh via the sessionStart clause even when the baseline clause is false", () => {
		expect(isCoverageReportFresh({ reportMtimeMs: 200, sessionStartMs: 100, baselineMtimeMs: 300 })).toBe(true);
	});

	// test-contract: boundary — reportMtimeMs === sessionStartMs is
	// inclusive (>=), not exclusive (>).
	it("treats reportMtimeMs equal to sessionStartMs as fresh", () => {
		expect(isCoverageReportFresh({ reportMtimeMs: 100, sessionStartMs: 100, baselineMtimeMs: 200 })).toBe(true);
	});

	// test-contract: boundary — reportMtimeMs === baselineMtimeMs is
	// exclusive (>), not inclusive (>=), on the baseline clause.
	it("treats reportMtimeMs equal to baselineMtimeMs as NOT fresh via that clause", () => {
		expect(isCoverageReportFresh({ reportMtimeMs: 100, sessionStartMs: 200, baselineMtimeMs: 100 })).toBe(false);
	});
});

// ───────────────────────────────────────────────────────────────────
describe("countRaised (via foldCoverage) — raise detection and detail cap", () => {
	// test-contract: invariant — a flat file must not raise, and a file
	// present in the report but absent from the ORIGINAL baseline must be
	// skipped via the `!before` guard rather than dereferencing undefined.
	it("ignores a flat file and a report-only file absent from the prior baseline", () => {
		writeCoverageBaseline({
			"src/a.ts": { lines_pct: 40, branches_pct: 40 },
			"src/b.ts": { lines_pct: 80, branches_pct: 80 },
		});
		writeCoverageReport({ "src/a.ts": 90, "src/b.ts": 80, "src/c.ts": 95 });
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.changed).toBe(1);
		expect(out.details).toEqual(["src/a.ts: lines 40→90"]);
	});

	// test-contract: invariant — the raise test is an OR across lines and
	// branches: a lines-only raise (with branches held at its prior value
	// because it dropped) must still count as raised.
	it("counts a raise driven by lines alone even when branches held (decreased)", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 40, branches_pct: 90 } });
		write(
			"coverage/coverage-summary.json",
			JSON.stringify({
				"src/a.ts": { lines: { pct: 90 }, branches: { pct: 50 }, statements: { pct: 90 }, functions: { pct: 90 } },
			}),
		);
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.changed).toBe(1);
	});

	// test-contract: invariant — a branches-only raise (lines flat) must
	// also count as raised — pins the branches half of the OR independently
	// of the lines half.
	it("counts a raise driven by branches alone when lines are flat", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 90, branches_pct: 40 } });
		writeCoverageReport({ "src/a.ts": 90 }); // both metrics report 90: lines flat, branches raised
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.changed).toBe(1);
	});

	// test-contract: boundary — details must be capped at exactly
	// FOLD_DETAIL_CAP entries (neither uncapped, nor stuck at 0, nor off-by-one
	// at the boundary), each carrying the real formatted message.
	it("caps the raised-file detail list at FOLD_DETAIL_CAP while still counting every raise", () => {
		const total = FOLD_DETAIL_CAP + 1;
		const baselineFiles: Record<string, { lines_pct: number; branches_pct: number }> = {};
		const reportFiles: Record<string, number> = {};
		for (let i = 0; i < total; i++) {
			const rel = `src/f${i}.ts`;
			baselineFiles[rel] = { lines_pct: 10, branches_pct: 10 };
			reportFiles[rel] = 90;
		}
		writeCoverageBaseline(baselineFiles);
		writeCoverageReport(reportFiles);
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.changed).toBe(total);
		expect(out.details.length).toBe(FOLD_DETAIL_CAP);
		expect(out.details[0]).toBe("src/f0.ts: lines 10→90");
	});
});

// ───────────────────────────────────────────────────────────────────
describe("foldCoverage — direct branch and literal pins", () => {
	// test-contract: public-api — with no report on disk AND a sessionStart
	// far in the future, the fold must skip as no-input (the !reportPath
	// guard), never fall through to a stale-report verdict.
	it("with no report on disk, skips as no-input regardless of sessionStart", () => {
		const out = foldCoverage({
			cwd,
			interlinkedDir: join(cwd, ".interlinked"),
			sessionStartMs: 1000,
			dryRun: false,
		});
		expect(out.kind).toBe("coverage");
		expect(out.skipped).toBe("no-input");
	});

	// test-contract: public-api — a report older than both the session and
	// the baseline skips as stale-report with kind still "coverage".
	it("a stale report skips as stale-report with kind coverage", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 40, branches_pct: 40 } });
		writeCoverageReport({ "src/a.ts": 90 }, 1_000_000);
		const out = foldCoverage({
			cwd,
			interlinkedDir: join(cwd, ".interlinked"),
			sessionStartMs: FIXED_SESSION_START_MS,
			dryRun: false,
		});
		expect(out.kind).toBe("coverage");
		expect(out.skipped).toBe("stale-report");
	});

	// test-contract: boundary — a report that fails to parse must be
	// treated as no-input (the !summary guard), never handed to
	// compareCoverage where Object.entries(null) would throw.
	it("a report that fails to parse is treated as no-input, not crashed through", () => {
		write("coverage/coverage-summary.json", "{not valid json");
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.skipped).toBe("no-input");
		expect(out.changed).toBe(0);
	});

	// test-contract: public-api — a genuinely partial report (>=20
	// well-covered baseline files, >=25% now reading exactly 0%) must skip as
	// partial-report, never fall through to a silent no-change.
	it("a genuinely partial report skips as partial-report, not silently folded as no-change", () => {
		const baselineFiles: Record<string, { lines_pct: number; branches_pct: number }> = {};
		const reportFiles: Record<string, number> = {};
		for (let i = 0; i < 20; i++) {
			const rel = `src/wc${i}.ts`;
			baselineFiles[rel] = { lines_pct: 80, branches_pct: 80 };
			reportFiles[rel] = i < 5 ? 0 : 80; // 5/20 = 25% zeroed, at the threshold
		}
		writeCoverageBaseline(baselineFiles);
		writeCoverageReport(reportFiles);
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.kind).toBe("coverage");
		expect(out.skipped).toBe("partial-report");
	});

	// test-contract: public-api — flat coverage (nothing raised) must skip
	// as no-change with kind coverage, never fall through to a null-skip
	// success shape.
	it("flat coverage skips as no-change with kind coverage", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 90, branches_pct: 90 } });
		writeCoverageReport({ "src/a.ts": 90 });
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.kind).toBe("coverage");
		expect(out.skipped).toBe("no-change");
		expect(out.changed).toBe(0);
	});

	// test-contract: public-api — a genuine raise returns kind "coverage"
	// with skipped null on the final success path.
	it("a successful fold returns kind coverage with skipped null", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 40, branches_pct: 40 } });
		writeCoverageReport({ "src/a.ts": 90 });
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.kind).toBe("coverage");
		expect(out.skipped).toBeNull();
		expect(out.changed).toBe(1);
	});
});

// ───────────────────────────────────────────────────────────────────
describe("planExemptionDrops — recorded-only removal", () => {
	// test-contract: invariant — a touched file that is NOT in the
	// recorded exemption set must never land in `dropped`, even if it has a
	// test — the `!files.has(rel)` guard must fire before the hasTest check.
	it("never marks a not-yet-recorded file as dropped, even if it has a test", () => {
		const plan = planExemptionDrops({
			baseline: { version: 1, min_coverage_pct: 60, files: new Set(["x.ts"]) },
			touched: ["brand-new.ts"],
			hasTest: () => true,
		});
		expect(plan.dropped).toEqual([]);
		expect(plan.files.has("brand-new.ts")).toBe(false);
	});

	// test-contract: boundary — untracked touched paths must not reach hasTest.
	it("skips a genuinely untracked file without crashing when hasTest is never reached", () => {
		const plan = planExemptionDrops({
			baseline: { version: 1, min_coverage_pct: 60, files: new Set(["x.ts", "y.ts"]) },
			touched: ["x.ts", "untracked.ts", "y.ts"],
			hasTest: (rel) => rel !== "y.ts",
		});
		expect(plan.dropped).toEqual(["x.ts"]);
		expect([...plan.files]).toEqual(["y.ts"]);
	});
});

describe("foldUntestedFiles — direct branch and literal pins", () => {
	// test-contract: public-api — an empty touched list skips as no-input
	// with kind untested_files.
	it("an empty touched list skips as no-input with kind untested_files", () => {
		const out = foldUntestedFiles({ cwd, touched: [], dryRun: false });
		expect(out.kind).toBe("untested_files");
		expect(out.skipped).toBe("no-input");
	});

	// test-contract: public-api — with no baseline file on disk, skips as
	// no-baseline with kind untested_files.
	it("no baseline file on disk skips as no-baseline with kind untested_files", () => {
		write("src/a.ts", "export const a = 1;\n");
		const out = foldUntestedFiles({ cwd, touched: ["src/a.ts"], dryRun: false });
		expect(out.kind).toBe("untested_files");
		expect(out.skipped).toBe("no-baseline");
	});

	// test-contract: public-api — a touched-but-still-untested file skips
	// as no-change with kind untested_files.
	it("a touched file with no companion test skips as no-change with kind untested_files", () => {
		writeUntestedBaseline(["src/a.ts"]);
		write("src/a.ts", "export const a = 1;\n");
		const out = foldUntestedFiles({ cwd, touched: ["src/a.ts"], dryRun: false });
		expect(out.kind).toBe("untested_files");
		expect(out.skipped).toBe("no-change");
	});

	// test-contract: boundary — the success-path detail list must be
	// capped at FOLD_DETAIL_CAP even when more files were exempted.
	it("caps the untested-files detail list at FOLD_DETAIL_CAP even when more files were exempted", () => {
		const total = FOLD_DETAIL_CAP + 1;
		const files: string[] = [];
		for (let i = 0; i < total; i++) {
			const rel = `src/u${i}.ts`;
			files.push(rel);
			write(rel, "export const x = 1;\n");
			write(rel.replace(/\.ts$/, ".test.ts"), "it('x', () => {});\n");
		}
		writeUntestedBaseline(files);
		const out = foldUntestedFiles({ cwd, touched: files, dryRun: false });
		expect(out.changed).toBe(total);
		expect(out.details.length).toBe(FOLD_DETAIL_CAP);
	});
});

// ───────────────────────────────────────────────────────────────────
describe("planGrandfatherShrink — cap-boundary arithmetic", () => {
	// test-contract: invariant — a NEW (unrecorded) touched file that is
	// under the cap must never be counted as refused.
	it("a new touched file under the cap is never counted as refused", () => {
		const plan = planGrandfatherShrink({
			baseline: { version: 1, max_lines: 100, files: {} },
			touched: ["fresh.ts"],
			lineCountOf: () => 10,
		});
		expect(plan.refused).toBe(0);
		expect(plan.files).toEqual({});
	});

	// test-contract: boundary — a NEW touched file exactly AT the cap is
	// not refused — only strictly-over-cap counts (`>`, not `>=`).
	it("a new touched file exactly at the cap is not refused", () => {
		const plan = planGrandfatherShrink({
			baseline: { version: 1, max_lines: 100, files: {} },
			touched: ["at-cap.ts"],
			lineCountOf: () => 100,
		});
		expect(plan.refused).toBe(0);
	});

	// test-contract: boundary — a recorded file that shrinks to EXACTLY
	// the cap is dropped (`<=`), not left in the tightened bucket (`<`).
	it("a recorded file that shrinks to exactly the cap is dropped, not merely tightened", () => {
		const plan = planGrandfatherShrink({
			baseline: { version: 1, max_lines: 100, files: { "big.ts": 150 } },
			touched: ["big.ts"],
			lineCountOf: () => 100,
		});
		expect(plan.dropped).toEqual(["big.ts: 150→under cap (100)"]);
		expect(plan.tightened).toEqual([]);
		expect(plan.files["big.ts"]).toBeUndefined();
	});

	// test-contract: boundary — a recorded over-cap file whose count is
	// UNCHANGED must be neither dropped nor tightened (`<`, not `<=`, against
	// the prior recorded count).
	it("a recorded over-cap file whose count is unchanged is neither dropped nor tightened", () => {
		const plan = planGrandfatherShrink({
			baseline: { version: 1, max_lines: 10, files: { "big.ts": 150 } },
			touched: ["big.ts"],
			lineCountOf: () => 150,
		});
		expect(plan.tightened).toEqual([]);
		expect(plan.dropped).toEqual([]);
		expect(plan.files["big.ts"]).toBe(150);
	});

	// test-contract: public-api — a genuine tighten (smaller, still over
	// cap) records the exact before→after message and the lowered count.
	it("a genuine tighten records the exact before/after message", () => {
		const plan = planGrandfatherShrink({
			baseline: { version: 1, max_lines: 10, files: { "big.ts": 150 } },
			touched: ["big.ts"],
			lineCountOf: () => 100,
		});
		expect(plan.tightened).toEqual(["big.ts: 150→100"]);
		expect(plan.files["big.ts"]).toBe(100);
	});
});

describe("foldLargeFiles — direct branch and literal pins", () => {
	// test-contract: public-api — an empty touched list skips as no-input
	// with kind large_files, never falling through to no-baseline.
	it("an empty touched list skips as no-input with kind large_files", () => {
		const out = foldLargeFiles({ cwd, touched: [], dryRun: false });
		expect(out.kind).toBe("large_files");
		expect(out.skipped).toBe("no-input");
	});

	// test-contract: public-api — with no baseline file on disk, skips as
	// no-baseline with kind large_files.
	it("no baseline file on disk skips as no-baseline with kind large_files", () => {
		write("src/a.ts", "a\n");
		const out = foldLargeFiles({ cwd, touched: ["src/a.ts"], dryRun: false });
		expect(out.kind).toBe("large_files");
		expect(out.skipped).toBe("no-baseline");
	});

	// test-contract: invariant — `changed` sums dropped.length AND
	// tightened.length (not their difference) — one file drops, another only
	// tightens, and both must add.
	it("changed sums drops and tightenings, not their difference", () => {
		writeLargeFileBaseline(10, { "src/drop.ts": 40, "src/tighten.ts": 40 });
		write("src/drop.ts", "a\n".repeat(3)); // countLines 4 — now under cap(10) -> drop
		write("src/tighten.ts", "a\n".repeat(20)); // countLines 21 — smaller but still over cap -> tighten
		const out = foldLargeFiles({ cwd, touched: ["src/drop.ts", "src/tighten.ts"], dryRun: false });
		expect(out.changed).toBe(2);
		expect(out.skipped).toBeNull();
	});

	// test-contract: public-api — a touched file that is unreadable /
	// missing (lineCountOf null) skips as no-change with kind large_files.
	it("a missing touched file skips as no-change with kind large_files", () => {
		writeLargeFileBaseline(10, { "src/gone.ts": 40 });
		const out = foldLargeFiles({ cwd, touched: ["src/gone.ts"], dryRun: false });
		expect(out.kind).toBe("large_files");
		expect(out.skipped).toBe("no-change");
	});

	// test-contract: public-api — a genuine shrink-under-cap returns kind
	// large_files with skipped null on the final success path.
	it("a successful fold returns kind large_files with skipped null", () => {
		writeLargeFileBaseline(10, { "src/big.ts": 40 });
		write("src/big.ts", "a\n".repeat(3)); // countLines 4, under cap
		const out = foldLargeFiles({ cwd, touched: ["src/big.ts"], dryRun: false });
		expect(out.kind).toBe("large_files");
		expect(out.skipped).toBeNull();
		expect(out.changed).toBe(1);
	});

	// test-contract: boundary — the success-path detail list must be
	// capped at FOLD_DETAIL_CAP even when more files changed.
	it("caps the large-files detail list at FOLD_DETAIL_CAP even when more files changed", () => {
		const total = FOLD_DETAIL_CAP + 1;
		const baselineFiles: Record<string, number> = {};
		const touched: string[] = [];
		for (let i = 0; i < total; i++) {
			const rel = `src/big${i}.ts`;
			baselineFiles[rel] = 40;
			write(rel, "a\n".repeat(3)); // under cap -> drop
			touched.push(rel);
		}
		writeLargeFileBaseline(10, baselineFiles);
		const out = foldLargeFiles({ cwd, touched, dryRun: false });
		expect(out.changed).toBe(total);
		expect(out.details.length).toBe(FOLD_DETAIL_CAP);
	});
});

// ───────────────────────────────────────────────────────────────────
describe("toRepoRelative — defensive normalization", () => {
	// test-contract: boundary — a literal backslash in a resolved
	// relative path is CONVERTED to a forward slash (replacement "/"), not
	// stripped to nothing (replacement "").
	it("converts a literal backslash in a path to a forward slash, not stripping it", () => {
		expect(toRepoRelative("/repo", ["/repo/weird\\name.ts"])).toEqual(["weird/name.ts"]);
	});
});
