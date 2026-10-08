// ===========================================
// Coverage evidence bound to the exact bytes it measured (H3c, 2026-10-02)
// ===========================================
// A coverage run's summary says "src/a.ts: 84% of lines", but not WHICH
// src/a.ts. The commit gate needs that: a figure from an earlier version of
// the file says nothing about the staged one. So a passed coverage run also
// writes `coverage/sources.json`: for each measured file, the sha256 of the
// bytes the run read and its summary percentages. A consumer that holds some
// bytes (the staged blob) asks "did any recent run measure exactly these?".
//
// Limit (stated, not hidden): a match binds the SOURCE bytes only. The tests
// that ran may differ from the staged tests, so a match is a measurement of
// these bytes, not a certificate for the staged tree. The whole-tree
// certificate is the runtime snapshot, which costs too much at commit (the live
// checkout exceeds its 4 GiB bound; only an export can build it).

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { hashBytes } from "../lib/metrics/inventory.js";
import { COVERAGE_METRICS, type CoverageMetricName } from "./coverage-metric-names.js";

/** Where a coverage run leaves the binding, relative to its run directory. */
export const COVERAGE_SOURCES_ARTIFACT = "coverage/sources.json";
const SUMMARY_ARTIFACT = "coverage/coverage-summary.json";
const METRICS = COVERAGE_METRICS;
const DEFAULT_MAX_RUNS = 20;
const SHA256 = /^[0-9a-f]{64}$/;

/** Percentages by metric, as the summary reported them for one file. */
export type CoverageMetrics = Partial<Record<CoverageMetricName, number>>;
/** A run that measured the asked-for bytes, and what it measured. */
export interface MeasuredCoverage {
	runId: string;
	metrics: CoverageMetrics;
}
/** The bytes a consumer holds for one repository-relative path. */
export interface SourceBytes {
	path: string;
	sha256: string;
}
export interface MeasuredSource {
	sha256: string;
	metrics: CoverageMetrics;
}
/** One run's binding: repository-relative path → the bytes it measured and their percentages. */
export interface CoverageSourceIndex {
	runId: string;
	files: ReadonlyMap<string, MeasuredSource>;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function summaryMetrics(entry: unknown): CoverageMetrics {
	const metrics: CoverageMetrics = {};
	if (!isJsonObject(entry)) return metrics;
	for (const name of METRICS) {
		const value = entry[name];
		if (isJsonObject(value) && typeof value.pct === "number" && Number.isFinite(value.pct)) metrics[name] = value.pct;
	}
	return metrics;
}

/** `key` (an absolute summary path) as a POSIX path relative to `root`, or null when it lies outside. */
function relativeToRoot(root: string, key: string): string | null {
	if (!isAbsolute(key)) return null;
	const rel = relative(root, key);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.split(sep).join("/");
}

function fileSha256(path: string): string | null {
	try {
		return hashBytes(readFileSync(path));
	} catch {
		return null;
	}
}

/**
 * Write `<runDirectory>/coverage/sources.json` from the run's summary, hashing each measured file under `root`
 * (the checkout the run measured). False when the run left no readable summary.
 *
 * `snapshotHashes` (repository-relative path → sha256) is the validated runtime snapshot taken after the run. When
 * given, those hashes are the ONLY bytes bound and a measured file the snapshot lacks is omitted: re-reading the live
 * file could publish bytes written after the snapshot that the run never measured.
 */
export function recordCoverageSources(runDirectory: string, root: string, snapshotHashes?: ReadonlyMap<string, string>): boolean {
	const summary = readJson(join(runDirectory, SUMMARY_ARTIFACT));
	if (!isJsonObject(summary)) return false;
	const files: Record<string, MeasuredSource> = {};
	for (const [key, entry] of Object.entries(summary)) {
		const rel = relativeToRoot(root, key);
		const sha256 = rel === null ? null : snapshotHashes ? (snapshotHashes.get(rel) ?? null) : fileSha256(key);
		if (rel !== null && sha256 !== null) files[rel] = { sha256, metrics: summaryMetrics(entry) };
	}
	const target = join(runDirectory, COVERAGE_SOURCES_ARTIFACT);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, JSON.stringify({ version: 1, files }), { mode: 0o600 });
	return true;
}

function parseMeasured(value: unknown): MeasuredSource | null {
	if (!isJsonObject(value) || typeof value.sha256 !== "string" || !SHA256.test(value.sha256) || !isJsonObject(value.metrics)) return null;
	const metrics: CoverageMetrics = {};
	for (const name of METRICS) {
		const pct = value.metrics[name];
		if (pct === undefined) continue;
		if (typeof pct !== "number" || !Number.isFinite(pct)) return null;
		metrics[name] = pct;
	}
	return { sha256: value.sha256, metrics };
}

/** A whole sources file or nothing: one malformed entry rejects the run's binding. */
function parseSources(runId: string, data: unknown): CoverageSourceIndex | null {
	if (!isJsonObject(data) || data.version !== 1 || !isJsonObject(data.files)) return null;
	const files = new Map<string, MeasuredSource>();
	for (const [path, value] of Object.entries(data.files)) {
		const measured = parseMeasured(value);
		if (!measured) return null;
		files.set(path, measured);
	}
	return { runId, files };
}

function sourcesMtime(store: string, runId: string): number | null {
	try {
		return statSync(join(store, runId, COVERAGE_SOURCES_ARTIFACT)).mtimeMs;
	} catch {
		return null;
	}
}

function runDirectories(store: string): string[] {
	try {
		return readdirSync(store, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

/** Run ids in `store` that left a binding, newest binding first. */
function runsNewestFirst(store: string): string[] {
	const dated: Array<{ runId: string; mtime: number }> = [];
	for (const runId of runDirectories(store)) {
		const mtime = sourcesMtime(store, runId);
		if (mtime !== null) dated.push({ runId, mtime });
	}
	return dated.sort((a, b) => b.mtime - a.mtime).map((run) => run.runId);
}

/** The newest `maxRuns` runs in `store` that left a valid binding, newest first. */
export function recentCoverageSources(store: string, maxRuns = DEFAULT_MAX_RUNS): CoverageSourceIndex[] {
	return runsNewestFirst(store)
		.slice(0, maxRuns)
		.flatMap((runId) => parseSources(runId, readJson(join(store, runId, COVERAGE_SOURCES_ARTIFACT))) ?? []);
}

/** The newest run (of `indexes`) that measured exactly these bytes, with its percentages; null when none did. */
export function measuredCoverage(indexes: readonly CoverageSourceIndex[], source: SourceBytes): MeasuredCoverage | null {
	for (const index of indexes) {
		const measured = index.files.get(source.path);
		if (measured?.sha256 === source.sha256) return { runId: index.runId, metrics: measured.metrics };
	}
	return null;
}
