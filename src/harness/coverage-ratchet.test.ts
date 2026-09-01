import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../lib/non-null.js";
import type { CoverageRatchetConfig } from "./check-policy.js";
import {
	baselinePath,
	type CoverageBaseline,
	type CoverageSummary,
	compareCoverage,
	detectPartialReport,
	emptyBaseline,
	loadBaseline,
	loadCoverageSummary,
	normalizeReportPct,
	PARTIAL_REPORT_MIN_COMPARABLE_FILES,
	saveBaseline,
} from "./coverage-ratchet.js";

const STRICT_CONFIG: CoverageRatchetConfig = {
	enabled: true,
	per_file: true,
	allow_decrease_pct: 0,
};

function mkSummary(entries: Record<string, { lines: number; branches: number }>): CoverageSummary {
	const summary: CoverageSummary = {};
	for (const [path, { lines, branches }] of Object.entries(entries)) {
		summary[path] = {
			lines: { pct: lines },
			branches: { pct: branches },
		};
	}
	return summary;
}

describe("emptyBaseline", () => {
	it("has version 1 and empty files map", () => {
		const b = emptyBaseline();
		expect(b.version).toBe(1);
		expect(b.files).toEqual({});
	});
});

describe("loadBaseline / saveBaseline round trip", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-ratchet-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns an empty baseline when no file exists", () => {
		const b = loadBaseline(tmp);
		expect(b.files).toEqual({});
	});

	it("writes and reads a baseline", () => {
		const b: CoverageBaseline = {
			version: 1,
			updated_at: "2026-04-22T00:00:00Z",
			files: { "src/foo.ts": { lines_pct: 80, branches_pct: 60 } },
		};
		saveBaseline(tmp, b);
		expect(loadBaseline(tmp)).toEqual(b);
	});

	it("gracefully handles a malformed baseline file", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(baselinePath(tmp), "{ not json", "utf-8");
		expect(loadBaseline(tmp).files).toEqual({});
	});

	it("creates the directory when saving into a nonexistent one", () => {
		const deep = join(tmp, ".interlinked", "nested");
		const b = emptyBaseline();
		saveBaseline(deep, b);
		expect(JSON.parse(readFileSync(baselinePath(deep), "utf-8")).version).toBe(1);
	});

	it("N1: drops a malformed individual file entry but keeps valid ones", () => {
		// Pre-fix, `raw as CoverageBaseline` trusted every per-file entry
		// unchecked — a corrupted or hand-edited entry for one file would have
		// silently propagated a non-numeric pct into the ratchet comparison
		// instead of just losing that one file's high-water mark.
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({
				version: 1,
				updated_at: "2026-04-22T00:00:00Z",
				files: {
					"src/good.ts": { lines_pct: 80, branches_pct: 60 },
					"src/bad.ts": { lines_pct: "not-a-number", branches_pct: 60 },
				},
			}),
			"utf-8",
		);
		const result = loadBaseline(tmp);
		expect(result.files).toEqual({ "src/good.ts": { lines_pct: 80, branches_pct: 60 } });
		expect(result.files["src/bad.ts"]).toBeUndefined();
	});

	it("N2: rejects the whole baseline when files is an array instead of a record", () => {
		// Pre-fix, the guard was `!raw.files` — a truthy check. An array is
		// truthy, so it sailed straight through to `raw as CoverageBaseline`
		// with `.files` actually holding an array, not a Record.
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({ version: 1, updated_at: "x", files: ["not", "a", "record"] }),
			"utf-8",
		);
		expect(loadBaseline(tmp)).toEqual(emptyBaseline());
	});

	it("P1: defaults updated_at when missing, keeping valid file entries", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({ version: 1, files: { "src/foo.ts": { lines_pct: 75, branches_pct: 50 } } }),
			"utf-8",
		);
		const result = loadBaseline(tmp);
		expect(result.files).toEqual({ "src/foo.ts": { lines_pct: 75, branches_pct: 50 } });
		expect(typeof result.updated_at).toBe("string");
	});

	it("N3: rejects the whole baseline when version is not 1, even though files is otherwise well-formed", () => {
		// A version mismatch must reject the WHOLE file (per the module doc:
		// "Rejects the whole file for an invalid top-level shape") — a future
		// incompatible baseline format must not be silently read as today's.
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({
				version: 2,
				updated_at: "2026-01-01",
				files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
			}),
			"utf-8",
		);
		expect(loadBaseline(tmp)).toEqual(emptyBaseline());
	});

	it("N5: drops a file entry whose stats value is null, keeping sibling valid entries", () => {
		mkdirSync(tmp, { recursive: true });
		writeFileSync(
			baselinePath(tmp),
			JSON.stringify({
				version: 1,
				updated_at: "2026-01-01",
				files: {
					"src/good.ts": { lines_pct: 80, branches_pct: 60 },
					"src/null-stats.ts": null,
				},
			}),
			"utf-8",
		);
		const result = loadBaseline(tmp);
		expect(result.files).toEqual({ "src/good.ts": { lines_pct: 80, branches_pct: 60 } });
		expect(result.files["src/null-stats.ts"]).toBeUndefined();
	});
});

