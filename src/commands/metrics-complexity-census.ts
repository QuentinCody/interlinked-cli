// ===========================================
// Complexity census — pure core for `interlinked metrics complexity`
// ===========================================
// Measures cyclomatic + cognitive complexity per function and lines per file
// across the cappable product-code population, using the harness's OWN AST
// analyzers so every number matches what the write gates see. Ported from the
// 2026-09-01 read-only census script (scratch/complexity-census.mts); the
// percentile rank, histogram bands, and per-file mass follow it exactly so the
// command's output is comparable with the census that seeded the caps.
//
// Everything here is pure over an iterable of {file, content}: no fs, no git,
// no caps. The command module owns enumeration, cap resolution, and rendering.

import { computeCognitiveAst } from "../harness/checks/cognitive-ast.js";
import { computeCyclomaticAst } from "../harness/checks/cyclomatic-ast.js";
import { countLines, isCappableFile } from "../harness/large-file-policy.js";

/** The three census metrics, in report order. */
export const CENSUS_METRICS = ["cyclomatic", "cognitive", "lines"] as const;
export type CensusMetric = (typeof CENSUS_METRICS)[number];

export function isCensusMetric(value: string): value is CensusMetric {
	return CENSUS_METRICS.some((m) => m === value);
}

/** One measured function. */
export interface FunctionRow {
	file: string;
	name: string;
	/** 1-based line of the function's start. */
	line: number;
	value: number;
}

/** One measured file (lines). */
export interface FileRow {
	file: string;
	value: number;
}

export interface Distribution {
	n: number;
	mean: number;
	p50: number;
	p75: number;
	p90: number;
	p95: number;
	p99: number;
	max: number;
}

/** One histogram band: values in [lo, hi]; `hi === null` is the overflow band. */
export interface HistogramBand {
	lo: number;
	hi: number | null;
	count: number;
}

/** Per-file complexity mass. `density` = ΣCC ÷ functions (0 when no functions). */
export interface FileMass {
	file: string;
	cc: number;
	cog: number;
	fns: number;
	density: number;
}

export interface CensusRows {
	/** Cappable files measured. */
	files: number;
	cyclomatic: FunctionRow[];
	cognitive: FunctionRow[];
	lines: FileRow[];
}

export interface CensusSource {
	/** Repo-relative POSIX path. */
	file: string;
	content: string;
}

/** Band ceilings (inclusive) the reference census printed, per metric. */
export const HISTOGRAM_BANDS: Record<CensusMetric, readonly number[]> = {
	cyclomatic: [1, 2, 3, 5, 8, 12, 16, 22, 30],
	cognitive: [0, 3, 6, 10, 15, 20, 30, 40],
	lines: [100, 200, 300, 400, 500, 600],
};

/** Percentile by floor(p/100 · n) rank over an ascending sample — the reference
 *  census's definition, kept so the numbers line up with the seeded caps. */
export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx] ?? 0;
}

export function summarize(values: readonly number[]): Distribution {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const sum = sorted.reduce((s, v) => s + v, 0);
	return {
		n,
		mean: n === 0 ? 0 : sum / n,
		p50: percentile(sorted, 50),
		p75: percentile(sorted, 75),
		p90: percentile(sorted, 90),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: percentile(sorted, 100),
	};
}

/** Index of the first band whose ceiling covers `v`, or `bands.length` (overflow). */
function bandIndex(v: number, bands: readonly number[]): number {
	const idx = bands.findIndex((hi) => v <= hi);
	return idx === -1 ? bands.length : idx;
}

/** Counts per band; the last returned band is the overflow (`hi: null`). */
export function histogram(values: readonly number[], bands: readonly number[]): HistogramBand[] {
	const counts = new Array<number>(bands.length + 1).fill(0);
	for (const v of values) {
		const i = bandIndex(v, bands);
		counts[i] = (counts[i] ?? 0) + 1;
	}
	const out: HistogramBand[] = bands.map((hi, i) => ({
		lo: i === 0 ? 0 : (bands[i - 1] ?? 0) + 1,
		hi,
		count: counts[i] ?? 0,
	}));
	const last = bands[bands.length - 1] ?? 0;
	out.push({ lo: last + 1, hi: null, count: counts[bands.length] ?? 0 });
	return out;
}

