// ===========================================
// adopt-steps — the five bootstrap steps behind `interlinked adopt`
// ===========================================
// Split out of adopt.ts (line-cap discipline): adopt.ts owns the walk, the
// orchestration order, output, and the doctor row; this module owns each
// step's write logic and its direction rules. Every step is idempotent and
// never loosens an existing baseline entry — where regeneration would loosen,
// the tighter recorded value is kept and reported via `kept_tighter`.
//
// All writes are plain `fs` from the human-invoked CLI process, so they never
// pass through the PreToolUse baseline-integrity gate (the same sanctioned
// carve-out coverage-ratchet.ts's internal writes rely on).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { loadCheckPolicy } from "../harness/check-policy.js";
import { takeAllowlistSnapshot } from "./allowlist.js";
import { coverageSetupGuidance } from "../harness/coverage-adapters.js";
import {
	baselinePath,
	type CoverageSummary,
	compareCoverage,
	emptyBaseline,
	loadBaseline,
	saveBaseline,
} from "../harness/coverage-ratchet.js";
import {
	type CoverageLanguage,
	coverageRunnerFor,
} from "../harness/coverage-runner.js";
import {
	DEFAULT_MAX_LINES,
	type LargeFileBaseline,
	loadLargeFileBaseline,
	saveLargeFileBaseline,
} from "../harness/large-file-policy.js";
import { METRIC_CAPS_REL, METRIC_DEFS, resetMetricCapsCache } from "../harness/metric-caps.js";
import { detectRepoProfile } from "../harness/repo-profile.js";
import { writeSuiteBaseline } from "../harness/suite-baseline.js";
import {
	DEFAULT_MIN_COVERAGE_PCT,
	loadUntestedFilesBaseline,
	saveUntestedFilesBaseline,
	type UntestedFilesBaseline,
} from "../harness/tested-file-policy.js";
import { TrigramIndex } from "../harness/trigram-index.js";
import { getConfigDir } from "../lib/config.js";
import { loadMergedReport, resolveReportPaths } from "./coverage.js";

/** What one adoption step did (or would do, under --dry-run). */
export interface AdoptStepResult {
	/** Machine id (stable — the --json contract). */
	step:
		| "index"
		| "large_files"
		| "untested_files"
		| "coverage"
		| "metric_caps"
		| "allowlist_snapshot"
		| "suite_baseline";
	/** Human label for progress lines + the summary table. */
	label: string;
	action: "written" | "would-write" | "unchanged" | "failed";
	/** One-line outcome, shown in the progress line and summary table. */
	detail: string;
	/** Optional multi-line follow-up (e.g. coverage setup guidance). */
	note?: string;
	/** Entries where regeneration would have LOOSENED an existing baseline
	 *  value; the tighter recorded value was kept instead. */
	kept_tighter?: number;
}

/** The offender sets one repo walk produced (built by adopt.ts::scanRepo). */
export interface RepoScan {
	/** The EFFECTIVE line cap (metric-caps override → baseline → default). */
	maxLines: number;
	/** The effective untested-files coverage threshold. */
	minCoveragePct: number;
	/** Over-cap cappable files: repo-relative POSIX path → current line count. */
	overCap: Map<string, number>;
	/** Testable source files with no companion test and thin/absent coverage. */
	untested: string[];
}

// ===========================================
// Step 1 — trigram index
// ===========================================

