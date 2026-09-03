// ===========================================
// Mutation Gate — per-file mutation score ratchet
// ===========================================
// Consumes a Stryker/Mutmut/Cosmic-Ray JSON report and compares current
// mutation scores against a persisted baseline in `.interlinked/mutation-baseline.json`.
// Weekly-gate shape: run via `interlinked mutation:check` out of a scheduled
// job (cron, CI, pre-push in strict mode). The ratchet is parallel in
// structure to coverage-ratchet so both can share verify-output plumbing.
//
// Why: mutation testing is the only operational measure of "your tests
// actually fail when the code is wrong." Coverage + placeholder + companion
// checks catch the surface cases; mutation is the adversarial one. Costly
// to run, so we pin it to a periodic schedule rather than every edit.
//
// Supported report shapes (auto-detected on load):
//   - Stryker v6+ JSON:   { files: { path: { mutants: [{ status }] } } }
//   - Generic flat:       { files: { path: { killed, survived, ... } } }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { MutationGateConfig } from "./check-policy.js";

// ===========================================
// Types
// ===========================================

interface FileMutationStats {
	/** Number of mutants killed by the test suite (tests failed as expected). */
	killed: number;
	/** Mutants that escaped — tests passed against the mutated code. Bad. */
	survived: number;
	/** Mutants the framework couldn't evaluate (runtime error, timeout). */
	timeout?: number | undefined;
	no_coverage?: number | undefined;
	compile_error?: number | undefined;
	runtime_error?: number | undefined;
}

export interface MutationReport {
	/** Keyed by absolute or repo-relative file path. */
	files: Record<string, FileMutationStats | undefined>;
}

export interface MutationBaseline {
	version: 1;
	updated_at: string;
	/** Per-file baseline score (0.0–1.0) and kill-count high-water mark. */
	files: Record<string, { score: number; killed: number }>;
}

export interface MutationFinding {
	name: "mutation_score_decrease" | "mutation_score_below_floor";
	severity: "warning" | "error";
	file: string;
	baseline_score: number;
	current_score: number;
	message: string;
}

export interface MutationGateResult {
	findings: MutationFinding[];
	stats: {
		files_checked: number;
		files_new: number;
		files_below_floor: number;
		files_decreased: number;
		files_improved: number;
	};
	nextBaseline: MutationBaseline;
}

// ===========================================
// Paths and defaults
// ===========================================

export function mutationBaselinePath(interlinkedDir: string): string {
	return join(interlinkedDir, "mutation-baseline.json");
}

export function emptyMutationBaseline(): MutationBaseline {
	return { version: 1, updated_at: new Date(0).toISOString(), files: {} };
}

// ===========================================
// I/O
// ===========================================

/**
 * Narrow a parsed `mutation-baseline.json` into the domain shape. Rejects
 * the whole file for an invalid top-level shape (same as the pre-fix
 * behavior), but a malformed INDIVIDUAL file entry is dropped rather than
 * discarding every other file's high-water mark — a single hand-edited or
 * partially-written entry must not reset the whole ratchet.
 */
function parseMutationBaseline(value: unknown): MutationBaseline | null {
	if (!isJsonObject(value)) return null;
	if (value.version !== 1) return null;
	if (!isJsonObject(value.files)) return null;
	const files: Record<string, { score: number; killed: number }> = {};
	for (const [file, stats] of Object.entries(value.files)) {
		if (!isJsonObject(stats)) continue;
		const { score, killed } = stats;
		if (typeof score !== "number" || typeof killed !== "number") continue;
		files[file] = { score, killed };
	}
	const updatedAt = typeof value.updated_at === "string" ? value.updated_at : new Date(0).toISOString();
	return { version: 1, updated_at: updatedAt, files };
}

export function loadMutationBaseline(interlinkedDir: string): MutationBaseline {
	const path = mutationBaselinePath(interlinkedDir);
	if (!existsSync(path)) return emptyMutationBaseline();
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parseMutationBaseline(raw) ?? emptyMutationBaseline();
	} catch {
		return emptyMutationBaseline();
	}
}

