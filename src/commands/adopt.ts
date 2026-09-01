// ===========================================
// interlinked adopt — one-command ratchet-from-here bootstrap
// ===========================================
// Legacy/large repos hit every gate at once on day 1: verify fires
// large_files/untested_files en masse, the PreToolUse line-cap gate freezes
// every over-cap file, and the coverage ratchet treats every file as "new".
// `adopt` seeds all the water-lines from the repo's CURRENT state so the
// gates become ratchets immediately — everything can only improve from here.
//
// Five steps, in order: trigram index build, large-files grandfather list,
// untested-files exemption list, coverage baseline snapshot, metric-caps
// defaults. All idempotent: a re-run refreshes each artifact but NEVER
// loosens an existing entry (the baseline-integrity direction rules) — the
// per-step write logic lives in adopt-steps.ts; this module owns the repo
// walk, the orchestration order, output, and the doctor row.
//
// The command runs as human-invoked plain `fs` writes from the CLI process,
// so it never passes through the PreToolUse baseline-integrity gate — the
// same sanctioned carve-out coverage-ratchet.ts's internal writes rely on.
// Agent-driven incremental baseline growth stays blocked by design.

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { baselinePath, loadBaseline } from "../harness/coverage-ratchet.js";
import {
	countLines,
	isCappableFile,
	loadLargeFileBaseline,
	maxLinesFor,
} from "../harness/large-file-policy.js";
import { METRIC_CAPS_REL } from "../harness/metric-caps.js";
import {
	DEFAULT_MIN_COVERAGE_PCT,
	evaluateTestedFile,
	hasCompanionTest,
	isTestableSourceFile,
	loadUntestedFilesBaseline,
	type UntestedFilesBaseline,
} from "../harness/tested-file-policy.js";
import { TrigramIndex } from "../harness/trigram-index.js";
import { getConfigDir } from "../lib/config.js";
import { c, header } from "../lib/formatter.js";
import {
	type AdoptStepResult,
	allowlistSnapshotStep,
	buildIndexStep,
	coverageStep,
	largeFilesStep,
	loadCoverageReport,
	metricCapsStep,
	type RepoScan,
	suiteBaselineStep,
	untestedFilesStep,
} from "./adopt-steps.js";
import type { CheckResult } from "./doctor-checks.js";
import { discoverFiles } from "./verify/file-discovery.js";

export type { AdoptStepResult } from "./adopt-steps.js";

interface AdoptOptions {
	cwd?: string;
	dryRun?: boolean;
	json?: boolean;
	/** Also run the suite once and record red/green + failing tests (step 6). */
	suiteBaseline?: boolean;
}

const STEP_COUNT = 6;

export async function adoptCommand(opts: AdoptOptions): Promise<void> {
	const cwd = resolve(opts.cwd || process.cwd());
	const dryRun = opts.dryRun === true;
	const json = opts.json === true;
	const withSuiteBaseline = opts.suiteBaseline === true;
	const stepCount = withSuiteBaseline ? STEP_COUNT + 1 : STEP_COUNT;
	const say = (line: string): void => {
		if (!json) console.log(line);
	};

	say(
		`${dryRun ? "[dry-run] " : ""}Adopting interlinked ratchets from the current state of ${cwd}`,
	);

	// One coverage-report load feeds both the untested-files coverage axis
	// (step 3) and the coverage baseline snapshot (step 4); one tree walk
	// feeds both offender lists (steps 2 + 3).
	const coverage = loadCoverageReport(cwd);
	const scan = scanRepo(cwd, coverage.perFileLinesPct);

	const steps: AdoptStepResult[] = [];
	const sayStep = (n: number, result: AdoptStepResult): void => {
		steps.push(result);
		say(`  [${n}/${stepCount}] ${result.label}: ${actionWord(result.action)} — ${result.detail}`);
	};
	const runStep = (n: number, fn: () => AdoptStepResult): void => {
		sayStep(n, fn());
	};

	runStep(1, () => buildIndexStep(cwd, dryRun));
	runStep(2, () => largeFilesStep(cwd, scan, dryRun));
	runStep(3, () => untestedFilesStep(cwd, scan, dryRun));
	runStep(4, () => coverageStep(cwd, coverage, dryRun));
	runStep(5, () => metricCapsStep(cwd, dryRun));
	runStep(6, () => allowlistSnapshotStep(cwd, dryRun));
	// Step 7 is opt-in: the only step that RUNS project code (one suite pass).
	if (withSuiteBaseline) sayStep(7, await suiteBaselineStep(cwd, dryRun));

	if (json) {
		console.log(JSON.stringify({ cwd, dry_run: dryRun, steps }, null, 2));
	} else {
		renderSummary(steps, dryRun);
	}
	if (steps.some((s) => s.action === "failed")) process.exitCode = 1;
}

// ===========================================
// Repo scan (steps 2 + 3 share one walk)
// ===========================================