export function buildIndexStep(cwd: string, dryRun: boolean): AdoptStepResult {
	const base = { step: "index" as const, label: "Trigram index" };
	if (dryRun) {
		return {
			...base,
			action: "would-write",
			detail: "would build .interlinked/index/ from the working tree",
		};
	}
	try {
		const index = TrigramIndex.build({ cwd });
		index.save(join(cwd, ".interlinked"));
		const stats = index.stats();
		return { ...base, action: "written", detail: `${stats.fileCount} files indexed` };
	} catch (err) {
		return {
			...base,
			action: "failed",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// ===========================================
// Step 2 — large-files grandfather list
// ===========================================

/** The regenerated grandfather map + the two counts the detail line reports:
 *  `keptTighter` files held at a smaller recorded ceiling, and `refused` NEW
 *  over-cap files a re-run withheld (always 0 on first adoption). */
interface GrandfatherPlan {
	files: Record<string, number>;
	keptTighter: number;
	refused: number;
}

/**
 * Regenerate the grandfather map from the scan, honoring the ratchet direction.
 *
 * First adoption (`existing === null`) grandfathers every over-cap file. A
 * RE-RUN must NOT GROW the set: a file that went over-cap AFTER the first
 * adoption is a NEW offender, and grandfathering it pre-authorizes an over-cap
 * file — the exact loosening the baseline-integrity gate blocks on the agent
 * Write path. Adopt writes via plain `fs` and bypasses that gate, so the
 * no-grow rule is enforced HERE: such a file is REFUSED (decompose it under the
 * cap instead). An already-recorded file's ceiling may only shrink — a file
 * that grew past it keeps the TIGHTER recorded count.
 */
function planGrandfather(
	existing: LargeFileBaseline | null,
	overCap: Map<string, number>,
): GrandfatherPlan {
	const files: Record<string, number> = {};
	let keptTighter = 0;
	let refused = 0;
	for (const [rel, lines] of overCap) {
		const recorded = existing?.files[rel];
		if (existing && recorded === undefined) {
			refused++; // re-run: a new over-cap offender — do not grandfather it
			continue;
		}
		if (recorded !== undefined && recorded < lines) {
			files[rel] = recorded;
			keptTighter++;
		} else {
			files[rel] = lines;
		}
	}
	return { files, keptTighter, refused };
}

export function largeFilesStep(cwd: string, scan: RepoScan, dryRun: boolean): AdoptStepResult {
	const existing = loadLargeFileBaseline(cwd);
	const { files, keptTighter, refused } = planGrandfather(existing, scan.overCap);
	const next: LargeFileBaseline = {
		version: existing?.version ?? 1,
		// max_lines is preserved verbatim — adopt records offenders, it never
		// moves the cap (that's `interlinked caps set lines`).
		max_lines: existing?.max_lines ?? DEFAULT_MAX_LINES,
		files,
	};
	if (!dryRun) saveLargeFileBaseline(cwd, next);
	const tighterNote =
		keptTighter > 0 ? `; ${keptTighter} kept at their tighter recorded count` : "";
	const refusedNote =
		refused > 0
			? `; ${refused} new over-cap file(s) REFUSED (a re-run cannot grow the grandfather set — decompose them)`
			: "";
	return {
		step: "large_files",
		label: "Large-files grandfather list",
		action: dryRun ? "would-write" : "written",
		detail: `${Object.keys(files).length} file(s) over ${scan.maxLines} lines grandfathered${tighterNote}${refusedNote}`,
		kept_tighter: keptTighter,
	};
}

// ===========================================
// Step 3 — untested-files exemption list
// ===========================================

/** The regenerated exemption set + the counts the detail line reports:
 *  `added` files bootstrapped on first adoption (always 0 on a re-run, which
 *  never adds), `dropped` entries that gained a test/coverage, and `refused`
 *  NEW untested files a re-run withheld. */
interface ExemptionPlan {
	files: Set<string>;
	added: number;
	dropped: number;
	refused: number;
}

/**
 * Regenerate the untested-files exemption set, honoring the ratchet direction.
 *
 * First adoption (`existing === null`) exempts every currently-untested file. A
 * RE-RUN must NOT GROW the list: a file that became untested AFTER the first
 * adoption is a NEW offender, and exempting it loosens the coverage floor — the
 * exact loosening the baseline-integrity gate blocks on the agent Write path.
 * Adopt writes via plain `fs` and bypasses that gate, so the no-grow rule is
 * enforced HERE: such a file is REFUSED (cover it instead). Entries whose files
 * gained a test/coverage drop off — a safe shrink.
 */
function planExemptions(
	existing: UntestedFilesBaseline | null,
	scanned: Set<string>,
): ExemptionPlan {
	if (!existing) return { files: scanned, added: scanned.size, dropped: 0, refused: 0 };
	// Re-run: keep only still-untested files that were already exempted.
	const files = new Set([...scanned].filter((f) => existing.files.has(f)));
	const dropped = [...existing.files].filter((f) => !scanned.has(f)).length;
	const refused = [...scanned].filter((f) => !existing.files.has(f)).length;
	return { files, added: 0, dropped, refused };
}

export function untestedFilesStep(cwd: string, scan: RepoScan, dryRun: boolean): AdoptStepResult {
	const existing = loadUntestedFilesBaseline(cwd);
	const { files, added, dropped, refused } = planExemptions(existing, new Set(scan.untested));
	const next: UntestedFilesBaseline = {
		version: existing?.version ?? 1,
		// Preserved verbatim, like max_lines above — adopt never moves thresholds.
		min_coverage_pct: existing?.min_coverage_pct ?? DEFAULT_MIN_COVERAGE_PCT,
		files,
	};
	if (!dryRun) saveUntestedFilesBaseline(cwd, next);
	const refusedNote =
		refused > 0
			? `; ${refused} new offender(s) REFUSED (a re-run cannot grow the exemption list — cover them)`
			: "";
	return {
		step: "untested_files",
		label: "Untested-files exemption list",
		action: dryRun ? "would-write" : "written",
		detail: `${files.size} untested file(s) exempted (${added} new, ${dropped} dropped)${refusedNote}`,
	};
}

// ===========================================
// Step 4 — coverage baseline
// ===========================================

/** A located-and-merged coverage report (or the reasons there isn't one). */
interface LoadedCoverage {
	summary: CoverageSummary | null;
	/** Human label of the merged report set ("" when none). */
	reportLabel: string;
	/** Report path that failed to parse, when any (aborts the merge loudly). */
	failedPath: string | null;
	/** Per-file lines.pct keyed by repo-relative POSIX path (step 3's axis). */
	perFileLinesPct: Map<string, number>;
}

/** Locate + merge existing coverage reports via the exact `interlinked
 *  coverage check` path. Never RUNS the suite — adopt only snapshots. */
export function loadCoverageReport(cwd: string): LoadedCoverage {
	const none: LoadedCoverage = {
		summary: null,
		reportLabel: "",
		failedPath: null,
		perFileLinesPct: new Map(),
	};
	const paths = resolveReportPaths(cwd);
	if (paths.length === 0) return none;
	const loaded = loadMergedReport(paths, cwd);
	if (loaded.failedPath !== null) return { ...none, failedPath: loaded.failedPath };
	const perFileLinesPct = new Map<string, number>();
	for (const [rawPath, entry] of Object.entries(loaded.summary)) {
		if (!entry || rawPath === "total") continue;
		const rel = relative(cwd, resolve(cwd, rawPath)).replace(/\\/g, "/");
		if (rel.startsWith("..") || rel === "") continue;
		perFileLinesPct.set(rel, entry.lines?.pct ?? 0);
	}
	return {
		summary: loaded.summary,
		reportLabel: paths.map((p) => relative(cwd, p)).join(" + "),
		failedPath: null,
		perFileLinesPct,
	};
}

export function coverageStep(
	cwd: string,
	coverage: LoadedCoverage,
	dryRun: boolean,
): AdoptStepResult {
	const base = { step: "coverage" as const, label: "Coverage baseline" };
	if (coverage.failedPath !== null) {
		return {
			...base,
			action: "failed",
			detail: `could not parse coverage report at ${coverage.failedPath}`,
		};
	}
	const configDir = getConfigDir(cwd);
	if (coverage.summary === null) return coverageStepNoReport(cwd, configDir, dryRun);

	// compareCoverage's nextBaseline is direction-safe by construction: a
	// decreased metric stays at its prior high-water, so merging a fresh
	// report into an existing baseline can only hold or rise.
	const result = compareCoverage(coverage.summary, loadBaseline(configDir), {
		config: loadCheckPolicy(cwd).coverage_ratchet,
		repoRoot: cwd,
	});
	const keptTighter = result.stats.files_decreased;
	const tighterNote =
		keptTighter > 0 ? `; ${keptTighter} below their high-water kept at the tighter value` : "";
	if (!dryRun) saveBaseline(configDir, result.nextBaseline);
	return {
		...base,
		action: dryRun ? "would-write" : "written",
		detail: `${Object.keys(result.nextBaseline.files).length} per-file high-water(s) from ${coverage.reportLabel}${tighterNote}`,
		kept_tighter: keptTighter,
	};
}

/** The no-report branch: seed an empty-but-valid baseline (once) and point at
 *  the per-language commands that generate a report. Never runs the suite. */
function coverageStepNoReport(cwd: string, configDir: string, dryRun: boolean): AdoptStepResult {
	const base = { step: "coverage" as const, label: "Coverage baseline" };
	if (existsSync(baselinePath(configDir))) {
		return {
			...base,
			action: "unchanged",
			detail: "no coverage report found; existing baseline kept",
		};
	}
	const note = `Generate a coverage report, then re-run \`interlinked adopt\` to snapshot per-file high-waters:\n${coverageSetupGuidance(cwd)}`;
	if (dryRun) {
		return {
			...base,
			action: "would-write",
			detail: "no coverage report found; would write an empty baseline",
			note,
		};
	}
	saveBaseline(configDir, emptyBaseline());
	return {
		...base,
		action: "written",
		detail: "no coverage report found; wrote an empty baseline",
		note,
	};
}

// ===========================================
// Step 5 — metric caps
// ===========================================

export function metricCapsStep(cwd: string, dryRun: boolean): AdoptStepResult {
	const base = { step: "metric_caps" as const, label: "Metric caps" };
	const path = join(cwd, METRIC_CAPS_REL);
	// Only-if-absent: an existing metric-caps.json is user policy — adopt
	// never touches it (loosening OR tightening; that's `interlinked caps`).
	if (existsSync(path)) {
		return { ...base, action: "unchanged", detail: "existing metric-caps.json respected" };
	}
	const defaults: Record<string, number> = {};
	for (const def of METRIC_DEFS) defaults[def.configKey] = def.defaultValue;
	const summary = METRIC_DEFS.map((d) => `${d.key}=${d.defaultValue}`).join(" ");
	if (dryRun) {
		return { ...base, action: "would-write", detail: `would write defaults (${summary})` };
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: 1, ...defaults }, null, 2)}\n`, "utf-8");
	resetMetricCapsCache();
	return { ...base, action: "written", detail: `defaults written (${summary})` };
}

// ===========================================
// Step 6 — supply-chain allowlist snapshot
// ===========================================

/** Pre-approve the repo's CURRENT dependency state (2026-08-17). The install
 *  gate fail-closes `npm install`/`pip install` from the first session, and a
 *  brand-new adopter's most likely "why is this tool blocking me" moment is a
 *  dependency they already had. Adopt's whole semantic is "accept current
 *  reality as the baseline", so the snapshot belongs here: existing manifests
 *  and lockfiles get hashed into approving grants, and the gate then only
 *  prompts on genuinely NEW packages. */
export function allowlistSnapshotStep(cwd: string, dryRun: boolean): AdoptStepResult {
	const base = { step: "allowlist_snapshot" as const, label: "Install allowlist" };
	if (dryRun) {
		return {
			...base,
			action: "would-write",
			detail: "would snapshot existing manifests/lockfiles into the install allowlist",
		};
	}
	try {
		const { taken } = takeAllowlistSnapshot({ cwd, by: "adopt", reason: "adopt: current deps" });
		if (taken.length === 0) {
			return { ...base, action: "unchanged", detail: "no manifest/lockfile found to snapshot" };
		}
		return { ...base, action: "written", detail: `snapshotted ${taken.join(", ")}` };
	} catch (err) {
		return {
			...base,
			action: "failed",
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

// ===========================================
// Step 7 (opt-in) — suite green-baseline (`adopt --suite-baseline`)
// ===========================================

/** Dependency seam so tests can stub the runner without spawning a suite. */
type SuiteRunnerResolver = typeof coverageRunnerFor;

/**
 * Record the suite's CURRENT red/green state to `.interlinked/suite-baseline.json`
 * so the commit gate's red-bar can tell pre-existing failures from agent-caused
 * ones (it then blocks only NEW failures — see commit-gate-decision.ts). Opt-in
 * (`--suite-baseline`) because it is the one adopt step that RUNS project code:
 * a full suite execution via the language's coverage runner.
 */
export async function suiteBaselineStep(
	cwd: string,
	dryRun: boolean,
	resolveRunner: SuiteRunnerResolver = coverageRunnerFor,
): Promise<AdoptStepResult> {
	const base = { step: "suite_baseline" as const, label: "Suite baseline" };
	const profile = detectRepoProfile(cwd);
	const language = pickSuiteLanguage(profile.runners);
	if (!language) {
		return {
			...base,
			action: "unchanged",
			detail: "no supported test runner detected (vitest/jest/pytest) — nothing recorded",
		};
	}
	if (dryRun) {
		return {
			...base,
			action: "would-write",
			detail: `would run the ${language} suite once and record red/green + failing tests`,
		};
	}
	const runner = resolveRunner(language);
	if (!runner) {
		return { ...base, action: "unchanged", detail: `no coverage runner for ${language}` };
	}
	const result = await runner.run({
		projectRoot: cwd,
		coverageDir: join(cwd, ".interlinked", "coverage"),
	});
	if (!result.ok) {
		return {
			...base,
			action: "failed",
			detail: `suite run failed (${result.error ?? "runner error"}) — baseline not recorded`,
		};
	}
	const green = result.testsPassed !== false;
	const failing = green ? [] : (result.failingTests ?? []);
	writeSuiteBaseline(cwd, {
		recorded_at: new Date().toISOString(),
		language,
		green,
		failing_tests: failing,
	});
	return {
		...base,
		action: "written",
		detail: green
			? "suite is GREEN — recorded (the commit-gate red-bar blocks any future failure)"
			: `suite is RED — ${failing.length} pre-existing failing test(s) recorded (red-bar blocks only NEW failures)`,
	};
}

/** The suite language to record: js/ts wins when both stacks are present
 *  (one baseline per repo — the ts runner also serves plain js). */
function pickSuiteLanguage(runners: { js: boolean; python: boolean }): CoverageLanguage | null {
	if (runners.js) return "ts";
	if (runners.python) return "python";
	return null;
}