describe("loadCoverageSummary", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-summary-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("returns null when the file is missing", () => {
		expect(loadCoverageSummary(join(tmp, "nonexistent.json"))).toBeNull();
	});

	it("returns null when JSON is malformed", () => {
		const p = join(tmp, "bad.json");
		writeFileSync(p, "nope", "utf-8");
		expect(loadCoverageSummary(p)).toBeNull();
	});

	it("parses a well-formed summary", () => {
		const p = join(tmp, "summary.json");
		writeFileSync(p, JSON.stringify({ "src/foo.ts": { lines: { pct: 90 } } }));
		const summary = loadCoverageSummary(p);
		expect(nonNull(summary?.["src/foo.ts"]?.lines).pct).toBe(90);
	});
});

describe("compareCoverage — first-run behavior", () => {
	it("treats all files as new when baseline is empty, emits no findings", () => {
		const summary = mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
		expect(res.stats.files_new).toBe(1);
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({ lines_pct: 80, branches_pct: 60 });
	});

	it("skips the synthetic `total` bucket", () => {
		const summary: CoverageSummary = {
			...mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } }),
			total: { lines: { pct: 50 }, branches: { pct: 50 } },
		};
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(1);
		expect(res.nextBaseline.files.total).toBeUndefined();
	});
});

describe("compareCoverage — decrease detection", () => {
	it("flags a decreased per-file lines coverage with strict config", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toHaveLength(1);
		expect(nonNull(res.findings[0]).metric).toBe("lines");
		expect(nonNull(res.findings[0]).baseline_pct).toBe(90);
		expect(nonNull(res.findings[0]).current_pct).toBe(80);
		expect(nonNull(res.findings[0]).delta_pct).toBe(-10);
	});

	it("flags both lines and branches when both drop", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 70 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 85, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		const metrics = res.findings.map((f) => f.metric).sort();
		expect(metrics).toEqual(["branches", "lines"]);
		expect(res.stats.files_decreased).toBe(1);
	});

	it("respects allow_decrease_pct tolerance", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 88, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: { enabled: true, per_file: true, allow_decrease_pct: 5 },
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
	});
});

describe("compareCoverage — baseline advancement", () => {
	it("advances the baseline when coverage improves", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 70, branches_pct: 50 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 85, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({
			lines_pct: 85,
			branches_pct: 60,
		});
		expect(res.stats.files_improved).toBe(1);
	});

	it("preserves the high-water mark when coverage decreases", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90, branches_pct: 60 } },
		};
		const summary = mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		// The lines metric decreased — baseline stays at 90, not lowered.
		expect(res.nextBaseline.files["src/foo.ts"]).toEqual({
			lines_pct: 90,
			branches_pct: 60,
		});
	});
});

describe("normalizeReportPct", () => {
	it("floors to 2 decimal places, matching the real coverage-summary.json examples", () => {
		// Real values pulled from this repo's baseline vs report mismatch.
		expect(normalizeReportPct(98.9795918367347)).toBe(98.97);
		expect(normalizeReportPct(94.73684210526315)).toBe(94.73);
		expect(normalizeReportPct(98.68421052631578)).toBe(98.68);
	});

	it("does not round up — a value just under the next 2dp step stays down", () => {
		expect(normalizeReportPct(99.999)).toBe(99.99);
	});

	it("leaves an exact 2dp value unchanged", () => {
		expect(normalizeReportPct(98.97)).toBe(98.97);
		expect(normalizeReportPct(100)).toBe(100);
	});
});

