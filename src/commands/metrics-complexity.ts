// ===========================================
// interlinked metrics complexity — per-function / per-file complexity census
// ===========================================
// Percentiles, histograms, top-N hotspots, per-file complexity mass, and
// over-cap counts for cyclomatic, cognitive, and lines — the productized form
// of the 2026-09-01 census that calibrated this repo's caps. Same analyzers,
// same file population (`isCappableFile` over git-visible sources), same caps
// (`resolveMetricCaps`) as the write gates, so the numbers are the gates' own.
//
// `interlinked caps propose` reuses the census to print p90 / p95 per metric
// as suggested caps for a repo with none set. It WRITES NOTHING: the caps files
// are baseline-integrity-gated, and the seed is a human decision.
//
// On-demand only (whole-tree AST parse, ~seconds): never on the hook path.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getGitSourceFiles } from "../harness/checks/export-ripple.js";
import { DEFAULT_MAX_COGNITIVE } from "../harness/checks/cognitive-ast.js";
import { loadLargeFileBaseline } from "../harness/large-file-policy.js";
import { resolveMetricCaps } from "../harness/metric-caps.js";
import { getOutputMode, output } from "../lib/output.js";
import {
	CENSUS_METRICS,
	type CensusAnalyzers,
	type CensusMetric,
	type CensusRows,
	type CensusSource,
	collectCensusRows,
	countOver,
	type Distribution,
	type FileMass,
	type FileRow,
	type FunctionRow,
	HISTOGRAM_BANDS,
	type HistogramBand,
	histogram,
	isCensusMetric,
	perFileMass,
	proposeCaps,
	summarize,
	topN,
} from "./metrics-complexity-census.js";

// The four report types below are public API: they are the `--json` contract
// of `metrics complexity` and the shape `buildComplexityReport` hands to
// every renderer, so downstream consumers can name what they parse.

/** A resolved cap plus where it came from (metric-caps.json / legacy / default). */
export interface CapView {
	value: number;
	source: string;
}

export type CensusCaps = Record<CensusMetric, CapView>;

export interface MetricReport {
	metric: CensusMetric;
	distribution: Distribution;
	histogram: HistogramBand[];
	cap: CapView;
	over_cap: number;
	/** The advisory (warn-early) threshold, where one exists — cognitive only. */
	advisory: { threshold: number; over: number } | null;
	top: FunctionRow[] | FileRow[];
}

export interface ComplexityReport {
	files: number;
	functions: number;
	/** The requested hotspot count (`--top`); sections may hold fewer rows. */
	top: number;
	caps: CensusCaps;
	metrics: MetricReport[];
	files_by_mass: FileMass[];
}

const DEFAULT_TOP = 20;

const METRIC_LABEL: Record<CensusMetric, string> = {
	cyclomatic: "Cyclomatic per function",
	cognitive: "Cognitive per function",
	lines: "Lines per file",
};

/** `--metric` value → ordered selection; null for an unknown name. */
export function parseMetricSelection(raw: string | undefined): CensusMetric[] | null {
	const text = (raw ?? "all").trim().toLowerCase();
	if (text === "all" || text === "") return [...CENSUS_METRICS];
	return isCensusMetric(text) ? [text] : null;
}

function metricReport(rows: CensusRows, metric: CensusMetric, caps: CensusCaps, top: number): MetricReport {
	const metricRows: FunctionRow[] | FileRow[] = rows[metric];
	const values = metricRows.map((r) => r.value);
	const cap = caps[metric];
	return {
		metric,
		distribution: summarize(values),
		histogram: histogram(values, HISTOGRAM_BANDS[metric]),
		cap,
		over_cap: countOver(values, cap.value),
		advisory:
			metric === "cognitive"
				? { threshold: DEFAULT_MAX_COGNITIVE, over: countOver(values, DEFAULT_MAX_COGNITIVE) }
				: null,
		top: topN(metricRows, top),
	};
}