/**
 * Walk the repo once (same universe as `interlinked verify` — git ls-files
 * with fallback, via `discoverFiles`) and collect both offender sets with the
 * exact predicates the gates use, so adopt's lists match verify's findings.
 */
function scanRepo(cwd: string, linesPctByFile: Map<string, number>): RepoScan {
	const maxLines = maxLinesFor(cwd);
	const minCoveragePct =
		loadUntestedFilesBaseline(cwd)?.min_coverage_pct ?? DEFAULT_MIN_COVERAGE_PCT;
	// Threshold carrier only — the grandfather set stays empty so
	// `evaluateTestedFile` reports raw untested-ness, not grandfathered-ness.
	const thresholdOnly: UntestedFilesBaseline = {
		version: 1,
		min_coverage_pct: minCoveragePct,
		files: new Set(),
	};
	const overCap = new Map<string, number>();
	const untested: string[] = [];
	for (const abs of discoverFiles(cwd)) {
		const rel = relative(cwd, abs).replace(/\\/g, "/");
		let content: string;
		try {
			content = readFileSync(abs, "utf-8");
		} catch {
			continue; // unreadable (permission, race) — skip
		}
		const file = { filePath: rel, content };
		if (isCappableFile(file)) {
			const lines = countLines(content);
			if (lines > maxLines) overCap.set(rel, lines);
		}
		if (isTestableSourceFile(file)) {
			const verdict = evaluateTestedFile({
				input: {
					relPath: rel,
					hasCompanion: hasCompanionTest(rel, cwd),
					coveragePct: linesPctByFile.get(rel) ?? null,
				},
				baseline: thresholdOnly,
			});
			if (verdict.untested) untested.push(rel);
		}
	}
	return { maxLines, minCoveragePct, overCap, untested };
}

// ===========================================
// Output
// ===========================================

function actionWord(action: AdoptStepResult["action"]): string {
	switch (action) {
		case "written":
			return c.green("written");
		case "would-write":
			return c.yellow("would write");
		case "unchanged":
			return c.dim("unchanged");
		case "failed":
			return c.red("FAILED");
	}
}

function renderSummary(steps: AdoptStepResult[], dryRun: boolean): void {
	console.log("");
	console.log(header("Adoption summary"));
	const labelWidth = Math.max(...steps.map((s) => s.label.length));
	for (const s of steps) {
		console.log(
			`  ${s.label.padEnd(labelWidth)}  ${actionWord(s.action).padEnd(20)} ${s.detail}`,
		);
	}
	for (const s of steps) {
		if (s.note === undefined) continue;
		console.log("");
		console.log(c.dim(s.note));
	}
	console.log("");
	if (dryRun) {
		console.log(c.dim("  Dry run — nothing was written. Re-run without --dry-run to apply."));
	} else {
		console.log(
			c.dim("  Ratchets armed. Re-run `interlinked adopt` any time to refresh (never loosens)."),
		);
	}
}

// ===========================================
// Doctor integration
// ===========================================

/** Presence probes for the adoption artifacts, in bootstrap order. */
const DOCTOR_ARTIFACTS: ReadonlyArray<{ label: string; present: (cwd: string) => boolean }> = [
	{ label: "trigram index", present: (cwd) => TrigramIndex.loadMeta(cwd) !== null },
	{ label: "large-files-baseline.json", present: (cwd) => loadLargeFileBaseline(cwd) !== null },
	{
		label: "untested-files-baseline.json",
		present: (cwd) => loadUntestedFilesBaseline(cwd) !== null,
	},
	{
		label: "coverage-baseline.json",
		present: (cwd) => existsSync(baselinePath(getConfigDir(cwd))),
	},
	{ label: "metric-caps.json", present: (cwd) => existsSync(join(cwd, METRIC_CAPS_REL)) },
];

/**
 * One `interlinked doctor` row reporting missing/stale adoption artifacts.
 * Missing baselines mean verify screams and the ratchets are inert; an empty
 * coverage baseline means every file reads as "new" to the coverage ratchet.
 * Both point at the same fix: `interlinked adopt`.
 */
export function adoptionArtifactChecks(cwd: string): CheckResult[] {
	const missing = DOCTOR_ARTIFACTS.filter((a) => !a.present(cwd)).map((a) => a.label);
	if (missing.length > 0) {
		return [
			{
				name: "Adoption baselines",
				status: "warn",
				message: `Missing: ${missing.join(", ")} -- run 'interlinked adopt' to ratchet from here`,
			},
		];
	}
	const covBaseline = loadBaseline(getConfigDir(cwd));
	if (Object.keys(covBaseline.files).length === 0) {
		return [
			{
				name: "Adoption baselines",
				status: "warn",
				message:
					"coverage-baseline.json is empty (ratchet inert) -- generate a coverage report and re-run 'interlinked adopt'",
			},
		];
	}
	return [
		{
			name: "Adoption baselines",
			status: "pass",
			message: "All ratchet baselines + trigram index present",
		},
	];
}