export function saveMutationBaseline(interlinkedDir: string, baseline: MutationBaseline): void {
	const path = mutationBaselinePath(interlinkedDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
}

export function loadMutationReport(reportPath: string): MutationReport | null {
	if (!existsSync(reportPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(reportPath, "utf-8"));
		if (!raw || typeof raw !== "object") return null;
		return normalizeMutationReport(raw);
	} catch {
		return null;
	}
}

// ===========================================
// Normalization — convert various Stryker-style shapes to our shape
// ===========================================

interface StrykerMutant {
	status?: string;
}

interface StrykerFileEntry {
	mutants?: StrykerMutant[];
	killed?: number;
	survived?: number;
	timeout?: number;
	noCoverage?: number;
	no_coverage?: number;
	compileError?: number;
	compile_error?: number;
	runtimeError?: number;
	runtime_error?: number;
}

function normalizeMutationReport(raw: unknown): MutationReport {
	const report: MutationReport = { files: {} };
	if (!raw || typeof raw !== "object" || !("files" in raw)) return report;
	// After the `"files" in raw` guard, `raw.files` is typed `unknown` — the
	// Stryker report shape is a deserialization boundary, so the assertion is
	// from `unknown` (an explicit widening), not a structural smuggle.
	const files = raw.files as Record<string, StrykerFileEntry | undefined> | undefined;
	if (!files || typeof files !== "object") return report;

	for (const [path, entry] of Object.entries(files)) {
		if (!entry) continue;
		if (Array.isArray(entry.mutants)) {
			report.files[path] = aggregateMutants(entry.mutants);
		} else {
			report.files[path] = {
				killed: entry.killed ?? 0,
				survived: entry.survived ?? 0,
				timeout: entry.timeout,
				no_coverage: entry.no_coverage ?? entry.noCoverage,
				compile_error: entry.compile_error ?? entry.compileError,
				runtime_error: entry.runtime_error ?? entry.runtimeError,
			};
		}
	}
	return report;
}

function aggregateMutants(mutants: StrykerMutant[]): FileMutationStats {
	const stats: FileMutationStats = {
		killed: 0,
		survived: 0,
		timeout: 0,
		no_coverage: 0,
		compile_error: 0,
		runtime_error: 0,
	};
	for (const m of mutants) {
		switch ((m.status || "").toLowerCase()) {
			case "killed":
				stats.killed++;
				break;
			case "survived":
				stats.survived++;
				break;
			case "timeout":
				stats.timeout = (stats.timeout ?? 0) + 1;
				break;
			case "nocoverage":
			case "no_coverage":
				stats.no_coverage = (stats.no_coverage ?? 0) + 1;
				break;
			case "compileerror":
			case "compile_error":
				stats.compile_error = (stats.compile_error ?? 0) + 1;
				break;
			case "runtimeerror":
			case "runtime_error":
				stats.runtime_error = (stats.runtime_error ?? 0) + 1;
				break;
		}
	}
	return stats;
}

// ===========================================
// Score computation
// ===========================================

/**
 * Mutation score = killed / (killed + survived). Timeouts, compile errors,
 * and no-coverage mutants are excluded from the denominator per Stryker's
 * canonical definition (they aren't signal about test effectiveness).
 */
export function mutationScore(stats: FileMutationStats): number {
	const denom = stats.killed + stats.survived;
	if (denom === 0) return 0;
	return stats.killed / denom;
}

// ===========================================
// Compare
// ===========================================

interface MutationCompareOptions {
	config: MutationGateConfig;
	repoRoot: string;
	changedFiles?: string[];
}

type BaselineFileEntry = { score: number; killed: number };

/** One report entry resolved against the baseline, before any accounting. */
type FileMutationOutcome =
	| { kind: "skip" }
	| { kind: "new"; relPath: string; score: number; entry: FileMutationStats; belowFloor: boolean }
	| {
			kind: "decreased";
			relPath: string;
			score: number;
			entry: FileMutationStats;
			prior: BaselineFileEntry;
			belowFloor: boolean;
	  }
	| {
			kind: "same-or-improved";
			relPath: string;
			score: number;
			entry: FileMutationStats;
			prior: BaselineFileEntry;
			belowFloor: boolean;
	  };

/**
 * Resolves one report entry (path normalization, changed-file filtering,
 * floor check, and new/decreased/same-or-improved classification) without
 * mutating any accumulator — the caller applies the outcome.
 */
function resolveFileMutationOutcome(
	rawPath: string,
	entry: FileMutationStats | undefined,
	baseline: MutationBaseline,
	config: MutationGateConfig,
	repoRoot: string,
	changedSet: Set<string> | null,
): FileMutationOutcome {
	if (!entry) return { kind: "skip" };
	const relPath = normalizePath(rawPath, repoRoot);
	if (!relPath) return { kind: "skip" };
	if (changedSet && !changedSet.has(relPath)) return { kind: "skip" };

	const score = mutationScore(entry);
	const prior = baseline.files[relPath];

	// Floor check: below configured minimum score is always a warning,
	// regardless of ratchet state. Files without any test mutants
	// (denom=0) are treated as "no signal" and excluded from floor.
	const hasSignal = entry.killed + entry.survived > 0;
	const belowFloor = hasSignal && score < config.min_score;

	if (!prior) return { kind: "new", relPath, score, entry, belowFloor };
	if (score + 1e-9 < prior.score) {
		return { kind: "decreased", relPath, score, entry, prior, belowFloor };
	}
	return { kind: "same-or-improved", relPath, score, entry, prior, belowFloor };
}

/** Builds the below-floor finding for one non-skipped outcome. Pure — no accounting. */
function buildBelowFloorFinding(
	outcome: Exclude<FileMutationOutcome, { kind: "skip" }>,
	config: MutationGateConfig,
): MutationFinding {
	const priorScore = outcome.kind === "new" ? 0 : outcome.prior.score;
	return {
		name: "mutation_score_below_floor",
		severity: "warning",
		file: outcome.relPath,
		baseline_score: round(priorScore),
		current_score: round(outcome.score),
		message: `Mutation score for ${outcome.relPath} is ${(outcome.score * 100).toFixed(1)}% (floor: ${(config.min_score * 100).toFixed(0)}%). Add tests that kill the surviving mutants.`,
	};
}

export function compareMutation(
	report: MutationReport,
	baseline: MutationBaseline,
	options: MutationCompareOptions,
): MutationGateResult {
	const { config, repoRoot, changedFiles } = options;
	const findings: MutationFinding[] = [];
	const nextFiles: Record<string, BaselineFileEntry> = { ...baseline.files };
	const changedSet = changedFiles ? new Set(changedFiles) : null;

	let filesChecked = 0;
	let filesNew = 0;
	let filesBelowFloor = 0;
	let filesDecreased = 0;
	let filesImproved = 0;

	for (const [rawPath, entry] of Object.entries(report.files)) {
		const outcome = resolveFileMutationOutcome(rawPath, entry, baseline, config, repoRoot, changedSet);
		if (outcome.kind === "skip") continue;

		filesChecked++;
		if (outcome.belowFloor) {
			findings.push(buildBelowFloorFinding(outcome, config));
			filesBelowFloor++;
		}

		if (outcome.kind === "new") {
			filesNew++;
			nextFiles[outcome.relPath] = { score: outcome.score, killed: outcome.entry.killed };
			continue;
		}

		if (outcome.kind === "decreased") {
			findings.push({
				name: "mutation_score_decrease",
				severity: "error",
				file: outcome.relPath,
				baseline_score: round(outcome.prior.score),
				current_score: round(outcome.score),
				message: `Mutation score for ${outcome.relPath} dropped from ${(outcome.prior.score * 100).toFixed(1)}% to ${(outcome.score * 100).toFixed(1)}%. Investigate new survived mutants before merging.`,
			});
			filesDecreased++;
			// Preserve high-water mark.
			nextFiles[outcome.relPath] = outcome.prior;
			continue;
		}

		if (outcome.score > outcome.prior.score) filesImproved++;
		nextFiles[outcome.relPath] = { score: outcome.score, killed: Math.max(outcome.entry.killed, outcome.prior.killed) };
	}

	return {
		findings,
		stats: {
			files_checked: filesChecked,
			files_new: filesNew,
			files_below_floor: filesBelowFloor,
			files_decreased: filesDecreased,
			files_improved: filesImproved,
		},
		nextBaseline: {
			version: 1,
			updated_at: new Date().toISOString(),
			files: nextFiles,
		},
	};
}

function round(score: number): number {
	return Math.round(score * 1000) / 1000;
}

function normalizePath(rawPath: string, repoRoot: string): string | null {
	if (!rawPath) return null;
	const absolute = resolve(repoRoot, rawPath);
	const rel = relative(repoRoot, absolute).replace(/\\/g, "/");
	if (rel.startsWith("..") || rel === "") return null;
	return rel;
}