describe("compareCoverage — precision normalization (phantom-drop fix)", () => {
	it("(a) a full-precision baseline vs a 2dp report shows NO regression when the underlying ratio is unchanged", () => {
		// This is the exact shape of the bug: baseline stored via the LCOV path
		// at full float precision; the report floors to 2dp. 98.9795918367347
		// floors to 98.97 — the same number the report states.
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/commands/activity.ts": { lines_pct: 90, branches_pct: 98.9795918367347 } },
		};
		const summary = mkSummary({
			"src/commands/activity.ts": { lines: 90, branches: 98.97 },
		});
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG, // allow_decrease_pct: 0 — the strictest possible tolerance
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
		expect(res.stats.files_decreased).toBe(0);
	});

	it("(b) a genuine drop larger than the report's resolution is still reported", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/commands/activity.ts": { lines_pct: 90, branches_pct: 98.9795918367347 } },
		};
		// A real regression: branches actually fell from ~98.98% to 95.5%.
		const summary = mkSummary({
			"src/commands/activity.ts": { lines: 90, branches: 95.5 },
		});
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toHaveLength(1);
		expect(nonNull(res.findings[0]).metric).toBe("branches");
		// buildFinding rounds the DISPLAYED value to 1dp — 98.97 (the normalized
		// baseline) rounds to 99 for display; the decision itself already ran on
		// the full 2dp-normalized delta above.
		expect(nonNull(res.findings[0]).baseline_pct).toBe(99);
		expect(nonNull(res.findings[0]).current_pct).toBe(95.5);
		expect(nonNull(res.findings[0]).delta_pct).toBeLessThan(-3);
	});

	it("(c) allow_decrease_pct still tolerates a genuine drop within the configured budget, on top of normalization", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: { "src/foo.ts": { lines_pct: 90.129384, branches_pct: 60 } },
		};
		// A real ~0.33pp drop (90.12 -> 89.8) that survives normalization intact.
		const summary = mkSummary({ "src/foo.ts": { lines: 89.8, branches: 60 } });

		const strict = compareCoverage(summary, baseline, {
			config: { enabled: true, per_file: true, allow_decrease_pct: 0 },
			repoRoot: "/repo",
		});
		expect(strict.findings).toHaveLength(1); // tolerance 0 still catches the real drop

		const tolerant = compareCoverage(summary, baseline, {
			config: { enabled: true, per_file: true, allow_decrease_pct: 0.5 },
			repoRoot: "/repo",
		});
		expect(tolerant.findings).toEqual([]); // tolerance 0.5 absorbs the 0.32pp drop
	});

});

describe("compareCoverage — precision normalization: old-format baseline from disk", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "cov-ratchet-oldformat-"));
		const onDisk: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01T00:00:00Z",
			files: {
				"src/commands/allowlist.ts": { lines_pct: 94.73684210526315, branches_pct: 100 },
				"src/commands/attach.ts": { lines_pct: 100, branches_pct: 98.68421052631578 },
			},
		};
		saveBaseline(tmp, onDisk);
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("(d) loads the old full-precision baseline unchanged", () => {
		const loaded = loadBaseline(tmp);
		// Loading itself is unaffected by the fix; only the comparison normalizes.
		expect(loaded.files["src/commands/allowlist.ts"]?.lines_pct).toBe(94.73684210526315);
	});

	it("(d) produces no phantom regression against a floored 2dp report", () => {
		const loaded = loadBaseline(tmp);
		const summary = mkSummary({
			"src/commands/allowlist.ts": { lines: 94.73, branches: 100 },
			"src/commands/attach.ts": { lines: 100, branches: 98.68 },
		});
		const res = compareCoverage(summary, loaded, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
		// Persisted forward at the normalized (floored) resolution, so the
		// mismatch cannot reintroduce itself on the next run.
		expect(res.nextBaseline.files["src/commands/allowlist.ts"]).toEqual({
			lines_pct: 94.73,
			branches_pct: 100,
		});
	});
});

