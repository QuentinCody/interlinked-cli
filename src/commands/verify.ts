// ===========================================
// Verify Command — deterministic codebase verification
// ===========================================
// Runs tsc + biome on a project and reports errors. Optionally runs scored
// regex suggestions (--suggestions). Respects interlinked-ignore comments.
//
// Usage:
//   interlinked verify                     # tsc + biome on current project
//   interlinked verify --suggestions       # + scored regex heuristics
//   interlinked verify --json              # Machine-readable output
//   interlinked verify --details           # Show file paths for all findings
//   interlinked verify --file foo.ts       # Single file
//   interlinked verify --changed           # Changed files only
//   interlinked verify --staged            # Staged files only
//   interlinked verify https://github.com/owner/repo  # Remote repo
//
// Implementation is split across `src/commands/verify/`:
//   - advisory.ts          — DEFAULT_ADVISORY_SKIPS, TOOL_IDS, skip-set helpers
//   - clone-repo.ts        — git URL detection + `git clone`
//   - file-discovery.ts    — CODE_EXTENSIONS + discoverFiles
//   - suppressions.ts      — inline suppression-comment detection
//   - tool-results-types.ts — shared type definitions
//   - tool-results.ts      — runCodeQualityChecks + runSuggestions
//   - output-json.ts       — JSON batch output
//   - section-table.ts     — declarative list of streaming sections
//   - streaming-output.ts  — human-readable streaming output
//   - structure.ts         — structure verification (graph, rules, adoption)

import { existsSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { CheckEngine, type CheckResult, formatToolReport } from "../harness/check-engine/index.js";
import { tryAcquireProjectHeavyProcessLease } from "../harness/project-heavy-process-lock.js";
import {
	detectDecisionSurface,
	detectLockfileMultiplicity,
} from "../harness/quality-checks/decision-surface.js";
import { computeDecisionSurfaceRatchet } from "../harness/quality-checks/decision-surface-ratchet.js";
import {
	type RegistryDriftFinding,
	runRegistryParityCheck,
} from "../harness/registry-parity.js";
import type { Finding } from "../harness/suggestion-scorer.js";
import {
	addSuppressions,
	loadFileSuppressions,
	loadSuppressionFile,
	parseSuppressionEntry,
} from "../harness/suppressions.js";

import { DEFAULT_ADVISORY_SKIPS, TOOL_IDS } from "./verify/advisory.js";
import { getEffectiveSkipChecks, getSkipTools } from "./verify/advisory-skips.js";
import { cloneRepo, isGitUrl, normalizeGitUrl, repoDisplayName } from "./verify/clone-repo.js";
import { runCodeQualityPhase } from "./verify/code-quality-phase.js";
import { discoverFiles } from "./verify/file-discovery.js";
import { outputJson } from "./verify/output-json.js";
import { createScanProgress } from "./verify/scan-progress.js";
import { setActiveSkipChecks } from "./verify/streaming-output.js";
import { buildStructureJsonSection, runStructureVerify } from "./verify/structure.js";
import {
	checkProjectSetup,
	filterCodeQualityResultsInPlace,
	runCodeQualityChecksProgressive,
	runSuggestions,
} from "./verify/tool-results.js";
import { emptyResults } from "./verify/tool-results-types.js";
import {
	emitVerifyRun,
	streamCaseDivergence,
	streamDecisionSurfaceRatchet,
	streamLockfileMultiplicity,
	streamProjectSetup,
	streamRegistryParity,
	streamSuggestionsSummary,
	streamSupermodelDeadCode,
	summarizeFlaggedFiles,
} from "./verify/verify-summary.js";
import { streamExternalTools } from "./verify/verify-tools.js";

// Re-export for consumers (tests + external scripts that imported these
// names historically from this file). These names are load-bearing — the
// `__tests__/verify.test.ts` regression pin imports `DEFAULT_ADVISORY_SKIPS`
// and `summarizeFlaggedFiles` directly from here.
export { DEFAULT_ADVISORY_SKIPS } from "./verify/advisory.js";
export { cloneRepo, isGitUrl, normalizeGitUrl, repoDisplayName } from "./verify/clone-repo.js";
export { CODE_EXTENSIONS, discoverFiles } from "./verify/file-discovery.js";
export { summarizeFlaggedFiles } from "./verify/verify-summary.js";
export type { ToolSpec } from "./verify/verify-tools.js";

const CHECK_ENGINE_TIMEOUT_MS = 30_000;
const SUGGESTIONS_LIMIT = 3;
const SUGGESTIONS_THRESHOLD = 0.5;

interface VerifyOpts {
	target?: string;
	file?: string;
	changed?: boolean;
	staged?: boolean;
	cwd?: string;
	only?: string;
	json?: boolean;
	details?: boolean;
	suggestions?: boolean;
	branch?: string;
	subdir?: string;
	suppress?: string[];
	showSuppressions?: boolean;
	structure?: boolean;
	structureOnly?: boolean;
	adoptionGate?: boolean;
	allChecks?: boolean;
	deadCode?: boolean;
	skip?: string;
}

/**
 * Public API — consumed by `src/index.ts` and tests.
 *
 * Top-level entry point dispatched from `interlinked verify`. Handles
 * suppression-management subflags, remote-repo cloning, and local-path
 * scanning. Actual checks live in `runVerify`.
 */
export async function verifyCommand(opts: VerifyOpts): Promise<void> {
	const cwd = opts.cwd || process.cwd();
	const interlinkedDir = join(cwd, ".interlinked");

	if (opts.showSuppressions) {
		displaySuppressions(interlinkedDir);
		return;
	}

	if (opts.suppress && opts.suppress.length > 0) {
		const ok = applySuppressions(opts.suppress, interlinkedDir);
		if (!ok) return;
		// Continue to run verify so user sees updated results
	}

	if (opts.structureOnly) {
		await runStructureVerify(opts.cwd || process.cwd(), opts);
		return;
	}

	if (opts.target && isGitUrl(opts.target)) {
		await runRemoteVerify(opts.target, opts);
		return;
	}

	if (opts.target) {
		await runLocalTargetVerify(opts.target, opts);
		return;
	}

	await runVerify(cwd, opts);
}

/** Resolves an explicit local `--target` path and verifies it when it is a directory. */
async function runLocalTargetVerify(target: string, opts: VerifyOpts): Promise<void> {
	const targetPath = isAbsolute(target) ? target : resolve(opts.cwd || process.cwd(), target);
	if (!existsSync(targetPath)) {
		process.stderr.write(
			`Target not found: ${target}\n` +
				"  For remote repos, use a full URL: interlinked verify https://github.com/owner/repo\n",
		);
		process.exitCode = 1;
		return;
	}
	const stat = statSync(targetPath);
	if (stat.isDirectory()) {
		await runVerify(targetPath, opts);
	} else {
		process.stderr.write(`Target is not a directory: ${target}\n`);
		process.exitCode = 1;
	}
}

function displaySuppressions(interlinkedDir: string): void {
	const data = loadSuppressionFile(interlinkedDir);
	const entries = Object.entries(data);
	if (entries.length === 0) {
		process.stderr.write("\n  No suppressions configured.\n");
		process.stderr.write("  Add one with: interlinked verify --suppress file:check\n\n");
		return;
	}
	process.stderr.write(
		"\n  \x1b[1mActive suppressions\x1b[0m (.interlinked/verify-suppressions.json)\n\n",
	);
	for (const [filePath, checks] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
		process.stderr.write(`  \x1b[36m${filePath}\x1b[0m\n`);
		if (!checks) continue;
		for (const [checkName, entry] of Object.entries(checks).sort((a, b) =>
			a[0].localeCompare(b[0]),
		)) {
			const reason = entry.reason ? ` \x1b[2m— ${entry.reason}\x1b[0m` : "";
			process.stderr.write(`    ${checkName}${reason}\n`);
		}
	}
	process.stderr.write("\n");
}

function applySuppressions(suppress: string[], interlinkedDir: string): boolean {
	const parsed: Array<{ file: string; check: string; reason: string }> = [];
	for (const entry of suppress) {
		const result = parseSuppressionEntry(entry);
		if (!result) {
			process.stderr.write(
				`  \x1b[31merror\x1b[0m: invalid suppression format: "${entry}"\n` +
					"  Expected: file:check or file:check:reason\n",
			);
			process.exitCode = 1;
			return false;
		}
		parsed.push(result);
	}

	let added: ReturnType<typeof addSuppressions>;
	try {
		added = addSuppressions(interlinkedDir, parsed);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(
			`\n  \x1b[31mSuppression rejected:\x1b[0m ${msg}\n` +
				"  Edit .interlinked/verify-suppressions.json directly to add the required `ticket` or `expires_at` fields.\n\n",
		);
		process.exitCode = 1;
		return false;
	}
	if (added.length > 0) {
		process.stderr.write("\n  \x1b[32mSuppressions added:\x1b[0m\n");
		for (const entry of added) {
			const reason = entry.reason ? ` \x1b[2m— ${entry.reason}\x1b[0m` : "";
			process.stderr.write(`    ${entry.file}:${entry.check}${reason}\n`);
		}
		process.stderr.write("\n  Written to .interlinked/verify-suppressions.json\n");
	} else {
		process.stderr.write("\n  All entries already suppressed.\n");
	}
	process.stderr.write("\n");
	return true;
}

async function runRemoteVerify(target: string, opts: VerifyOpts): Promise<void> {
	const url = normalizeGitUrl(target);
	if (!opts.json) process.stderr.write(`\n  cloning ${repoDisplayName(url)}...\n`);

	let cloneResult: { dir: string; elapsed_ms: number };
	try {
		cloneResult = cloneRepo(url, { branch: opts.branch });
	} catch (err: unknown) {
		process.stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
		return;
	}

	if (!opts.json) {
		process.stderr.write(`  cloned in ${(cloneResult.elapsed_ms / 1000).toFixed(1)}s\n`);
	}
	const scanDir = opts.subdir ? join(cloneResult.dir, opts.subdir) : cloneResult.dir;

	try {
		await runVerify(scanDir, opts);
	} finally {
		rmSync(cloneResult.dir, { recursive: true, force: true });
	}
}

async function runVerify(cwd: string, opts: VerifyOpts): Promise<void> {
	let releaseHeavyProcess: (() => void) | null;
	try {
		releaseHeavyProcess = tryAcquireProjectHeavyProcessLease(cwd);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		process.stderr.write(
			`  verify unavailable: project admission failed (${detail}); no verification verdict was produced.\n`,
		);
		process.exitCode = 1;
		return;
	}
	if (!releaseHeavyProcess) {
		process.stderr.write(
			"  verify deferred: another heavyweight Interlinked check is already running for this project; no verification verdict was produced.\n",
		);
		process.exitCode = 1;
		return;
	}
	try {
		await runVerifyWithHeavyProcessLease(cwd, opts);
	} finally {
		releaseHeavyProcess();
	}
}

/** Run one verify after the caller owns the cross-process project lane. */
async function runVerifyWithHeavyProcessLease(cwd: string, opts: VerifyOpts): Promise<void> {
	const files = discoverFiles(cwd);
	const engine = new CheckEngine(cwd);
	const details = opts.details ?? false;
	const skipChecks = getEffectiveSkipChecks(opts.skip, opts.allChecks);
	setActiveSkipChecks(skipChecks);
	const scope = { projectRoot: cwd, mode: "project" as const };

	if (opts.json) {
		await runVerifyBatchJson({ engine, files, cwd, opts, scope });
		return;
	}

	process.stderr.write(`\n  ${formatToolReport(engine.discoverTools())}\n`);
	process.stderr.write(`\n  \x1b[1minterlinked verify\x1b[0m · ${files.length} files\n`);

	const summary: Array<{ label: string; count: number; color: string }> = [];
	const allFlaggedFiles = new Set<string>();

	streamProjectSetup(cwd, allFlaggedFiles);
	streamRegistryParity(cwd, allFlaggedFiles);
	streamLockfileMultiplicity(detectLockfileMultiplicity(cwd));
	streamDecisionSurfaceRatchet(computeDecisionSurfaceRatchet(cwd));
	if (opts.allChecks) streamCaseDivergence(cwd, files, allFlaggedFiles);

	const cqStart = Date.now();
	// `--only` promises one external tool. Previously it still ran the entire
	// inline census first, retaining ~1.6 GB on this repository before tsc.
	if (!opts.only) {
		await runCodeQualityPhase({
			files,
			cwd,
			skipChecks,
			details,
			allFlaggedFiles,
			startedAt: cqStart,
		});
	}

	await streamExternalTools({
		engine,
		cwd,
		opts,
		skipChecks,
		summary,
		allFlaggedFiles,
		details,
	});

	streamSupermodelDeadCode(cwd, opts, allFlaggedFiles);

	if (opts.suggestions) {
		streamSuggestionsSummary(files, cwd);
	}

	if (opts.structure) {
		await runStructureVerify(cwd, opts);
	}

	const tally = summarizeFlaggedFiles(cwd, files, allFlaggedFiles);
	process.stderr.write(`\n  ${tally.flaggedFiles} / ${tally.totalFiles} files flagged`);
	if (tally.projectFindings > 0) {
		const noun =
			tally.projectFindings === 1 ? "project-level finding" : "project-level findings";
		process.stderr.write(` · \x1b[33m${tally.projectFindings} ${noun}\x1b[0m`);
	}
	if (summary.length > 0) {
		process.stderr.write(
			` · ${summary.map((s) => `\x1b[${s.color}m${s.label}\x1b[0m`).join(" · ")}`,
		);
	}
	process.stderr.write("\n\n");

	emitVerifyRun(cwd, {
		mode: opts.allChecks ? "all-checks" : "default",
		files_scanned: files.length,
		flagged_files: tally.flaggedFiles,
		project_findings: tally.projectFindings,
		summary,
		duration_ms: Date.now() - cqStart,
	});
}

function safeRegistryParity(cwd: string): RegistryDriftFinding[] {
	try {
		return runRegistryParityCheck(cwd);
	} catch (error) {
		void error;
		return [];
	}
}

function batchSuggestions(args: {
	opts: VerifyOpts;
	files: string[];
	cwd: string;
}): Map<string, Finding[]> | null {
	if (!args.opts.suggestions) return null;
	return runSuggestions({
		files: args.files,
		cwd: args.cwd,
		limit: SUGGESTIONS_LIMIT,
		threshold: SUGGESTIONS_THRESHOLD,
	});
}

function filterSuppressedToolResults(results: CheckResult[], interlinkedDir: string): CheckResult[] {
	return results.filter((result) => {
		const fileSuppressions = loadFileSuppressions(interlinkedDir, result.file);
		return !fileSuppressions.has(result.tool);
	});
}

interface VerifyBatchArgs {
	engine: CheckEngine;
	files: string[];
	cwd: string;
	opts: VerifyOpts;
	scope: import("../harness/check-engine/types.js").CheckScope;
}

async function runVerifyBatchJson({ engine, files, cwd, opts, scope }: VerifyBatchArgs): Promise<void> {
	const only = opts.only;
	const onlySkipTools = only
		? TOOL_IDS.filter((t) => t !== only && t !== only.replace("_", "-"))
		: [];
	const skipChecks = getEffectiveSkipChecks(opts.skip, opts.allChecks);
	const skipTools = [...new Set([...onlySkipTools, ...getSkipTools(skipChecks)])];
	setActiveSkipChecks(skipChecks);

	const report = await engine.runChecksAsync(scope, {
		timeoutMs: CHECK_ENGINE_TIMEOUT_MS,
		skipTools,
		admissionAlreadyHeld: true,
	});

	const interlinkedDir = join(cwd, ".interlinked");
	const byTool = (tool: string): CheckResult[] =>
		filterSuppressedToolResults(report.results.filter((result) => result.tool === tool), interlinkedDir);
	const tscResults = byTool("tsc");
	const biomeResults = byTool("biome");
	const eslintResults = byTool("eslint");
	const semgrepResults = byTool("semgrep");
	const gitleaksResults = byTool("gitleaks");
	const linterResults = [...biomeResults, ...eslintResults];
	const linterName = eslintResults.length > 0 ? "eslint" : "biome";
	const auditResult = opts.only && opts.only !== "sca" ? null : engine.runDepAudit();
	const cq = opts.only
		? emptyResults()
		: filterCodeQualityResultsInPlace(
				// Progress goes to stderr only — stdout stays byte-identical JSON.
				await runCodeQualityChecksProgressive(files, cwd, createScanProgress(files.length)),
				skipChecks,
			);
	const setupIssues = checkProjectSetup(cwd);
	const registryDrift = safeRegistryParity(cwd);
	const suggestions = batchSuggestions({ opts, files, cwd });

	outputJson({
		tscResults,
		linterResults,
		linterName,
		semgrepResults,
		gitleaksResults,
		auditResult,
		cq,
		suggestions,
		totalFiles: files.length,
		setupIssues,
		registryDrift,
		decisionSurface: detectDecisionSurface(cwd),
		lockfileMultiplicity: detectLockfileMultiplicity(cwd),
		decisionSurfaceRatchet: computeDecisionSurfaceRatchet(cwd),
		structureSection: opts.structure ? buildStructureJsonSection(cwd, opts) : undefined,
	});
}

// Keep `DEFAULT_ADVISORY_SKIPS` in the exported namespace via import below
// so the regression test's import path keeps working even after the refactor.
// (The `export { DEFAULT_ADVISORY_SKIPS } from "./verify/advisory.js"` above
// handles runtime; this reference keeps the name bundled in any build output
// that tree-shakes aggressively.)
void DEFAULT_ADVISORY_SKIPS;