/** Pure assembly: census rows + resolved caps → the report every mode renders. */
export function buildComplexityReport(
	rows: CensusRows,
	caps: CensusCaps,
	selection: readonly CensusMetric[],
	top: number,
): ComplexityReport {
	return {
		files: rows.files,
		functions: rows.cyclomatic.length,
		top,
		caps,
		metrics: selection.map((m) => metricReport(rows, m, caps, top)),
		files_by_mass: perFileMass(rows.cyclomatic, rows.cognitive).slice(0, top),
	};
}

// ---- rendering ---------------------------------------------------------------

function renderHeader(m: MetricReport): string {
	const d = m.distribution;
	const adv = m.advisory === null ? "" : `, >${m.advisory.threshold} (advisory): ${m.advisory.over}`;
	return (
		`== ${METRIC_LABEL[m.metric]} — n=${d.n} mean=${d.mean.toFixed(1)} p50=${d.p50} p75=${d.p75} ` +
		`p90=${d.p90} p95=${d.p95} p99=${d.p99} max=${d.max} | >cap ${m.cap.value}: ${m.over_cap}${adv}`
	);
}

function renderHistogram(bands: readonly HistogramBand[]): string[] {
	return bands.map((b) =>
		b.hi === null
			? `  >${String(b.lo - 1).padEnd(8)} ${String(b.count).padStart(6)}`
			: `  ${String(b.lo).padStart(4)}–${String(b.hi).padEnd(4)} ${String(b.count).padStart(6)}`,
	);
}

function isFunctionRow(row: FunctionRow | FileRow): row is FunctionRow {
	return "name" in row;
}

function renderTopRow(row: FunctionRow | FileRow): string {
	if (isFunctionRow(row)) return `  ${String(row.value).padStart(3)}  ${row.file}:${row.line}  ${row.name}`;
	return `  ${String(row.value).padStart(4)}  ${row.file}`;
}

function renderMetricSection(m: MetricReport, top: number): string[] {
	const title = m.metric === "lines" ? "lines per file" : m.metric;
	return [
		"",
		renderHeader(m),
		...renderHistogram(m.histogram),
		"",
		`== Top ${top} ${title}`,
		...m.top.map(renderTopRow),
	];
}

function renderMassRow(e: FileMass): string {
	return (
		`  ${String(e.cc).padStart(4)} / ${String(e.cog).padStart(4)} / ${String(e.fns).padStart(3)} / ` +
		`${e.density.toFixed(1).padStart(4)}  ${e.file}`
	);
}

/** The census-style text report (normal / full modes). */
export function renderComplexityReport(report: ComplexityReport): string {
	const lines: string[] = [`Complexity census — ${report.files} files, ${report.functions} functions`];
	for (const m of report.metrics) lines.push(...renderMetricSection(m, report.top));
	if (report.metrics.length > 0) {
		lines.push("", `== Top ${report.top} files by cyclomatic mass (ΣCC / Σcognitive / fns / density)`);
		lines.push(...report.files_by_mass.map(renderMassRow));
	}
	return lines.join("\n");
}

/** One line: totals + over-cap fraction per selected metric. */
export function renderShortSummary(report: ComplexityReport): string {
	const parts = report.metrics.map(
		(m) => `${m.metric} ${m.over_cap}/${m.distribution.n} (>${m.cap.value})`,
	);
	return `${report.files} files, ${report.functions} functions; over cap: ${parts.join(", ")}`;
}

/** `caps propose` text: p90 / p95 per metric beside the current cap. */
export function renderCapProposals(rows: CensusRows, caps: CensusCaps): string {
	const proposals = proposeCaps(rows);
	const lines = [
		`Proposed caps from the tree — ${rows.files} files, ${rows.cyclomatic.length} functions (nothing written)`,
		"",
		"  metric           n   p90   p95   current",
	];
	for (const metric of CENSUS_METRICS) {
		const p = proposals[metric];
		lines.push(
			`  ${metric.padEnd(11)} ${String(p.n).padStart(6)} ${String(p.p90).padStart(5)} ${String(p.p95).padStart(5)}   ` +
				`${caps[metric].value} [${caps[metric].source}]`,
		);
	}
	lines.push(
		"",
		"p90 is the strict seed, p95 the lenient one; both are calibrated against THIS tree, not fixtures.",
		"Apply one with: interlinked caps set cyclomatic <n>  (also: cognitive, lines).",
	);
	return lines.join("\n");
}