describe("compareCoverage — changedFiles filter", () => {
	it("only evaluates paths in the changedFiles allowlist", () => {
		const baseline: CoverageBaseline = {
			version: 1,
			updated_at: "2026-01-01",
			files: {
				"src/foo.ts": { lines_pct: 90, branches_pct: 60 },
				"src/bar.ts": { lines_pct: 90, branches_pct: 60 },
			},
		};
		const summary = mkSummary({
			"src/foo.ts": { lines: 50, branches: 50 },
			"src/bar.ts": { lines: 50, branches: 50 },
		});
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
			changedFiles: ["src/foo.ts"],
		});
		expect(res.stats.files_checked).toBe(1);
		expect(res.findings.every((f) => f.file === "src/foo.ts")).toBe(true);
	});
});

describe("compareCoverage — path normalization", () => {
	it("normalizes absolute paths to repo-relative", () => {
		const summary = mkSummary({ "/repo/src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.nextBaseline.files["src/foo.ts"]).toBeDefined();
	});

	it("rejects paths that fall outside repoRoot", () => {
		const summary = mkSummary({ "/other/project/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.stats.files_checked).toBe(0);
	});
});

// ===========================================
// detectPartialReport — scoped-run detection
// ===========================================
// Regression coverage for the 2026-07-31 finding: `npx vitest run --coverage
// <a few files>` still lists every file in coverage-summary.json (vitest's
// `coverage.all: true`), so unexercised files read as an honest `{ pct: 0 }`.
// Fed straight into compareCoverage this used to read as a mass regression
// (3748 spurious findings measured in this repo). detectPartialReport must
// recognize that shape and compareCoverage must fail to UNMEASURED, never to
// REGRESSED.

/** A baseline with `n` well-covered files (90% lines / 80% branches — both
 *  comfortably above PARTIAL_REPORT_WELL_COVERED_BASELINE_PCT), plus any
 *  `extra` entries the caller wants to add (e.g. below-threshold files that
 *  must NOT count toward the signal). */
function mkWellCoveredBaseline(
	n: number,
	extra: CoverageBaseline["files"] = {},
): CoverageBaseline {
	const files: CoverageBaseline["files"] = { ...extra };
	for (let i = 0; i < n; i++) {
		files[`src/well${i}.ts`] = { lines_pct: 90, branches_pct: 80 };
	}
	return { version: 1, updated_at: "2026-01-01", files };
}

/** A summary matching `mkWellCoveredBaseline(n, ...)`'s files: the first
 *  `zeroedCount` read as exactly 0/0 (the scoped-run shape), the rest hold at
 *  the baseline's own values (so they never register as a regression on
 *  their own). */
function mkSummaryZeroing(n: number, zeroedCount: number): CoverageSummary {
	const entries: Record<string, { lines: number; branches: number }> = {};
	for (let i = 0; i < n; i++) {
		entries[`src/well${i}.ts`] = i < zeroedCount ? { lines: 0, branches: 0 } : { lines: 90, branches: 80 };
	}
	return mkSummary(entries);
}

describe("detectPartialReport", () => {
	it("(scoped run) many previously well-covered files reading as exactly 0 => partial", () => {
		const baseline = mkWellCoveredBaseline(30);
		const summary = mkSummaryZeroing(30, 25); // 25/30 = 83% zeroed, well over the 25% threshold
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.partial).toBe(true);
		expect(verdict.comparable).toBe(30);
		expect(verdict.zeroed).toBe(25);
		expect(verdict.reason).toContain("scoped");
	});

	it("(real regression) a single file drops without the rest zeroing => NOT partial", () => {
		const baseline = mkWellCoveredBaseline(25);
		const summary = mkSummaryZeroing(25, 0);
		// A genuine partial regression (40%, not zero) on one file only.
		summary["src/well0.ts"] = { lines: { pct: 40 }, branches: { pct: 80 } };
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.partial).toBe(false);
		expect(verdict.zeroed).toBe(0);
	});

	it("(small baseline) below the minimum-comparable-files guard, even 100% zeroed => never partial", () => {
		const n = PARTIAL_REPORT_MIN_COMPARABLE_FILES - 1; // one short of the guard
		const baseline = mkWellCoveredBaseline(n);
		const summary = mkSummaryZeroing(n, n); // every single one reads as 0
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.partial).toBe(false);
		expect(verdict.comparable).toBe(n);
		expect(verdict.zeroed).toBe(n);
		expect(verdict.reason).toContain("too few");
	});

	it("(legit zero) one genuinely-zeroed file among many healthy ones => NOT partial", () => {
		const baseline = mkWellCoveredBaseline(25);
		const summary = mkSummaryZeroing(25, 1); // 1/25 = 4%, far under the 25% threshold
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.partial).toBe(false);
		expect(verdict.zeroed).toBe(1);
		expect(verdict.comparable).toBe(25);
	});

	it("does not judge on files missing from the current report entirely (a different signal)", () => {
		// The baseline has well-covered files the CURRENT report doesn't mention
		// at all (e.g. deleted, or a report scoped by file selection rather than
		// `all: true`). Those aren't "zeroed" — they're simply absent, so they
		// must not inflate the `comparable` denominator or the zeroed count.
		const baseline = mkWellCoveredBaseline(25);
		const summary = mkSummary(
			Object.fromEntries(
				Array.from({ length: 5 }, (_, i) => [`src/well${i}.ts`, { lines: 90, branches: 80 }]),
			),
		);
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.comparable).toBe(5);
		expect(verdict.zeroed).toBe(0);
		expect(verdict.partial).toBe(false); // below the min-comparable-files guard too
	});

	it("boundary: exactly at the minimum-comparable-files guard judges normally", () => {
		const n = PARTIAL_REPORT_MIN_COMPARABLE_FILES;
		const baseline = mkWellCoveredBaseline(n);
		const summary = mkSummaryZeroing(n, n); // 100% zeroed, guard now satisfied
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.comparable).toBe(n);
		expect(verdict.partial).toBe(true);
	});

	it("boundary: ratio exactly at the 25% threshold counts as partial (>=, not >)", () => {
		const baseline = mkWellCoveredBaseline(20);
		const summary = mkSummaryZeroing(20, 5); // exactly 5/20 = 25%
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.partial).toBe(true);
	});

	it("boundary: just under the 25% threshold is NOT partial", () => {
		const baseline = mkWellCoveredBaseline(20);
		const summary = mkSummaryZeroing(20, 4); // 4/20 = 20%, under the threshold
		const verdict = detectPartialReport(summary, baseline, "/repo");
		expect(verdict.partial).toBe(false);
	});

	it("a fresh (empty) baseline never trips the signal — nothing is comparable yet", () => {
		const summary = mkSummaryZeroing(100, 100);
		const verdict = detectPartialReport(summary, emptyBaseline(), "/repo");
		expect(verdict.comparable).toBe(0);
		expect(verdict.partial).toBe(false);
	});
});