/** The shape `topN` ranks: a value plus optional file/line tie-breakers. */
export interface Ranked {
	value: number;
	file?: string;
	line?: number;
}

function compareRanked(a: Ranked, b: Ranked): number {
	return (
		b.value - a.value ||
		(a.file ?? "").localeCompare(b.file ?? "") ||
		(a.line ?? 0) - (b.line ?? 0)
	);
}

/** Largest `n` rows by value (desc), ties by file then line. Never mutates. */
export function topN<T extends Ranked>(rows: readonly T[], n: number): T[] {
	return [...rows].sort(compareRanked).slice(0, Math.max(0, n));
}

/** Values strictly over `threshold`. */
export function countOver(values: readonly number[], threshold: number): number {
	return values.filter((v) => v > threshold).length;
}

/** Per-file ΣCC / Σcognitive / function count / density, sorted by ΣCC desc. */
export function perFileMass(cyclo: readonly FunctionRow[], cognitive: readonly FunctionRow[]): FileMass[] {
	const byFile = new Map<string, FileMass>();
	const entry = (file: string): FileMass => {
		let e = byFile.get(file);
		if (!e) {
			e = { file, cc: 0, cog: 0, fns: 0, density: 0 };
			byFile.set(file, e);
		}
		return e;
	};
	for (const r of cyclo) {
		const e = entry(r.file);
		e.cc += r.value;
		e.fns += 1;
	}
	for (const r of cognitive) entry(r.file).cog += r.value;
	for (const e of byFile.values()) e.density = e.fns === 0 ? 0 : e.cc / e.fns;
	return [...byFile.values()].sort((a, b) => b.cc - a.cc || a.file.localeCompare(b.file));
}

interface MeasuredFunction {
	name: string;
	line: number;
}

/** The two per-function analyzers; `null` means the TS analyzer is unavailable. */
export interface CensusAnalyzers {
	cyclomatic: (content: string, file: string) => ReadonlyArray<MeasuredFunction & { cyclomatic: number }> | null;
	cognitive: (content: string, file: string) => ReadonlyArray<MeasuredFunction & { cognitive: number }> | null;
}

const DEFAULT_ANALYZERS: CensusAnalyzers = {
	cyclomatic: computeCyclomaticAst,
	cognitive: computeCognitiveAst,
};

/**
 * Measure every cappable source. Returns `null` when either analyzer reports
 * the TS module unavailable — an empty census would read as "clean", and the
 * caller must say so loudly instead.
 */
export function collectCensusRows(
	sources: Iterable<CensusSource>,
	root: string,
	analyzers: CensusAnalyzers = DEFAULT_ANALYZERS,
): CensusRows | null {
	const rows: CensusRows = { files: 0, cyclomatic: [], cognitive: [], lines: [] };
	for (const { file, content } of sources) {
		if (!isCappableFile({ filePath: file, content, root })) continue;
		const cyclo = analyzers.cyclomatic(content, file);
		const cog = analyzers.cognitive(content, file);
		if (cyclo === null || cog === null) return null;
		rows.files += 1;
		rows.lines.push({ file, value: countLines(content) });
		for (const e of cyclo) rows.cyclomatic.push({ file, name: e.name, line: e.line, value: e.cyclomatic });
		for (const e of cog) rows.cognitive.push({ file, name: e.name, line: e.line, value: e.cognitive });
	}
	return rows;
}

export interface CapProposal {
	n: number;
	p90: number;
	p95: number;
}

/** p90 / p95 per metric — the "calibrate against the tree" seed for a fresh repo. */
export function proposeCaps(rows: CensusRows): Record<CensusMetric, CapProposal> {
	const propose = (values: readonly number[]): CapProposal => {
		const sorted = [...values].sort((a, b) => a - b);
		return { n: sorted.length, p90: percentile(sorted, 90), p95: percentile(sorted, 95) };
	};
	return {
		cyclomatic: propose(rows.cyclomatic.map((r) => r.value)),
		cognitive: propose(rows.cognitive.map((r) => r.value)),
		lines: propose(rows.lines.map((r) => r.value)),
	};
}