// ---- enumeration + caps ------------------------------------------------------

interface CensusDeps {
	/** Repo-relative source paths to measure (default: git-visible sources). */
	listFiles?: (cwd: string) => string[];
	analyzers?: CensusAnalyzers;
}

/** null when the path vanished between listing and reading, or is not a file. */
function readSource(cwd: string, rel: string): CensusSource | null {
	try {
		return { file: rel, content: readFileSync(join(cwd, rel), "utf8") };
	} catch (err) {
		void err; // not measurable → excluded from the census, never fatal
		return null;
	}
}

function loadSources(cwd: string, listFiles: (cwd: string) => string[]): CensusSource[] {
	const out: CensusSource[] = [];
	for (const rel of [...listFiles(cwd)].sort()) {
		const source = readSource(cwd, rel);
		if (source !== null) out.push(source);
	}
	return out;
}

/** The three caps exactly as the gates resolve them (override → legacy → default). */
function resolveCensusCaps(cwd: string): CensusCaps {
	const baseline = loadLargeFileBaseline(cwd)?.max_lines;
	const r = resolveMetricCaps(cwd, baseline !== undefined ? { max_lines: baseline } : {});
	return { cyclomatic: r.max_cyclomatic, cognitive: r.max_cognitive, lines: r.max_lines };
}

const ANALYZER_UNAVAILABLE =
	"complexity census unavailable: the optional `typescript` dependency is not installed " +
	"(npm install typescript) — the AST analyzers have no regex fallback for a census.\n";

/** Enumerate + measure; null (with stderr + exit 1) when the analyzer is missing. */
function runCensus(cwd: string, deps: CensusDeps): CensusRows | null {
	const sources = loadSources(cwd, deps.listFiles ?? getGitSourceFiles);
	const rows = collectCensusRows(sources, cwd, deps.analyzers);
	if (rows === null) {
		process.stderr.write(ANALYZER_UNAVAILABLE);
		process.exitCode = 1;
	}
	return rows;
}

// ---- commands ----------------------------------------------------------------

interface MetricsComplexityOpts {
	cwd?: string;
	top?: string;
	metric?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function parseTop(raw: string | undefined): number {
	const n = Number((raw ?? "").trim());
	return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : DEFAULT_TOP;
}

/** Public API — wired by `interlinked metrics complexity` in registrars/metrics.ts. */
export async function metricsComplexityCommand(
	opts: MetricsComplexityOpts,
	deps: CensusDeps = {},
): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const selection = parseMetricSelection(opts.metric);
	if (selection === null) {
		process.stderr.write(`--metric must be one of: ${CENSUS_METRICS.join(", ")}, all\n`);
		process.exitCode = 1;
		return;
	}
	const rows = runCensus(cwd, deps);
	if (rows === null) return;
	const report = buildComplexityReport(rows, resolveCensusCaps(cwd), selection, parseTop(opts.top));
	output(getOutputMode(opts), report, {
		json: () => report,
		short: () => renderShortSummary(report),
		normal: () => renderComplexityReport(report),
	});
}

/** Public API — wired by `interlinked caps propose` in registrars/caps.ts. Writes nothing. */
export async function capsProposeAction(
	opts: { json?: boolean },
	deps: CensusDeps & { cwd?: string } = {},
): Promise<number> {
	const cwd = deps.cwd ?? process.cwd();
	const rows = runCensus(cwd, deps);
	if (rows === null) return 1;
	const caps = resolveCensusCaps(cwd);
	const proposals = proposeCaps(rows);
	output(getOutputMode(opts), rows, {
		json: () => ({
			written: false,
			files: rows.files,
			proposals: Object.fromEntries(
				CENSUS_METRICS.map((m) => [m, { ...proposals[m], current: caps[m] }]),
			),
		}),
		normal: () => renderCapProposals(rows, caps),
	});
	return 0;
}