describe("compareCoverage — partial-report wiring", () => {
	it("a scoped-run report yields NO findings, even though every file would otherwise regress", () => {
		const baseline = mkWellCoveredBaseline(30);
		const summary = mkSummaryZeroing(30, 30); // every comparable file reads as 0
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.findings).toEqual([]);
		expect(res.partialReport?.partial).toBe(true);
	});

	it("never persists a baseline derived from a partial report — nextBaseline is the INPUT baseline, unchanged", () => {
		const baseline = mkWellCoveredBaseline(30);
		const summary = mkSummaryZeroing(30, 30);
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		// Same object — not a clone, not a re-derived value — so a caller that
		// unconditionally calls `saveBaseline(configDir, result.nextBaseline)`
		// (as `--update-baseline` does) writes back exactly what was already
		// on disk. A partial report can never lower OR corrupt the baseline.
		expect(res.nextBaseline).toBe(baseline);
	});

	it("a real single-file regression alongside many healthy files still surfaces normally (not treated as partial)", () => {
		const baseline = mkWellCoveredBaseline(25);
		const summary = mkSummaryZeroing(25, 0);
		summary["src/well0.ts"] = { lines: { pct: 40 }, branches: { pct: 80 } };
		const res = compareCoverage(summary, baseline, {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.partialReport?.partial).toBe(false);
		expect(res.findings).toHaveLength(1);
		expect(res.findings[0]?.file).toBe("src/well0.ts");
	});

	it("surfaces a non-partial verdict on every normal run too (not just when partial)", () => {
		const summary = mkSummary({ "src/foo.ts": { lines: 80, branches: 60 } });
		const res = compareCoverage(summary, emptyBaseline(), {
			config: STRICT_CONFIG,
			repoRoot: "/repo",
		});
		expect(res.partialReport?.partial).toBe(false);
	});
});
