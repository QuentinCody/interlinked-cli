// ===========================================
// interlinked metrics — whole-codebase test-quality scan
// ===========================================
// One command that scans every analyzable source file and reports the
// test-quality posture across the stack: companion-test presence, coverage,
// cyclomatic complexity (AST-accurate), and CRAP — per function and per file,
// with the agreed gate verdicts. Read-only; composes the existing pieces
// (file discovery, the AST complexity pass, the per-function coverage reader,
// the CRAP scorer, the companion-path helper) rather than recomputing anything.
//
// Coverage is OPTIONAL and language-agnostic: it loads istanbul
// `coverage-final.json` AND the canonical LCOV spine (`coverage/lcov.info`)
// the per-language adapters emit (coverage.py, cargo-llvm-cov, vitest's lcov
// reporter, …), MERGING them when both exist — per-file lookups prefer the
// fresher report and fall back to the other (a polyglot repo emits each for a
// different language). When neither exists the scan still reports complexity +
// companion presence and marks coverage/CRAP as unavailable (fail-open, never
// throws).

import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { computeCrapForFile } from "../harness/checks/crap.js";
import { computeCyclomaticComplexity, type FunctionComplexityEntry } from "../harness/checks/cyclomatic.js";
import { astComplexityAvailable, computeCyclomaticAst } from "../harness/checks/cyclomatic-ast.js";
import type { PerFileCoverage } from "../harness/coverage-final-reader.js";
import {
	isTddExemptPath,
} from "../harness/evaluator/tdd-new-file-gate.js";
import { hasCompanionTest } from "../harness/evaluator/companion-test.js";
import { minCoverageFor } from "../harness/tested-file-policy.js";
import { crapThresholdFor, maxCyclomaticFor } from "../harness/metric-caps.js";
import { getOutputMode, output } from "../lib/output.js";
import { discoverMetricSourceFiles, loadMetricsCoverage } from "./metrics-coverage.js";
import {
	type FileMetric,
	type FnMetric,
	type MetricsReport,
	renderFull,
	renderNormal,
	renderShort,
} from "./metrics-renderers.js";
import {
	functionTokenMetricsContext,
} from "./metrics-function-token-compat.js";
import {
	compareMetricText,
	uniqueMetricComplexities,
} from "./metrics-function-token-joins.js";

// The cyclomatic "review" band is the design-smell window just below the hard
// "bad" cap: a function with complexity in `(CYCLOMATIC_REVIEW, cap]` is worth a
// look but not a gate failure. The lower bound is a fixed convention; the UPPER
// bound (the "bad" cap) and the CRAP gate are RESOLVED per repo from
// `.interlinked/metric-caps.json` via `maxCyclomaticFor` / `crapThresholdFor`, so
// the counts + labels match exactly what the write/commit gates enforce — a repo
// that tightened its caps no longer sees a stale 25/30 here.
const CYCLOMATIC_REVIEW = 15;

interface MetricsOptions {
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
	includeTests?: boolean;
	/** Cap the hotspot table (default 25). */
	top?: string;
}

const JS_TS_METRIC_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

/**
 * Cyclomatic complexity per function for `interlinked metrics`, DISPATCHED by
 * extension. JS/TS use the AST pass directly (no test-file exemption — metrics
 * measures the harness's own checks/ tree), falling back to the regex walker only
 * when `typescript` is absent. Every other language goes through the
 * language-dispatching `computeCyclomaticComplexity` (Python/Rust/Go walkers).
 *
 * The old `computeCyclomaticAst(content, abs) ?? computeCyclomaticComplexity(...)`
 * silently reported ZERO functions for .py/.rs/.go: with `typescript` installed,
 * the AST pass returns an EMPTY array (not null) for a non-JS file, so the `??`
 * fallback never ran. Dispatch (not "output nonempty") is the contract — a real
 * source file may legitimately contain no functions. Exported for the conformance
 * probe (`analyzerForPath`-style: a branchy .py/.rs/.go fixture must score nonzero).
 */
export function cyclomaticForMetrics(content: string, filePath: string): FunctionComplexityEntry[] {
	if (JS_TS_METRIC_EXTS.has(extname(filePath).toLowerCase())) {
		return computeCyclomaticAst(content, filePath) ?? computeCyclomaticComplexity(content, filePath);
	}
	return computeCyclomaticComplexity(content, filePath);
}

