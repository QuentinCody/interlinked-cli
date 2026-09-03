// ===========================================
// PostToolUse — per-file check phases
// ===========================================
// Cohesive check phases extracted verbatim from `runPerFileChecks` in
// `post-tool-file-checks.ts`. Each helper operates on the shared
// `ServerRuntime` (ctx) and `PerFileCheckCtx` (acc) accumulators and mutates
// `decision`/`session` in place — identical logic to the inline phase blocks.
//
// The orchestrator (`runPerFileChecks`) calls these in the SAME order; the
// only change is bare local references becoming helper parameters. The
// structural-checks phase and the recurrence-consolidation tail stay in the
// main file (the latter is pinned by source-level regression tests).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { checkAssertionDensity, runBehavioralChecks } from "../behavioral-checks.js";
import { isInsideRoot } from "../large-file-policy.js";
import {
	countSuppressionDirectives,
	findProjectRoot,
	runQualityChecks,
} from "../quality-checks.js";
import { createChangeSetExternalBatch } from "../quality-checks/change-set-external.js";
import { acknowledgeChecks, isAcknowledged } from "../session-state.js";
import { runStructureChecks } from "../structure/structure-checks.js";
import { formatStructureWarnings } from "../structure/structure-formatter.js";
import { loadStructureConfig } from "../structure/structure-loader.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { deriveEditedLineNumbers } from "./edit-line-derivation.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import {
	applyQualityDecision,
	buildSmartTscOpts,
	collectQualityResultEntries,
	expandQualitySiblings,
	isQualityDeferralName,
	runScoredSuggestionsPhase,
} from "./post-tool-file-checks-phases-quality.js";
import type { ServerRuntime } from "./runtime-context.js";

// Re-export the scored-suggestions phase so the orchestrator keeps importing
// it from this module entry (it now lives in the -quality sibling).
export { runScoredSuggestionsPhase };
export { runProjectWideSweepPhase } from "./post-tool-project-wide-sweep.js";

/** Structure-check cold-build time budget (ms). When existing checks have
 *  already burned this much of the shared 15s PostToolUse window, the cold
 *  graph build is skipped (a cached graph still runs). */
const STRUCT_TIME_BUDGET_MS = 12000;
/** Session edit count at which the shotgun-surgery taste check first fires. */
const SHOTGUN_THRESHOLD = 40;
/** Higher session edit count that fires the shotgun check a second time. */
const SHOTGUN_THRESHOLD_HIGH = 60;

/**
 * Quality-checks phase: tsc/lint/secrets (subprocess-based) + sibling
 * expansion + quality-result collection/blocking. Returns the baseline
 * suppression count captured before the checks consumed it — the behavioral
 * phase needs it for the suppression-delta escalation.
 *
 * Thin orchestrator: the cohesive branch groups (smart-tsc opts, checks-ran
 * tracking, sibling fan-out, result collection, blocking decision) live in the
 * sibling helpers above so each unit stays well under the cyclomatic cap.
 */
