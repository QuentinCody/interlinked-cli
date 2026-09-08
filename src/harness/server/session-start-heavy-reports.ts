// ===========================================
// SessionStart heavy-report reader (DW P4 §4 jobs 2/3 — the surfacing half)
// ===========================================
// The SessionEnd fuzz-smoke / bench jobs write vitest json reports; this reads
// any COMPLETED report at the next SessionStart, surfaces failures/regressions
// as non-blocking context, and consumes (deletes) the report. Results arrive as
// SessionStart information, never a mid-session surprise (the continuity rule).
//
// Fuzz: a property/fuzz assertion that failed under elevated numRuns is a real
// edge case the per-edit cap (25) missed → warn + record a recurrence.
// Bench: each benchmark's mean is compared to a stored baseline; a rise past the
// threshold is a perf regression → warn. Baseline updates to the latest run.
// Everything best-effort + never-throw; an unparseable report is skipped.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";

/** A benchmark mean rising past this fraction over baseline is a regression. */
const BENCH_REGRESSION_THRESHOLD = 0.2;

function reportsDir(cwd: string, kind: "fuzz" | "bench"): string {
	return join(cwd, ".interlinked", `${kind}-reports`);
}

/** Read + delete every `*.json` under a reports dir. Best-effort. */
function drainReports(dir: string): unknown[] {
	if (!existsSync(dir)) return [];
	const out: unknown[] = [];
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch (err) {
		void err;
		return [];
	}
	for (const name of names) {
		const p = join(dir, name);
		try {
			out.push(JSON.parse(readFileSync(p, "utf-8")));
		} catch (err) {
			void err; // unparseable / partial write — skip
		}
		try {
			rmSync(p, { force: true });
		} catch (err) {
			void err;
		}
	}
	return out;
}

/** Failed-test count + up-to-5 failed file names from a vitest json report. */
export function fuzzFailuresFrom(report: unknown): { failed: number; files: string[] } {
	if (!isJsonObject(report)) return { failed: 0, files: [] };
	const r = report;
	const failed = typeof r.numFailedTests === "number" ? r.numFailedTests : 0;
	const files: string[] = [];
	if (Array.isArray(r.testResults)) {
		for (const t of r.testResults) {
			if (!isJsonObject(t)) continue;
			const tr = t;
			if (tr.status === "failed" && typeof tr.name === "string") files.push(tr.name);
		}
	}
	return { failed, files: files.slice(0, 5) };
}

/** Recursively collect {name, mean} benchmark points from an unknown bench json
 *  shape (vitest's format has varied across versions — stay tolerant). */
export function benchPointsFrom(report: unknown, acc: Map<string, number> = new Map()): Map<string, number> {
	if (Array.isArray(report)) {
		for (const item of report) benchPointsFrom(item, acc);
		return acc;
	}
	if (!isJsonObject(report)) return acc;
	const o = report;
	if (typeof o.name === "string" && typeof o.mean === "number" && o.mean > 0) {
		acc.set(o.name, o.mean);
	}
	for (const v of Object.values(o)) {
		if (typeof v === "object" && v !== null) benchPointsFrom(v, acc);
	}
	return acc;
}

function benchBaselinePath(cwd: string): string {
	return join(cwd, ".interlinked", "bench-baseline.json");
}

function numericBenchBaseline(data: unknown): Record<string, number> {
	if (!isJsonObject(data)) return {};
	const baseline: Record<string, number> = {};
	for (const [name, value] of Object.entries(data)) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) baseline[name] = value;
	}
	return baseline;
}

function loadBenchBaseline(cwd: string): Record<string, number> {
	try {
		const p = benchBaselinePath(cwd);
		if (!existsSync(p)) return {};
		const data: unknown = JSON.parse(readFileSync(p, "utf-8"));
		return numericBenchBaseline(data);
	} catch (err) {
		void err;
		return {};
	}
}

function saveBenchBaseline(cwd: string, points: Map<string, number>): void {
	try {
		const p = benchBaselinePath(cwd);
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		writeFileSync(p, JSON.stringify(Object.fromEntries(points)));
	} catch (err) {
		void err;
	}
}

/** Regression warnings comparing this run's benchmark means to the baseline. */
export function benchRegressions(baseline: Record<string, number>, current: Map<string, number>): string[] {
	const out: string[] = [];
	for (const [name, mean] of current) {
		const prior = baseline[name];
		if (typeof prior !== "number" || prior <= 0) continue;
		const rise = (mean - prior) / prior;
		if (rise > BENCH_REGRESSION_THRESHOLD) {
			out.push(`${name}: ${prior.toFixed(3)}ms → ${mean.toFixed(3)}ms (+${Math.round(rise * 100)}%)`);
		}
	}
	return out;
}

/**
 * Read + consume the fuzz/bench reports for a SessionStart. Returns warning
 * strings to surface; invokes `recordFuzzFailure` for each fuzz report with
 * failures (recurrence hook). Never throws.
 */
export function readHeavyReports(
	cwd: string,
	recordFuzzFailure?: (failed: number, files: string[]) => void,
): string[] {
	const warnings: string[] = [];
	try {
		for (const report of drainReports(reportsDir(cwd, "fuzz"))) {
			const { failed, files } = fuzzFailuresFrom(report);
			if (failed > 0) {
				recordFuzzFailure?.(failed, files);
				warnings.push(
					`[interlinked:fuzz] ${failed} property/fuzz assertion(s) failed in the last ` +
						`SessionEnd fuzz-smoke (elevated numRuns) — the per-edit cap of 25 missed these edge ` +
						`cases: ${files.join(", ") || "(see .interlinked/fuzz-reports)"}. Fix the nondeterminism.`,
				);
			}
		}
		const benchReports = drainReports(reportsDir(cwd, "bench"));
		if (benchReports.length > 0) {
			const baseline = loadBenchBaseline(cwd);
			const current = new Map<string, number>();
			for (const report of benchReports) benchPointsFrom(report, current);
			if (current.size > 0) {
				const regressions = benchRegressions(baseline, current);
				if (regressions.length > 0) {
					warnings.push(
						`[interlinked:bench] ${regressions.length} benchmark regression(s) vs baseline: ${regressions.join("; ")}.`,
					);
				}
				saveBenchBaseline(cwd, current);
			}
		}
	} catch (err) {
		void err; // never break SessionStart on a report-read error
	}
	return warnings;
}
