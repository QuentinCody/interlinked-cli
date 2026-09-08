// ===========================================
// interlinked metrics — coverage-report loading
// ===========================================
// Coverage is OPTIONAL and language-agnostic: it loads istanbul
// `coverage-final.json` AND the canonical LCOV spine (`coverage/lcov.info`)
// the per-language adapters emit (coverage.py, cargo-llvm-cov, vitest's lcov
// reporter, …), MERGING them when both exist — per-file lookups prefer the
// fresher report and fall back to the other (a polyglot repo emits each for a
// different language). When neither exists the scan still reports complexity +
// companion presence and marks coverage/CRAP as unavailable (fail-open, never
// throws).
//
// Split out of `metrics.ts` (2026-09) — this module owns everything about
// locating, loading, and merging coverage reports; `metrics.ts` owns the
// report-building orchestration that consumes it.

import { isAbsolute, join, relative } from "node:path";
import { lcovReportPaths } from "../harness/coverage-adapters.js";
import {
	coverageForFile,
	loadCoverageFinal,
	type PerFileCoverage,
} from "../harness/coverage-final-reader.js";
import {
	canonicalToCoverageSummary,
	loadLcovFile,
	perFileCoverageFromCanonical,
} from "../harness/coverage-lcov.js";
import { type CoverageSummary, loadCoverageSummary } from "../harness/coverage-ratchet.js";
import { reportMtimeMs } from "../lib/report-mtime.js";
import { discoverFiles } from "./verify/file-discovery.js";

/** Source extensions the AST/regex complexity pass + coverage adapters cover. */
const ANALYZABLE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)$/;
const TEST_EXT_RE = /\.(test|spec)\.(?:tsx?|jsx?|mjs|cjs|py|rs|go)$/;

/**
 * Analyzable when the extension is a supported source language, it is not a
 * test / declaration / fixture file, AND it is in scope: either under `src/`
 * (the JS coverage-include convention) or present in the loaded coverage report
 * (so a non-TS language whose sources live outside `src/` — e.g. a Python
 * package — still appears once its LCOV report is generated).
 */