export async function runQualityPhase(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	editedFilePath: string,
	editedFileInRepo: boolean,
	exportSurfaceChanged: boolean,
	structuralConfig: GuardRulesConfig["structural_checks"],
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): Promise<number> {
	const CWD = ctx.cwd;
	const rules = ctx.rules;
	const { allCheckResults, checksRan, postToolMetrics, markPhase } = acc;

	// --- Quality checks (tsc, lint, secrets — slower, subprocess-based) ---
	// Capture baseline suppression count before quality checks consume it
	let previousSuppressionCount = 0;

	// Smart tsc: when only internal logic changed (no export surface change),
	// still run tsc but filter output to only the edited file. This catches
	// internal type errors (e.g. TS18046 'unknown' access) without reporting
	// unrelated project-wide errors.
	const qualityOpts = buildSmartTscOpts(
		ctx,
		structuralConfig,
		editedFilePath,
		exportSurfaceChanged,
	);

	const baselineFilePath = isAbsolute(editedFilePath)
		? editedFilePath
		: resolve(CWD, editedFilePath);
	const currentBaseline = ctx.preEditBaselines.get(baselineFilePath);
	previousSuppressionCount = currentBaseline?.suppressionCount ?? 0;
	const requestPaths = acc.editedFilePaths ?? [];
	if (!acc.externalCheckBatch && requestPaths.length > 1) {
		const inRepoPaths = requestPaths.filter(
			(path) => path.length > 0 && isInsideRoot(CWD, path),
		);
		if (inRepoPaths.length > 0) {
			const newFilePaths = (checkEvent.change_set?.files ?? [])
				.filter((effect) => effect.kind === "created")
				.map((effect) => effect.path);
			acc.externalCheckBatch = createChangeSetExternalBatch({
				paths: inRepoPaths,
				newFilePaths,
				checks: rules.quality_checks,
				cwd: CWD,
				outToolMetrics: postToolMetrics,
				outChecksRan: checksRan,
			});
		}
	}
	// Phase mark — everything from the last mark up to here was
	// the structural-checks block (export-surface diff, project
	// graph update, impact analysis, deletion-hygiene).
	markPhase("structural_checks");
	const batchedExternalResults = acc.externalCheckBatch
		? await acc.externalCheckBatch.resultsForFile(editedFilePath)
		: [];
	const perFileQualityResults = await runQualityChecks(checkEvent, rules.quality_checks, CWD, {
		...qualityOpts,
		...(currentBaseline !== undefined ? { baseline: currentBaseline } : {}),
		...(rules.diff_aware !== undefined ? { diffAware: rules.diff_aware } : {}),
		outToolMetrics: postToolMetrics,
		// The tool-check loop records only checks that reached a verdict; a
		// thrown or deferred handler must not be reported as `checks_ran`.
		outChecksRan: checksRan,
		skipMultiFileExternalChecks: acc.externalCheckBatch !== undefined,
		// Mythos Phase 4: recency-weighted check depth.
		// Cold files skip heuristic detectors at PostToolUse.
		filePriority: ctx.filePriorityMap,
		// Diagnostic: per-check phase boundary. Each iteration
		// of the inline-check loop fires this with its name,
		// so phase_breakdown carries one entry per check
		// (inline_software_version_regression, inline_strong_typing,
		// …). Lets us pin a residual spike to a single check.
		onCheckBoundary: markPhase,
		// Out-of-tree edits skip subprocess/tree-walking
		// `command`-based checks (tsc/biome/semgrep/gitleaks):
		// those are project-rooted and would run THIS repo's
		// tooling for a foreign file. Inline content checks
		// still run. See `editedFileInRepo` above.
		editedFileInRepo,
	});
	const rawQualityResults = [...batchedExternalResults, ...perFileQualityResults];
	// Phase mark — runQualityChecks ran tsc/biome/inline checks.
	// The subprocess time is captured in tool_breakdown; this
	// phase covers their wall time + the inline-check residual.
	markPhase("quality_checks");
	// Clear consumed baseline
	ctx.preEditBaselines.delete(baselineFilePath);
	// --- Session-ack suppression for quality checks ---
	// Skip re-firing warnings the user already acknowledged for this file+check.
	// Errors and no-verdict deferrals always re-fire regardless of acknowledgment:
	// suppressing a deferral could make the tail incorrectly report all-clean.
	const qualityResults = rawQualityResults.filter(
		(r) =>
			r.severity === "error" ||
			isQualityDeferralName(r.name) ||
			!isAcknowledged(session, editedFilePath, r.name),
	);

	// --- Sibling expansion (PostToolUse fan-out) ---
	// When a finding hits a known type-erasure / boundary pattern, query
	// the trigram index for every other instance and emit one row per
	// sibling. Codex finding-discovery convention "do not collapse
	// separate instances under one candidate" — turns a single edit's
	// `as_any_ratchet` into a worklist covering the whole module.
	expandQualitySiblings(ctx, editedFilePath, qualityResults);

	// Collect quality check results for local persistence
	collectQualityResultEntries(qualityResults, allCheckResults);

	applyQualityDecision(ctx, qualityResults, decision);

	return previousSuppressionCount;
}

/**
 * Session-level taste check: shotgun surgery. Fires once per session at the
 * 40-file and again at the 60-file threshold.
 */
