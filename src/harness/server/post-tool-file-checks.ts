// ===========================================
// PostToolUse — per-file check body
// ===========================================
// The body of the `for (const currentEditedPath of pathsToCheck)` loop,
// extracted verbatim from `post-tool-pipeline.ts`. Codex `apply_patch`
// payloads carry multiple file sections, so the orchestrator fans this
// function out once per edited file.
//
// All cross-iteration / cross-phase mutable state travels through one
// `PerFileCheckCtx` accumulator: the structural / quality / suggestion /
// structure / behavioral findings append into `accumulator.allCheckResults`,
// the human-facing strings into `decision.warnings`, and the once-per-event
// guards (`projectWideSweepFired`, `recurrenceCursor`) stay on the
// accumulator so they survive across files.
//
// Behavior-preserving move: identical logic to the inline loop body; the
// only change is bare module-level state becoming `ctx.*`.

import { relative } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { recordWarningResolutions, recordWarningsIssued } from "../feedback-effectiveness.js";
import { isInsideRoot } from "../large-file-policy.js";
import type { ProjectGraph } from "../project-graph.js";
import { type ToolBreakdownEntry } from "../quality-checks.js";
import type { ChangeSetExternalBatch } from "../quality-checks/change-set-external.js";
import { recordHarnessCaught } from "../recurrence.js";
import { recordImplEdit, recordTestWrite, TEST_FILE_RE } from "../server-tdd-cycle.js";
import { acknowledgeChecks } from "../session-state.js";
import { shouldSkipTsc } from "../structural-checks.js";
import type {
	CheckResultEntry,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
	StructuralChecksConfig,
} from "../types.js";
import {
	runBehavioralPhase,
	runProjectWideSweepPhase,
	runQualityPhase,
	runScoredSuggestionsPhase,
	runShotgunSurgeryPhase,
	runStructureChecksPhase,
} from "./post-tool-file-checks-phases.js";
import {
	applyStructuralFindings,
	collectStructuralResults,
	recordStructuralErrorMemory,
	recordStructuralFixMemory,
	runDeletionHygiene,
	runImpactOrFallback,
} from "./post-tool-file-checks-structural.js";
import { runRegistryParityPhase } from "./registry-parity-phase.js";
import { runReviewReconcilePhase } from "./review-reconcile-phase.js";
import { getGraphForFile, type ServerRuntime } from "./runtime-context.js";
import { runSpecLedgerPhase } from "./spec-ledger-phase.js";

/** Cross-iteration / cross-phase accumulator for the PostToolUse per-file
 *  fan-out. The orchestrator creates one of these per event and passes it
 *  to {@link runPerFileChecks} for every edited file. */
export interface PerFileCheckCtx {
	/** Wall-clock when the PostToolUse handler started — feeds the structure
	 *  check time-budget gate. */
	readonly postStartMs: number;
	/** Every structured finding from every file (quality / structural /
	 *  suggestion / structure / behavioral). */
	readonly allCheckResults: CheckResultEntry[];
	/** Names of the check families that actually ran. */
	readonly checksRan: string[];
	/** Per-subprocess-tool latency breakdown. */
	readonly postToolMetrics: ToolBreakdownEntry[];
	/** Records the wall-clock delta since the previous mark under `name`. */
	readonly markPhase: (name: string) => void;
	/** Full request-owned path set. The quality phase uses this to replace N
	 * external tool loops with one ChangeSet batch while retaining per-file
	 * inline checks and attribution. */
	editedFilePaths?: readonly string[];
	/** Lazily created external batch shared by every path in this request. */
	externalCheckBatch?: ChangeSetExternalBatch;
	/** Once-per-event guard: the project-wide sweep fires at most once
	 *  even when a patch touches many files. */
	projectWideSweepFired: boolean;
	/** Suffix of `allCheckResults` not yet mirrored into the recurrence log;
	 *  advances across files so prior files' findings are not re-recorded. */
	recurrenceCursor: number;
}

/**
 * Run the structural / quality / project-wide-sweep / scored-suggestion /
 * structure / behavioral / feedback-effectiveness / recurrence pipeline for
 * ONE edited file. Mutates `decision` and `acc` in place.
 */