function isAnalyzableSource(rel: string, covered: ReadonlySet<string>): boolean {
	if (!ANALYZABLE_EXT_RE.test(rel)) return false;
	if (/\.d\.ts$/.test(rel)) return false;
	if (TEST_EXT_RE.test(rel)) return false;
	if (/(^|\/)(__tests__|__fixtures__|tests|test)\//.test(rel)) return false;
	return rel.startsWith("src/") || covered.has(rel);
}

/**
 * Per-file line coverage % from a summary whose keys are REPO-RELATIVE (run it
 * through {@link normalizeSummaryKeys} at load). Exact-match only: the old
 * suffix match (`key.endsWith("/" + rel)`) mis-attributed coverage whenever two
 * files shared a path tail — in a monorepo with `src/foo.ts` and
 * `packages/a/src/foo.ts`, the latter's absolute key also ends with
 * `/src/foo.ts`, so iteration order decided which file's number the root file
 * got (finding 2026-06).
 *
 * Module-private: the every-file-tested gate (`tested-file-policy.ts`) reuses
 * this SAME lookup indirectly through `loadMetricsCoverage`'s `linePct`
 * closure — one definition of "what is this file's line coverage", reached
 * without needing this helper itself as public API.
 */
function linePctFor(summary: CoverageSummary | null, rel: string): number | null {
	const entry = summary?.[rel];
	if (!entry) return null;
	return typeof entry.lines?.pct === "number" ? entry.lines.pct : null;
}

/**
 * Re-key a coverage summary onto REPO-RELATIVE POSIX paths, unambiguously: an
 * absolute key becomes `relative(cwd, key)`; a key outside the repo is DROPPED
 * (it cannot correspond to a repo-relative lookup — the old suffix match let it
 * shadow a repo file with the same tail, finding 2026-06). Same convention as
 * the istanbul final reader (`coverage-final-reader.ts::buildPerFileCoverage`).
 * Already-relative keys (LCOV-derived summaries) pass through normalized.
 */
function normalizeSummaryKeys(summary: CoverageSummary | null, cwd: string): CoverageSummary | null {
	if (!summary) return null;
	const out: CoverageSummary = {};
	for (const [key, entry] of Object.entries(summary)) {
		if (!entry) continue;
		if (key === "total") {
			out[key] = entry;
			continue;
		}
		const rel = isAbsolute(key) ? relative(cwd, key) : key;
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
		out[rel.replace(/\\/g, "/")] = entry;
	}
	return out;
}

type FnRange = { name: string; line: number; endLine: number };

/**
 * Unified, language-agnostic coverage accessor. MERGES istanbul
 * `coverage-final.json` (per-statement, JS/TS) with the canonical LCOV spine
 * (per-function derived from line hits + the supplied AST ranges) when BOTH
 * exist — a polyglot repo emits each for a different language, and neither may
 * shadow the other. `available === false` when neither report exists.
 */
export interface MetricsCoverage {
	available: boolean;
	source: "istanbul" | "lcov" | "istanbul+lcov" | null;
	/** Files the report(s) know about, repo-relative — drives non-`src/` inclusion. */
	fileSet: ReadonlySet<string>;
	perFile(rel: string, fnRanges: FnRange[], mtime: number): PerFileCoverage | undefined;
	linePct(rel: string): number | null;
}

/** One loaded report format, with PER-AXIS report mtimes for freshness ordering:
 *  istanbul's per-file data lives in `coverage-final.json` while its line
 *  percentages live in `coverage-summary.json` — two files that can age apart,
 *  so each axis carries the mtime of the file that actually backs it (finding
 *  2026-06: ordering linePct by final.json's mtime let a STALE summary shadow a
 *  fresher LCOV percentage). */
interface CoverageSource {
	kind: "istanbul" | "lcov";
	perFileMtimeMs: number;
	linePctMtimeMs: number;
	fileSet: ReadonlySet<string>;
	perFile: MetricsCoverage["perFile"];
	linePct: MetricsCoverage["linePct"];
}

/** The istanbul `coverage-final.json` report as a CoverageSource, or null. */
function istanbulSource(cwd: string): CoverageSource | null {
	const path = join(cwd, "coverage", "coverage-final.json");
	const finalCov = loadCoverageFinal(path, cwd);
	if (!finalCov) return null;
	const summaryPath = join(cwd, "coverage", "coverage-summary.json");
	// Re-keyed repo-relative so lookups are exact, never suffix-ambiguous
	// (finding 2026-06: monorepo path tails collided).
	const summary = normalizeSummaryKeys(loadCoverageSummary(summaryPath), cwd);
	return {
		kind: "istanbul",
		perFileMtimeMs: reportMtimeMs(path),
		// The linePct axis is backed by the SUMMARY file — its own age decides
		// freshness, not final.json's (finding 2026-06).
		linePctMtimeMs: reportMtimeMs(summaryPath),
		fileSet: new Set(finalCov.keys()),
		perFile: (rel) => coverageForFile(finalCov, rel),
		linePct: (rel) => linePctFor(summary, rel),
	};
}

/**
 * Every existing LCOV report as its own CoverageSource — the canonical
 * aggregate path plus each adapter's PER-LANGUAGE report (finding 2026-06: the
 * adapters once shared one output path and clobbered each other; now each
 * report loads separately and the merge arbitrates per file by freshness).
 */
function lcovSources(cwd: string): CoverageSource[] {
	const sources: CoverageSource[] = [];
	for (const relPath of lcovReportPaths()) {
		const path = join(cwd, relPath);
		const lcov = loadLcovFile(path, { cwd });
		if (!lcov) continue;
		const summary = canonicalToCoverageSummary(lcov);
		const mtime = reportMtimeMs(path);
		sources.push({
			kind: "lcov",
			perFileMtimeMs: mtime,
			linePctMtimeMs: mtime, // both axes derive from the one .info file
			fileSet: new Set(lcov.files.keys()),
			perFile: (rel, fnRanges, mtime2) => {
				const cf = lcov.files.get(rel);
				return cf ? perFileCoverageFromCanonical(cf, rel, mtime2, fnRanges) : undefined;
			},
			linePct: (rel) => linePctFor(summary, rel),
		});
	}
	return sources;
}

/**
 * Public API — consumed by `metrics` (here) and the every-file-tested gate
 * (`harness/tested-file-policy.ts`). Single-sources the coverage-report loading
 * so the gate's coverage axis and the metrics command never disagree about a
 * file's line-coverage percentage.
 *
 * Both report formats are loaded and MERGED (finding 2026-06): unconditional
 * istanbul-over-LCOV precedence made a polyglot repo's non-istanbul files vanish
 * from metrics and the tested-file gate, and let a STALE istanbul report shadow
 * a fresh LCOV one. Per-file lookups try the FRESHER report first (report-file
 * mtime) and fall back to the other for files it lacks; the file set is the
 * union.
 */
export function loadMetricsCoverage(cwd: string): MetricsCoverage {
	const sources = [istanbulSource(cwd), ...lcovSources(cwd)].filter(
		(s): s is CoverageSource => s !== null,
	);
	const [primary] = sources;
	if (!primary) {
		return {
			available: false,
			source: null,
			fileSet: new Set(),
			perFile: () => undefined,
			linePct: () => null,
		};
	}
	const fileSet = new Set<string>();
	for (const s of sources) {
		for (const f of s.fileSet) fileSet.add(f);
	}
	// Each axis orders by ITS OWN backing file's freshness (finding 2026-06): a
	// fresh coverage-final.json must not let a STALE coverage-summary.json shadow
	// a fresher LCOV line percentage, and vice versa.
	const byPerFile = [...sources].sort((a, b) => b.perFileMtimeMs - a.perFileMtimeMs);
	const byLinePct = [...sources].sort((a, b) => b.linePctMtimeMs - a.linePctMtimeMs);
	// "istanbul+lcov" only when both FORMATS contributed — two per-language LCOV
	// files alone are still just "lcov".
	const kinds = new Set(sources.map((s) => s.kind));
	return {
		available: true,
		source: kinds.size > 1 ? "istanbul+lcov" : primary.kind,
		fileSet,
		perFile: (rel, fnRanges, mtime) => {
			for (const s of byPerFile) {
				const cov = s.perFile(rel, fnRanges, mtime);
				if (cov) return cov;
			}
			return undefined;
		},
		linePct: (rel) => {
			for (const s of byLinePct) {
				const pct = s.linePct(rel);
				if (pct !== null) return pct;
			}
			return null;
		},
	};
}

/**
 * Repo-relative, sorted list of source files in scope for `interlinked
 * metrics` (analyzable extension, not a test/fixture, either under `src/` or
 * known to the loaded coverage report).
 */
export function discoverMetricSourceFiles(cwd: string, coverage: MetricsCoverage): string[] {
	return discoverFiles(cwd)
		.map((file) => relative(cwd, file).replace(/\\/g, "/"))
		.filter((file) => isAnalyzableSource(file, coverage.fileSet))
		.sort();
}