export function runShotgunSurgeryPhase(
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const { allCheckResults, checksRan } = acc;

	// --- Session-level taste check: shotgun surgery ---
	// Threshold starts at 40 (not 25): adding a field to a shared interface
	// naturally touches types + implementation + every test mock, easily 10-15 files.
	if (session.files_written.size >= SHOTGUN_THRESHOLD) {
		const shotgunKey = `shotgun-surgery-${session.files_written.size >= SHOTGUN_THRESHOLD_HIGH ? "60" : "40"}`;
		if (!isAcknowledged(session, "__session__", shotgunKey)) {
			allCheckResults.push({
				source: "suggestion",
				name: "shotgun-surgery",
				severity: "warning",
				message: `This session has edited ${session.files_written.size} files. Consider whether abstraction boundaries could reduce the blast radius, or if this change should be broken into smaller steps.`,
				determinism: "heuristic",
			});
			if (!decision.warnings) decision.warnings = [];
			decision.warnings.push(
				`[taste:shotgun-surgery] ${session.files_written.size} files edited in this session — consider if the change scope is too broad`,
			);
			checksRan.push("shotgun-surgery");
			// Mark as acknowledged so we don't re-fire on every subsequent edit
			// at the same threshold. The 60-file threshold uses a different key,
			// so it will still fire once when crossed.
			acknowledgeChecks(session, "__session__", [shotgunKey]);
		}
	}
}

/**
 * Records one structure-check run's outputs: check results, the `structure`
 * warning row, and the pending completions the run discovered.
 */
function recordStructureResults(
	structResult: ReturnType<typeof runStructureChecks>,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const { allCheckResults, checksRan } = acc;
	for (const r of structResult.results) {
		allCheckResults.push(r);
	}
	if (structResult.findings.length > 0) {
		checksRan.push("structure");
		if (!decision.warnings) decision.warnings = [];
		decision.warnings.push(...formatStructureWarnings(structResult.findings));
	}
	// Record structure pending completions into session state
	for (const pc of structResult.pendingCompletions) {
		session.pending_completions.set(`struct:${pc.source_artifact_ref}`, {
			source_file: pc.source_file,
			affected_files: pc.required_companion_files,
			resolved_files: new Set(pc.resolved_companion_files),
			recorded_at_tool_call: session.tool_call_count,
			description: `[structure] ${pc.finding_class}: ${pc.source_artifact_ref}`,
		});
	}
}

/**
 * Builds/refreshes the artifact graph rooted at the edited file's project and
 * records the run's findings. Structure checks are guidance only, so any
 * failure is logged and swallowed rather than surfaced to the agent.
 */
function runStructureChecksForFile(
	ctx: ServerRuntime,
	editedFilePath: string,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const CWD = ctx.cwd;
	const log = ctx.log;
	try {
		const structRepoRoot = findProjectRoot(editedFilePath, CWD) || CWD;
		const structResult = runStructureChecks(
			editedFilePath,
			structRepoRoot,
			ctx.structureGraph,
			ctx.structureConfigCache,
			session.files_written,
		);
		ctx.structureGraph = structResult.graph;
		if (!ctx.structureConfigCache) {
			ctx.structureConfigCache = loadStructureConfig(structRepoRoot).config;
		}
		recordStructureResults(structResult, session, decision, acc);
	} catch (structErr) {
		log(
			`Structure check error: ${structErr instanceof Error ? structErr.message : String(structErr)}`,
		);
	}
}

/**
 * Structure checks phase (non-blocking guidance) + the `scored_suggestions`
 * phase mark that closes out the scored-suggestions/structure window. Mutates
 * `ctx.structureGraph` / `ctx.structureConfigCache` caches in place.
 */
export function runStructureChecksPhase(
	ctx: ServerRuntime,
	editedFilePath: string,
	editedFileInRepo: boolean,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const { markPhase } = acc;

	// --- Structure checks phase (non-blocking guidance) ---
	// Skip cold graph build if existing checks already consumed most of the time budget.
	// The 15s PostToolUse timeout is shared with tsc/biome/etc. On large repos, a cold
	// graph build (~5-10s for 20K+ nodes) can push past the limit. The cached graph
	// (from a previous call) makes subsequent edits fast (<100ms).
	// Skipped for out-of-tree edits: runStructureChecks builds/refreshes
	// the artifact graph rooted at the file's project. For a file
	// outside CWD that root falls back to CWD, so this would build
	// THIS repo's graph for a foreign file — wrong, and the tree walk
	// is the 11-19s cost the out-of-tree guard exists to remove.
	const structElapsed = Date.now() - acc.postStartMs;
	const hasCachedGraph = ctx.structureGraph !== null;
	if (
		editedFilePath &&
		editedFileInRepo &&
		(hasCachedGraph || structElapsed < STRUCT_TIME_BUDGET_MS)
	) {
		runStructureChecksForFile(ctx, editedFilePath, session, decision, acc);
	}
	// Phase mark — everything between project_wide_sweep and here was
	// the scored-suggestions pipeline (scanInlineSuppressions,
	// loadFileSuppressions, runStructureChecks). One of these is
	// re-loading state per event and is the load-bearing tax.
	markPhase("scored_suggestions");
}