export async function runPerFileChecks(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	currentEditedPath: string,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): Promise<void> {
	const CWD = ctx.cwd;
	const { allCheckResults, checksRan } = acc;
	// Index into allCheckResults where THIS file's findings begin — the
	// accumulator is event-global, so feedback-effectiveness recording must
	// scope to this file's own suffix, not every prior file's (deep-round #8).
	const fileResultsStart = allCheckResults.length;

	let editedFilePath = currentEditedPath;
	// For Bash edits, inject the detected file path into a synthetic event
	const checkEvent = editedFilePath
		? { ...event, tool_input: { ...event.tool_input, file_path: editedFilePath } }
		: event;

	// --- Structural checks (fast, sub-100ms, dependency-aware) ---
	const structuralConfig = ctx.rules.structural_checks;
	editedFilePath = (checkEvent.tool_input?.file_path as string) || "";

	// Is the edited file inside this harness's own project (CWD)?
	// Project-rooted analysis — the cross-file project-wide sweep and
	// the artifact-graph build in runStructureChecks — walks the tree
	// from the file's project root. For an out-of-tree edit (e.g. a
	// file under ~/.claude/...), `findProjectRoot` returns null and
	// `repoRoot` falls back to CWD, which would build/refresh THIS
	// repo's graph for a file that isn't in it: wrong result, and an
	// 11-19s tree walk. Gate those phases on in-repo membership; the
	// inline content checks below still run for out-of-tree files.
	// Symlink-safe containment (deep-round #7): a lexical prefix check
	// misjudges /private/tmp vs /tmp on macOS. isInsideRoot realpaths both
	// sides — the same policy the coverage overlay uses.
	const editedFileInRepo =
		editedFilePath.length > 0 && isInsideRoot(CWD, editedFilePath);

	// --- TDD cycle tracking: record impl edits and test writes ---
	// `session` is typed as required `SessionTrajectory`, but production
	// code elsewhere calls this defensively with a possibly-null session
	// (see the "falsy session handling" tests). Read it through `unknown`
	// so the guard stays real instead of being lint-dead.
	const sessionPresent: unknown = session;
	if (sessionPresent && editedFilePath) {
		if (TEST_FILE_RE.test(editedFilePath)) {
			recordTestWrite(session, editedFilePath, CWD);
		} else {
			recordImplEdit(session, editedFilePath, CWD);
		}
	}

	// Resolve graph for the edited file's project (supports cross-repo edits)
	const fileGraph = getGraphForFile(ctx, editedFilePath || CWD);

	// --- Structural checks + impact + error-memory + deletion-hygiene ---
	// The whole structural block runs here and reports back whether the export
	// surface changed (for the smart-tsc gate in the quality phase below).
	const exportSurfaceChanged = await runStructuralChecksForFile(
		ctx,
		checkEvent,
		event,
		session,
		editedFilePath,
		fileGraph,
		structuralConfig,
		decision,
		allCheckResults,
		checksRan,
	);

	// Update route map when a file is edited
	if (editedFilePath) {
		ctx.routeMap.updateFile(editedFilePath);
	}

	// --- Quality checks (tsc, lint, secrets — slower, subprocess-based) ---
	// Returns the suppression-count baseline (read before the checks consumed
	// it) for the behavioral phase below. The `structural_checks` phase mark
	// fires inside this helper, immediately before runQualityChecks.
	const previousSuppressionCount = await runQualityPhase(
		ctx,
		checkEvent,
		editedFilePath,
		editedFileInRepo,
		exportSurfaceChanged,
		structuralConfig,
		session,
		decision,
		acc,
	);

	// ── Project-wide sweep (cross-file tsc/biome) ── (ends with the
	// `project_wide_sweep` phase mark).
	await runProjectWideSweepPhase(
		ctx,
		editedFilePath,
		editedFileInRepo,
		exportSurfaceChanged,
		decision,
		acc,
	);

	// ── Scored suggestions (non-deterministic heuristics, top 1-3) ──
	runScoredSuggestionsPhase(ctx, checkEvent, editedFilePath, session, decision, acc);

	// --- Session-level taste check: shotgun surgery ---
	runShotgunSurgeryPhase(session, decision, acc);

	// --- Structure checks phase (non-blocking guidance) ── (ends with the
	// `scored_suggestions` phase mark).
	runStructureChecksPhase(ctx, editedFilePath, editedFileInRepo, session, decision, acc);
	runSpecLedgerPhase(ctx, editedFilePath, editedFileInRepo, session, decision, acc);
	// Registry-parity: this edit's file scoped against any configured pair it
	// is the LEFT or RIGHT side of (.interlinked/registry-parity.json).
	runRegistryParityPhase(ctx, editedFilePath, editedFileInRepo, decision, acc);
	// Review-finding reconciliation: touch txns + disputed-ground warning
	// (spec-audit memo §4/§6.3).
	runReviewReconcilePhase(
		CWD,
		event.session_id,
		editedFilePath,
		editedFileInRepo,
		decision,
	);

	// --- Session-level behavioral checks ---
	runBehavioralPhase(
		checkEvent,
		editedFilePath,
		previousSuppressionCount,
		session,
		decision,
		acc,
	);

	// --- Feedback effectiveness + session-ack of shown warnings ---
	// Scope feedback/ack to THIS file's findings — the accumulator is
	// event-global, so a multi-file patch must not record file A's warnings
	// under file B (deep-round #8).
	recordFeedbackAndAck(session, editedFilePath, allCheckResults.slice(fileResultsStart));

	// --- Mirror new actionable findings into the recurrence log ---
	consolidateRecurrence(event, editedFilePath, CWD, acc, allCheckResults);
}