/**
 * Per-function metrics for one file. Functions the coverage tool actually
 * reported get a coverage percentage and a CRAP score; functions it never
 * reported — an instrumentation gap or line drift past `computeCrap`'s slack
 * window — get `null` for both. `null` keeps them in the inventory (they still
 * carry cyclomatic complexity) while holding them out of the CRAP ranking,
 * the CRAP distribution, and the over-cap gate count, all of which already
 * filter on a non-null score. The alternative — scoring unknown coverage as
 * 0% — put fully-covered functions at the top of the hotspot list.
 */
function fileFunctionMetrics(args: {
	comps: FunctionComplexityEntry[];
	tokenCounts: ReadonlyMap<string, number>;
	perFile: PerFileCoverage | undefined;
	rel: string;
	fileMtime: number;
}): FnMetric[] {
	const { comps, tokenCounts, perFile, rel, fileMtime } = args;
	const scored = perFile
		? computeCrapForFile({
				complexities: comps,
				perFile,
				filePath: rel,
				fileMtime,
				threshold: 0,
				staleTolerance: "include",
			})
		: [];
	const byKey = new Map(scored.map((f) => [`${f.function}:${f.line}`, f]));
	return comps.map((e) => {
		const hit = byKey.get(`${e.name}:${e.line}`);
		return {
			file: rel,
			name: e.name,
			line: e.line,
			cyclomatic: e.cyclomatic,
			coveragePct: hit ? hit.coverage_pct : null,
			crap: hit ? hit.crap_score : null,
			canonicalTokens: tokenCounts.get(`${e.name}:${e.line}`) ?? null,
		};
	});
}