/**
 * Reads the post-edit file once for the behavioral phase and counts its
 * suppression directives. Both `countSuppressionDirectives` and
 * `checkAssertionDensity` need the same content — reading twice would double
 * the I/O on every PostToolUse Edit. A missing/unreadable file yields
 * `undefined` content and a zero count.
 */
function readEditedFileForBehavioral(editedFilePath: string): {
	fileContent: string | undefined;
	currentSuppressionCount: number;
} {
	let fileContent: string | undefined;
	let currentSuppressionCount = 0;
	try {
		if (existsSync(editedFilePath)) {
			fileContent = readFileSync(editedFilePath, "utf-8");
			currentSuppressionCount = countSuppressionDirectives(fileContent);
		}
	} catch (e) {
		void e;
	}
	return { fileContent, currentSuppressionCount };
}

/**
 * Session-level behavioral checks (persistent-warning escalation,
 * assertion-density). Reads the suppression-count baseline captured by the
 * quality phase.
 */
export function runBehavioralPhase(
	checkEvent: HarnessEvent,
	editedFilePath: string,
	previousSuppressionCount: number,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const { allCheckResults } = acc;

	// --- Session-level behavioral checks ---
	// `session` is always a real object per its non-optional type — only
	// `editedFilePath` (derived as `(... as string) || ""` upstream) can
	// genuinely be falsy at runtime, so only that half of the old
	// `!session || !editedFilePath` guard is a real early-return.
	if (!editedFilePath) return;

	// Capture fileContent once — both `countSuppressionDirectives`
	// and `checkAssertionDensity` need it. Reading twice would
	// double the I/O on every PostToolUse Edit.
	const { fileContent, currentSuppressionCount } =
		readEditedFileForBehavioral(editedFilePath);
	// Refinement 2026-05: derive the set of lines this edit actually
	// touched from tool_input + post-edit file content. Threaded into
	// `runBehavioralChecks` → `checkPersistentWarningEscalation` so
	// the escalation only fires for persistent findings within ±3
	// lines of an edit, suppressing the FP where stale findings in
	// untouched regions amplified on every unrelated re-edit.
	const editedLines = deriveEditedLineNumbers(
		checkEvent.tool_name,
		checkEvent.tool_input,
		fileContent,
	);
	const behavioralResults = runBehavioralChecks(
		session,
		editedFilePath,
		allCheckResults,
		previousSuppressionCount,
		currentSuppressionCount,
		editedLines,
	);

	// Plan 09 Phase 1: assertion-density runs outside
	// `runBehavioralChecks` because it's session-delta-based and
	// needs the post-edit content (which the orchestrator's
	// signature doesn't carry). The internal `TEST_FILE_RE` short-
	// circuit handles the test-file gate.
	if (fileContent !== undefined) {
		const r = checkAssertionDensity(session, editedFilePath, fileContent);
		if (r) behavioralResults.push(r);
	}

	// Filter-first: only push *shown* results into
	// `allCheckResults` so the recurrence and effectiveness loops
	// downstream don't see acknowledged-skipped findings.
	// Errors bypass the ack check by design — match the
	// suggestion-check pattern at server.ts:1970 and the quality-
	// check pattern at :1661 (`r.severity === "error" ||
	// !isAcknowledged(...)`). Acknowledging an error means "I saw
	// it"; it should still surface until actually fixed.
	// Second guard clause (was `if (behavioralResults.length > 0) { ... }`):
	// again the wrapped block was the last statement, so returning early
	// on the empty case is equivalent to falling through to the end.
	if (behavioralResults.length === 0) return;

	if (!decision.warnings) decision.warnings = [];
	for (const r of behavioralResults) {
		if (r.severity !== "warning" && r.severity !== "error") {
			// Info-level — record but don't surface, matching
			// the pre-existing `checkTddGreenConfirmation`
			// behavior.
			allCheckResults.push(r);
			continue;
		}
		const shouldShow =
			r.severity === "error" ||
			!isAcknowledged(session, editedFilePath, r.name);
		if (!shouldShow) continue;

		allCheckResults.push(r);
		const tag =
			r.determinism === "fully_deterministic" ? "[proven]" : "[heuristic]";
		decision.warnings.push(`${tag} ${r.name}: ${r.message}`);
	}
}