/**
 * The structural-checks block for one file: capture old export state, refresh
 * the graph, run + filter the structural checks, then apply findings / impact /
 * error-memory / deletion-hygiene. Returns `exportSurfaceChanged` for the
 * caller's smart-tsc gate. Mutates `decision` and `session` in place.
 */
async function runStructuralChecksForFile(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	event: HarnessEvent,
	session: SessionTrajectory,
	editedFilePath: string,
	fileGraph: ProjectGraph,
	structuralConfig: StructuralChecksConfig,
	decision: HarnessDecision,
	allCheckResults: CheckResultEntry[],
	checksRan: string[],
): Promise<boolean> {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const rules = ctx.rules;

	if (!(structuralConfig.enabled && fileGraph.isInitialized && editedFilePath)) {
		if (fileGraph.isInitialized && editedFilePath) {
			// Even if structural checks are disabled, keep graph up to date
			fileGraph.updateFile(editedFilePath);
		}
		return false;
	}

	// Capture old state, then update graph with new file content
	const oldExports = fileGraph.getExports(editedFilePath);
	const oldInterfaceBodies = fileGraph.getInterfaceBodies(editedFilePath);
	fileGraph.updateFile(editedFilePath);

	const structuralResults = collectStructuralResults(
		ctx,
		checkEvent,
		session,
		editedFilePath,
		fileGraph,
		structuralConfig,
		oldExports,
		oldInterfaceBodies,
		checksRan,
	);

	if (structuralResults.length > 0) {
		applyStructuralFindings(
			structuralResults,
			editedFilePath,
			event,
			session,
			decision,
			allCheckResults,
			log,
		);
		runImpactOrFallback(
			ctx,
			editedFilePath,
			fileGraph,
			structuralConfig,
			oldExports,
			structuralResults,
			session,
			decision,
			log,
		);
		// Record errors in cross-session error history
		if (rules.error_memory.enabled) {
			await recordStructuralErrorMemory(
				ctx,
				checkEvent,
				event,
				session,
				editedFilePath,
				fileGraph,
				structuralResults,
			);
		}
	} else {
		// No failures — clear any previous failed_files entry for this file
		session.failed_files.delete(editedFilePath);

		// Record fix in error history
		if (rules.error_memory.enabled) {
			recordStructuralFixMemory(ctx, checkEvent, editedFilePath, fileGraph);
		}
	}

	// Check if export surface changed (for smart tsc)
	const newExports = fileGraph.getExports(editedFilePath);
	const surfaceChanged = !shouldSkipTsc(structuralConfig, oldExports, newExports);

	// --- Deletion hygiene (Layer 3): orphaned test references ---
	// When exports are removed, check if co-located test files still reference them
	if (oldExports.length > 0) {
		runDeletionHygiene(
			editedFilePath,
			session,
			oldExports,
			newExports,
			CWD,
			decision,
			allCheckResults,
		);
	}

	return surfaceChanged;
}