function buildReport(cwd: string, topN: number, includeTests: boolean): MetricsReport {
	// Resolve the gate caps ONCE per scan from `.interlinked/metric-caps.json`
	// (else the shipped defaults) — these are the SAME numbers the write/commit
	// gates enforce, so the report's labels + counts can never drift from them.
	const crapGate = crapThresholdFor(cwd);
	const cyclomaticBad = maxCyclomaticFor(cwd);
	const tokenContext = functionTokenMetricsContext({ cwd, topN, includeTests });
	const functionTokenCap = tokenContext.cap;
	const functionTokenMetrics = tokenContext.report;
	const tokenCounts = tokenContext.countsByFile;
	const tokenFiles = tokenContext.filesByPath;
	const cov = loadMetricsCoverage(cwd);
	// discoverFiles returns absolute paths — normalize to repo-relative for
	// coverage lookup, companion paths, and display.
	const sourceFiles = discoverMetricSourceFiles(cwd, cov);

	const fns: FnMetric[] = [];
	const tokenFns: FnMetric[] = [];
	const files: FileMetric[] = [];
	const missingCompanion: string[] = [];
	let filesNoCoverage = 0;

	for (const rel of sourceFiles) {
		const abs = join(cwd, rel);
		let content: string;
		try {
			content = readFileSync(abs, "utf-8");
		} catch {
			continue;
		}
		// Measure complexity on EVERY source file. The AST pass has no test-file
		// exemption — that exemption (in computeCyclomaticComplexity) is for
		// content-quality scans, not measurement, and would hide the harness's
		// own checks/ tree. Fall back to the guarded walker only sans typescript.
		const fileMtime = statSync(abs).mtimeMs;
		const comps = cyclomaticForMetrics(content, abs);
		const perFile = cov.perFile(rel, comps, fileMtime);
		if (cov.available && !perFile) filesNoCoverage++;

		const fileFns = fileFunctionMetrics({
			comps,
			tokenCounts: tokenCounts.get(rel) ?? new Map(),
			perFile,
			rel,
			fileMtime,
		});
		fns.push(...fileFns);

		const companionExpected = !isTddExemptPath(rel);
		// hasCompanionTest (not the raw candidate list): recognizes qualified
		// names (update.integration.test.ts) and — via cwd as projectRoot —
		// separate-tree layouts. Both were missed before 2026-08-17 (68 of 218
		// "missing companion" rows were false positives).
		const companion = companionExpected ? hasCompanionTest(abs, cwd) : null;
		if (companion === false) missingCompanion.push(rel);

		files.push({
			file: rel,
			functions: fileFns.length,
			linePct: cov.linePct(rel),
			maxCyclomatic: fileFns.reduce((m, f) => Math.max(m, f.cyclomatic), 0),
			maxCrap: perFile ? fileFns.reduce((m, f) => Math.max(m, f.crap ?? 0), 0) : null,
			companion,
			overGate: fileFns.filter((f) => (f.crap ?? 0) >= crapGate).length,
			maxFunctionTokens: tokenFiles.get(rel)?.maxFunctionTokens ?? null,
		});
	}

	const complexityByLocation = uniqueMetricComplexities(fns);
	tokenFns.push(...functionTokenMetrics.functions.map((row) => ({
		file: row.file,
		name: row.qualifiedName,
		line: row.line,
		cyclomatic: complexityByLocation.get(`${row.file}:${row.name}:${row.line}`) ?? 0,
		coveragePct: null,
		crap: null,
		canonicalTokens: row.canonicalTokens,
	})));

	const cycSorted = fns.map((f) => f.cyclomatic).sort((a, b) => a - b);
	const crapVals = fns
		.map((f) => f.crap)
		.filter((x): x is number => x !== null)
		.sort((a, b) => a - b);
	const hotspots = [...fns]
		.filter((f) => f.crap !== null)
		.sort((a, b) => (b.crap ?? 0) - (a.crap ?? 0))
		.slice(0, topN);
	const tokenHotspots = [...tokenFns]
		.sort((a, b) => (b.canonicalTokens ?? 0) - (a.canonicalTokens ?? 0)
			|| compareMetricText(a.file, b.file)
			|| a.line - b.line
			|| compareMetricText(a.name, b.name))
		.slice(0, topN);

	return {
		scope: {
			files: files.length,
			functions: fns.length,
			coverageAvailable: cov.available,
			coverageSource: cov.source,
			astComplexityAvailable: astComplexityAvailable(),
		},
		caps: {
			crap: crapGate,
			cyclomatic: cyclomaticBad,
			cyclomaticReview: CYCLOMATIC_REVIEW,
			minCoveragePct: minCoverageFor(cwd),
			functionTokens: functionTokenCap,
		},
		gates: {
			functionsOverCrap: crapVals.filter((x) => x >= crapGate).length,
			functionsCyclomaticReview: fns.filter(
				(f) => f.cyclomatic > CYCLOMATIC_REVIEW && f.cyclomatic <= cyclomaticBad,
			).length,
			functionsCyclomaticBad: fns.filter((f) => f.cyclomatic > cyclomaticBad).length,
			filesMissingCompanion: missingCompanion.length,
			filesNoCoverage,
			functionsOverTokenCap: functionTokenMetrics.totals.enforcedFunctionsOverCap,
		},
		distributions: {
			cyclomatic: bucketize(cycSorted, [5, 10, 15, 25]),
			crap: bucketize(crapVals, [10, 30, 60, 100]),
			functionTokens: functionTokenMetrics.distributions.functions,
		},
		hotspots,
		tokenHotspots,
		functionTokenMetrics,
		missingCompanion,
		files,
	};
}

/** Count values into "≤b0", "≤b1", …, ">last" buckets. */
function bucketize(sorted: number[], bounds: number[]): Record<string, number> {
	const out: Record<string, number> = {};
	let lo = -Infinity;
	for (const b of bounds) {
		out[`${lo === -Infinity ? "≤" : `${lo}–`}${b}`] = sorted.filter((x) => x > lo && x <= b).length;
		lo = b;
	}
	out[`>${bounds[bounds.length - 1]}`] = sorted.filter((x) => x > lo).length;
	return out;
}

export async function metricsCommand(opts: MetricsOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const topN = Math.max(1, Math.min(200, Number.parseInt(opts.top ?? "25", 10) || 25));
	const report = buildReport(cwd, topN, opts.includeTests ?? false);

	output(mode, report, {
		json: () => report,
		short: () => renderShort(report),
		normal: () => renderNormal(report),
		full: () => renderFull(report),
	});
}
