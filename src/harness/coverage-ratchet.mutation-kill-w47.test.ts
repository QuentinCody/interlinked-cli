import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compareCoverage,
	type CoverageBaseline,
	type CoverageSummary,
	loadBaseline,
	loadCoverageSummary,
	normalizePath,
	saveBaseline,
} from "./coverage-ratchet.js";
// Wrap readFileSync (only) in a vi.fn so we can assert it was NOT called on a
// missing-path short-circuit — ESM named exports can't be vi.spyOn'd directly
// ("Module namespace is not configurable"), so the wrap has to happen at mock
// time. Every other export forwards to the real implementation unchanged.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const CONFIG = { enabled: true, per_file: true, allow_decrease_pct: 0 };

function makeBaseline(files: CoverageBaseline["files"]): CoverageBaseline {
	return { version: 1, updated_at: new Date(0).toISOString(), files };
}

function metric(pct: number) {
	return { pct };
}

describe("coverage-ratchet mutation kills (w47)", () => {
	let tmpDir: string;

	afterEach(() => {
		if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
	});

	function newTmpDir(): string {
		tmpDir = mkdtempSync(join(tmpdir(), "cov-ratchet-w47-"));
		return tmpDir;
	}

	// --- parseCoverageBaseline (via loadBaseline) ---------------------------

	// test-contract: public-api — loadBaseline() drops malformed per-file entries per parseCoverageBaseline's doc comment
	it("drops a file entry whose branches_pct is not a number (kills 64580344cd5450e8)", () => {
		const dir = newTmpDir();
		writeFileSync(
			join(dir, "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2020-01-01T00:00:00.000Z",
				files: {
					"src/good.ts": { lines_pct: 90, branches_pct: 80 },
					"src/bad.ts": { lines_pct: 90, branches_pct: "not-a-number" },
				},
			}),
			"utf-8",
		);
		const baseline = loadBaseline(dir);
		expect(baseline.files["src/good.ts"]).toEqual({ lines_pct: 90, branches_pct: 80 });
		expect(baseline.files["src/bad.ts"]).toBeUndefined();
	});

	// --- loadBaseline ---------------------------------------------------------

	// test-contract: invariant — loadBaseline() must short-circuit to emptyBaseline() without touching the fs when the path is absent
	it("does not read the file when the baseline path does not exist (kills c677c76f230d3634)", () => {
		const dir = newTmpDir();
		vi.mocked(readFileSync).mockClear();
		const missingPath = join(dir, "coverage-baseline.json");
		expect(existsSync(missingPath)).toBe(false);
		const baseline = loadBaseline(dir);
		expect(baseline.files).toEqual({});
		expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
	});

	// test-contract: public-api — loadBaseline() must read the file as utf-8 text, not binary/invalid encoding
	it("parses a real baseline file correctly using utf-8 (kills 854439ecbc81ddb5)", () => {
		const dir = newTmpDir();
		writeFileSync(
			join(dir, "coverage-baseline.json"),
			JSON.stringify({
				version: 1,
				updated_at: "2020-01-01T00:00:00.000Z",
				files: { "src/a.ts": { lines_pct: 77.5, branches_pct: 33.25 } },
			}),
			"utf-8",
		);
		const baseline = loadBaseline(dir);
		expect(baseline.files["src/a.ts"]).toEqual({ lines_pct: 77.5, branches_pct: 33.25 });
	});

	// --- saveBaseline -----------------------------------------------------

	// test-contract: public-api — saveBaseline() must write valid utf-8 JSON readable back by any consumer
	it("writes a readable utf-8 baseline file (kills 82eb0e7c92ff66d1)", () => {
		const dir = newTmpDir();
		const baseline = makeBaseline({ "src/a.ts": { lines_pct: 50, branches_pct: 40 } });
		expect(() => saveBaseline(dir, baseline)).not.toThrow();
		const raw = readFileSync(join(dir, "coverage-baseline.json"), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.files["src/a.ts"]).toEqual({ lines_pct: 50, branches_pct: 40 });
	});

	// --- loadCoverageSummary -----------------------------------------------

	// test-contract: invariant — loadCoverageSummary() must short-circuit to null without touching the fs when the path is absent
	it("does not read the file when the summary path does not exist (kills ad403b0803dae180)", () => {
		const dir = newTmpDir();
		vi.mocked(readFileSync).mockClear();
		const missingPath = join(dir, "coverage-summary.json");
		expect(existsSync(missingPath)).toBe(false);
		const result = loadCoverageSummary(missingPath);
		expect(result).toBeNull();
		expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
	});

	// test-contract: public-api — loadCoverageSummary() must read the file as utf-8 text
	it("parses a real summary file correctly using utf-8 (kills d955ebd223e3b2d2)", () => {
		const dir = newTmpDir();
		const path = join(dir, "coverage-summary.json");
		writeFileSync(path, JSON.stringify({ "src/a.ts": { lines: metric(80), branches: metric(70) } }), "utf-8");
		const result = loadCoverageSummary(path);
		expect(result).toEqual({ "src/a.ts": { lines: { pct: 80 }, branches: { pct: 70 } } });
	});

	// test-contract: boundary — loadCoverageSummary() rejects a parsed value that is not a keyed object (non-null, non-array by isJsonObject's contract)
	it("rejects a parsed summary that is not an object (kills b325d3150151854c, 03680bba93488847, ce46521fc1e07a45)", () => {
		const dir = newTmpDir();
		const path = join(dir, "coverage-summary.json");
		writeFileSync(path, "5", "utf-8");
		expect(loadCoverageSummary(path)).toBeNull();
	});

	// --- partial report short-circuit stats shape ---------------------------

	// test-contract: public-api — compareCoverage() stats fields must be real zeroed numbers (files_checked etc.), not an object missing keys, on the partial-report short-circuit
	it("returns real zeroed stat fields (not an empty object) on a partial report (kills fd3f04b652d7023b)", () => {
		const baselineFiles: CoverageBaseline["files"] = {};
		const summary: CoverageSummary = {};
		for (let i = 0; i < 20; i++) {
			const path = `src/file${i}.ts`;
			baselineFiles[path] = { lines_pct: 90, branches_pct: 90 };
			summary[path] = { lines: metric(0), branches: metric(0) };
		}
		const baseline = makeBaseline(baselineFiles);
		const result = compareCoverage(summary, baseline, { config: CONFIG, repoRoot: "/repo" });
		expect(result.partialReport?.partial).toBe(true);
		expect(result.stats.files_checked).toBe(0);
		expect(result.stats.files_new).toBe(0);
		expect(result.stats.files_decreased).toBe(0);
		expect(result.stats.files_improved).toBe(0);
	});

	// --- new-file stats -------------------------------------------------------

	it("initializes a partial report with no line metric at zero line coverage", () => {
		const summary: CoverageSummary = { "src/a.ts": { branches: metric(50) } };
		const result = compareCoverage(summary, makeBaseline({}), { config: CONFIG, repoRoot: "/repo" });
		expect(result.nextBaseline.files["src/a.ts"]).toEqual({ lines_pct: 0, branches_pct: 50 });
		expect(result.stats.files_new).toBe(1);
	});

	it("initializes a partial report with no branch metric at zero branch coverage", () => {
		const summary: CoverageSummary = { "src/a.ts": { lines: metric(50) } };
		const result = compareCoverage(summary, makeBaseline({}), { config: CONFIG, repoRoot: "/repo" });
		expect(result.nextBaseline.files["src/a.ts"]).toEqual({ lines_pct: 50, branches_pct: 0 });
		expect(result.stats.files_new).toBe(1);
	});

	// test-contract: public-api — a file with no prior baseline entry counts only as new, never as decreased/improved
	it("does not count a brand-new file as decreased or improved (kills 971c7e8d1ef71ee1, db3811c581ed9b92)", () => {
		const summary: CoverageSummary = { "src/new.ts": { lines: metric(50), branches: metric(50) } };
		const baseline = makeBaseline({});
		const result = compareCoverage(summary, baseline, { config: CONFIG, repoRoot: "/repo" });
		expect(result.stats.files_new).toBe(1);
		expect(result.stats.files_decreased).toBe(0);
		expect(result.stats.files_improved).toBe(0);
	});

	// --- existing-file, no change -------------------------------------------

	// test-contract: public-api — a baseline file re-reported at identical coverage is neither new nor improved
	it("does not count an unchanged existing file as new or improved (kills 9bab58526653ad58, eaf588ba1f693ead, 38615a2a1c209d6d, e59ef1440c83361b, 113955d0dfba44d1, af91679f7b6a7c7e, fee0e083931b8530, bf991a9467e14258)", () => {
		const summary: CoverageSummary = { "src/flat.ts": { lines: metric(50), branches: metric(50) } };
		const baseline = makeBaseline({ "src/flat.ts": { lines_pct: 50, branches_pct: 50 } });
		const result = compareCoverage(summary, baseline, { config: CONFIG, repoRoot: "/repo" });
		expect(result.stats.files_new).toBe(0);
		expect(result.stats.files_improved).toBe(0);
	});

	// --- lines-only increase --------------------------------------------------

	// test-contract: public-api — a strict lines-pct rise alone (branches flat) must count the file as improved
	it("counts a lines-only improvement as improved (kills 83f46ae3496f163b, 8d6394d952b7c43e, bf991a9467e14258)", () => {
		const summary: CoverageSummary = { "src/up.ts": { lines: metric(60), branches: metric(50) } };
		const baseline = makeBaseline({ "src/up.ts": { lines_pct: 50, branches_pct: 50 } });
		const result = compareCoverage(summary, baseline, { config: CONFIG, repoRoot: "/repo" });
		expect(result.stats.files_improved).toBe(1);
	});

	// --- branches-only increase -------------------------------------------

	// test-contract: public-api — a strict branches-pct rise alone (lines flat) must count the file as improved
	it("counts a branches-only improvement as improved (kills 318c6dbaf9d6d8d0, 113955d0dfba44d1, af91679f7b6a7c7e)", () => {
		const summary: CoverageSummary = { "src/up2.ts": { lines: metric(50), branches: metric(60) } };
		const baseline = makeBaseline({ "src/up2.ts": { lines_pct: 50, branches_pct: 50 } });
		const result = compareCoverage(summary, baseline, { config: CONFIG, repoRoot: "/repo" });
		expect(result.stats.files_improved).toBe(1);
	});

	// --- decrease keeps the high-water mark ---------------------------------

	// test-contract: invariant — per the module doc, a decreased metric must persist the PRIOR (high-water) value into nextBaseline, not the dropped current value
	it("keeps the prior (high-water) branches_pct after a real decrease (kills 7eb18053776f1b32)", () => {
		const summary: CoverageSummary = { "src/down.ts": { lines: metric(50), branches: metric(20) } };
		const baseline = makeBaseline({ "src/down.ts": { lines_pct: 50, branches_pct: 80 } });
		const result = compareCoverage(summary, baseline, { config: CONFIG, repoRoot: "/repo" });
		expect(result.findings.some((f) => f.metric === "branches")).toBe(true);
		expect(result.nextBaseline.files["src/down.ts"]?.branches_pct).toBe(80);
	});

	// --- compareCoverage main loop ------------------------------------------

	// test-contract: public-api — compareCoverage()'s changedFiles scoping must still carry forward unrelated baseline entries into nextBaseline unchanged
	it("preserves an untouched baseline entry when changedFiles filters it out (kills 2353b0acc0931362)", () => {
		const summary: CoverageSummary = {
			"src/touched.ts": { lines: metric(50), branches: metric(50) },
			"src/untouched.ts": { lines: metric(10), branches: metric(10) },
		};
		const baseline = makeBaseline({
			"src/touched.ts": { lines_pct: 50, branches_pct: 50 },
			"src/untouched.ts": { lines_pct: 90, branches_pct: 90 },
		});
		const result = compareCoverage(summary, baseline, {
			config: CONFIG,
			repoRoot: "/repo",
			changedFiles: ["src/touched.ts"],
		});
		expect(result.nextBaseline.files["src/untouched.ts"]).toEqual({ lines_pct: 90, branches_pct: 90 });
	});

	// --- buildFinding ---------------------------------------------------------

	// test-contract: public-api — a real coverage_decrease finding must carry name "coverage_decrease", severity "warning", and a human-readable message naming the file
	it("builds a coverage_decrease/warning finding with a real message (kills 9598192af478f4e2, 1d041f59eae618cf, 0edba582d9d278a7)", () => {
		const summary: CoverageSummary = { "src/regress.ts": { lines: metric(50), branches: metric(50) } };
		const baseline = makeBaseline({ "src/regress.ts": { lines_pct: 90, branches_pct: 90 } });
		const result = compareCoverage(summary, baseline, { config: CONFIG, repoRoot: "/repo" });
		expect(result.findings).toHaveLength(2);
		const finding = result.findings[0];
		expect(finding?.name).toBe("coverage_decrease");
		expect(finding?.severity).toBe("warning");
		expect(finding?.message).toContain("src/regress.ts");
		expect(finding?.message).toContain("Add tests before committing.");
	});

	// --- normalizePath ---------------------------------------------------------

	// test-contract: public-api — normalizePath() must reject the synthetic "total" aggregate key per its doc comment
	it('rejects the synthetic "total" key (kills 8145b23b8472b626, a132bfd8acafd69f, 15d24b2bd6ce31a0, 9e2f09d96e22e49f)', () => {
		expect(normalizePath("total", "/repo")).toBeNull();
	});

	// test-contract: public-api — normalizePath() must translate backslash separators to forward slashes in its result
	it("replaces backslashes with forward slashes (kills f871f02cd07e4157)", () => {
		expect(normalizePath("a\\b.ts", "/repo")).toBe("a/b.ts");
	});

	// test-contract: boundary — normalizePath() must reject a path that resolves to the repo root itself (empty relative path)
	it("rejects a path that resolves to the repo root itself (kills cf038dcc3614aae4, ad0735b8dafc775c)", () => {
		expect(normalizePath("/repo", "/repo")).toBeNull();
	});
});