// ===========================================
// Post-checks tail — extracted helpers
// ===========================================

/**
 * Record feedback-effectiveness evidence (warnings issued + resolutions) and
 * session-ack the warning-level findings so they don't re-fire next edit.
 * Mutates `session` in place.
 */
function recordFeedbackAndAck(
	session: SessionTrajectory,
	editedFilePath: string,
	// THIS file's findings only — the caller slices the event-global
	// accumulator so a multi-file patch can't record file A's warnings under
	// file B (deep-round #8).
	allCheckResults: CheckResultEntry[],
): void {
	// --- Feedback effectiveness tracking ---
	// Pass full evidence (name + line) so the escalation check on the NEXT
	// edit can read each persistent finding's line for the diff-aware
	// proximity gate (refinement 2026-05).
	// `session` is forwarded from `runPerFileChecks`, which the "falsy
	// session handling" tests prove can be called with a null session
	// despite the required `SessionTrajectory` type. Read it through
	// `unknown` so the guard stays real instead of being lint-dead.
	const sessionPresent: unknown = session;
	if (sessionPresent && editedFilePath && allCheckResults.length > 0) {
		const warningEvidence = allCheckResults
			.filter((r) => r.severity === "warning" || r.severity === "error")
			.map((r) => ({ name: r.name, ...(r.line !== undefined ? { line: r.line } : {}) }));
		if (warningEvidence.length > 0) {
			recordWarningsIssued(session, editedFilePath, warningEvidence);
		}
		recordWarningResolutions(
			session,
			editedFilePath,
			new Set(allCheckResults.map((r) => r.name)),
		);
	}

	// --- Session-ack: record shown warnings so they don't re-fire ---
	// Only acknowledge warning-level findings (errors must always re-fire).
	if (editedFilePath && allCheckResults.length > 0) {
		const warningCheckNames = allCheckResults
			.filter((r) => r.severity === "warning")
			.map((r) => r.name);
		if (warningCheckNames.length > 0) {
			acknowledgeChecks(session, editedFilePath, warningCheckNames);
		}
	}
}

/**
 * Mirror every new actionable finding into the recurrence log and advance the
 * cursor. Independent of error_memory — recurrence is its own JSONL. Mutates
 * `acc.recurrenceCursor` in place.
 */
function consolidateRecurrence(
	event: HarnessEvent,
	editedFilePath: string,
	CWD: string,
	acc: PerFileCheckCtx,
	allCheckResults: CheckResultEntry[],
): void {
	// Mirror EVERY actionable check failure (quality / structural /
	// suggestion / impact / structure / behavioral) into the
	// recurrence log so `interlinked recurrence` can aggregate
	// repeated harness_caught hits across sessions and propose
	// ratchets. Independent of error_memory.enabled — that gate
	// is for embedding-augmented error history; recurrence is its
	// own JSONL. Fire-and-forget; recordHarnessCaught swallows
	// storage failures so live PostToolUse never trips.
	if (editedFilePath && allCheckResults.length > acc.recurrenceCursor) {
		const recurrenceRelPath = relative(CWD, editedFilePath);
		for (let i = acc.recurrenceCursor; i < allCheckResults.length; i++) {
			const r = nonNull(allCheckResults[i]);
			if (r.severity !== "error" && r.severity !== "warning") continue;
			recordHarnessCaught({
				check_id: r.name,
				agent_source: event.agent_source,
				session_id: event.session_id,
				file: r.file ? relative(CWD, r.file) : recurrenceRelPath,
				message: r.message,
				cwd: CWD,
				phase: r.phase,
				severity: r.severity,
			});
		}
		acc.recurrenceCursor = allCheckResults.length;
	}
}
