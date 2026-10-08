// Stop-event deterministic pattern rescan.
//
// On every Stop event the harness walks `session.files_written` and re-runs
// the inline detector suite against the CURRENT contents of each file.
// Findings that remain in the file at end-of-turn are surfaced as warnings;
// the `// interlinked: defer <check-id>` (and `# interlinked: defer ...`)
// markers carve out an acknowledgment escape hatch so the agent can mark
// a finding "saw it, intentionally not fixing this turn" without
// scope-creep refactor pressure.
//
// This complements the PostToolUse pipeline (which catches new findings as
// they're written) by catching findings that *persist* into a completed
// turn. It is deterministic — no LLM call — per
// `[[feedback_harness_deterministic_only]]`. Per
// The report deduplicates repeated messages while retaining raw observations
// and the filtered details in the digest spool.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { buildAgentSafetyChecks } from "./check-registry/index.js";
import { recordUnavailableCheck } from "./check-unavailable.js";
import { appendCheckObservation, makeCheckObservation, FILE_EVIDENCE_COHORT, RAW_FILE_CHECK_CONFIGURATION } from "./check-observation-store.js";
import type { CheckObservation, DetectorExecution } from "./finding-outcomes.js";
import { retainStopObservations } from "./stop-rescan-observations.js";
import { harnessNow } from "./replay/harness-clock.js";
import { loadSubagentAttribution, type SubagentAttribution } from "./stop-actor-attribution.js";
import { digestStopRescan } from "./stop-rescan-report.js";
import { scanInlineDeferrals } from "./suppressions.js";
import type { HarnessEvent, SessionTrajectory } from "./types.js";

/** One detector hit from the rescan, paired with deferral state. */
export interface PatternRescanFinding {
	/** Working-tree-relative path. */
	file: string;
	/** Check id (e.g. `ubs_pickle_untrusted_load`). */
	checkId: string;
	/** 1-based line number in the current file. */
	line: number;
	/** Trimmed match text (≤150 chars). */
	text: string;
	/** True when the line carries an `interlinked: defer <checkId>` marker. */
	deferred: boolean;
	/** Operator-supplied justification when present, else null. */
	deferReason: string | null;
}

/**
 * Re-run the inline detector suite against the current contents of every
 * file in `session.files_written`. Returns one finding per (file, line,
 * check) tuple, annotated with whether the agent has marked that line as
 * acknowledged-deferred. Unreadable files and failed detectors retain
 * unavailable evidence; an individual failure cannot break the whole scan.
 */
export function rescanSessionFiles(
	session: SessionTrajectory,
	cwd: string,
	opts: { onUnavailable?: (check: string, file: string, error: unknown) => void; dryRun?: boolean;
        onObservation?: (row: CheckObservation) => void } = {},
): PatternRescanFinding[] {
	const cwdResolved = resolve(cwd);
	const findings: PatternRescanFinding[] = [];
	const seen = new Set<string>();
	const event: HarnessEvent = { hook_event: "Stop", session_id: session.session_id, agent_source: "harness",
		timestamp: new Date(harnessNow()).toISOString(), dry_run: opts.dryRun ?? false };

	for (const rawPath of session.files_written) {
		// `session.files_written` stores both the path the tool reported and
		// its absolute resolution (see `session-state.ts`). Canonicalise so
		// the same file scanned via two paths produces one set of findings.
		const absPath = isAbsolute(rawPath) ? rawPath : resolve(cwdResolved, rawPath);
		if (seen.has(absPath)) continue;
		seen.add(absPath);
		appendFileFindings({ absPath, cwdResolved, out: findings, event,
			onUnavailable: opts.onUnavailable ?? rescanErrorReporter(cwd, session, [], opts.dryRun ?? false),
            onObservation: opts.onObservation });
	}

	return findings;
}

/** Read one file, run all detectors, append findings (annotated with
 *  deferral state) to the shared accumulator. Pulled out of
 *  `rescanSessionFiles` to keep nesting at two levels — the outer loop
 *  walks files, this helper walks checks-and-matches. */
function appendFileFindings(args: {
	absPath: string; cwdResolved: string; out: PatternRescanFinding[]; event: HarnessEvent;
	onUnavailable: (check: string, file: string, error: unknown) => void;
    onObservation?: ((row: CheckObservation) => void) | undefined;
}): void {
	const { absPath, cwdResolved, out, event, onUnavailable } = args;
	if (!isRescanPathInScope(absPath, cwdResolved, onUnavailable)) return;
	let content: string;
	try {
		content = readFileSync(absPath, "utf-8");
	} catch (error) {
		onUnavailable("stop-rescan:read", absPath, error);
		return;
	}
	const executions: DetectorExecution[] = [];
	out.push(
		...scanContentFindings({
			content,
			relPath: relative(cwdResolved, absPath) || absPath,
            checkPath: absPath,
			onUnavailable,
			onExecution: (execution) => { if (FILE_EVIDENCE_COHORT.has(execution.check)) executions.push(execution); },
		}),
	);
	const row = makeCheckObservation({ event, file: relative(cwdResolved, absPath), content, executions,
		scope: "full", configuration: RAW_FILE_CHECK_CONFIGURATION });
    if (args.onObservation) args.onObservation(row);
    else appendCheckObservation(cwdResolved, event, row);
}

function withinRoot(path: string, root: string): boolean {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Session histories may include external memory/config writes. They must not
 * select another project's root, nor produce repository check receipts. */
function isRescanPathInScope(path: string, root: string,
    unavailable: (check: string, file: string, error: unknown) => void): boolean {
    try {
        if (withinRoot(path, root) && withinRoot(realpathSync(path), realpathSync(root))) return true;
        unavailable("stop-rescan:scope", path, new Error("File is outside this harness repository; no repository checks ran"));
    } catch (error) {
        unavailable("stop-rescan:read", path, error);
    }
    return false;
}

/**
 * Run the whole inline detector suite over one file's CONTENT. Exported so the
 * introduced-only filter can scan the git BASELINE version of a file through
 * the identical code path that produced the current findings — two different
 * detector loops would be two different definitions of "the same finding".
 */
function scanContentFindings(args: {
	content: string;
	relPath: string;
    checkPath?: string;
	onUnavailable?: (check: string, file: string, error: unknown) => void;
	onExecution?: (execution: DetectorExecution) => void;
}): PatternRescanFinding[] {
	const { content, relPath } = args;
	const out: PatternRescanFinding[] = [];
	const deferrals = scanInlineDeferrals(content);
	for (const check of buildAgentSafetyChecks(content, args.checkPath ?? relPath)) {
		const started = performance.now();
		let matches: Array<{ line: number; text: string }>;
		try {
			matches = check.fn();
		} catch (error) {
			args.onUnavailable?.(check.name, relPath, error);
			args.onExecution?.({ check: check.name, status: "unavailable", findings: [], emitted: null, duration_ms: performance.now() - started });
			continue;
		}
		args.onExecution?.({ check: check.name, status: "completed", findings: matches, emitted: null, duration_ms: performance.now() - started });
		annotateMatches({ matches, checkId: check.name, relPath, deferrals, out });
	}
	return out;
}

function rescanErrorReporter(cwd: string, session: SessionTrajectory, warnings: string[] = [], dryRun = false) {
	return (check: string, file: string, error: unknown): void => {
		warnings.push(`[interlinked:checks-deferred] NOT CHECKED: ${check} for ${file} (Stop rescan unavailable)`);
		recordUnavailableCheck({ cwd, check, error, event: {
			hook_event: "Stop", session_id: session.session_id, agent_source: "harness",
			timestamp: new Date(harnessNow()).toISOString(), tool_input: { file_path: file }, dry_run: dryRun,
		} });
	};
}

interface AnnotateMatchesArgs {
	matches: ReadonlyArray<{ line: number; text: string }>;
	checkId: string;
	relPath: string;
	deferrals: ReturnType<typeof scanInlineDeferrals>;
	out: PatternRescanFinding[];
}

/** Annotate raw detector matches with deferral state and push them onto
 *  the accumulator. Extracted so the per-check loop body stays a single
 *  call instead of an inline for-loop. */
function annotateMatches(args: AnnotateMatchesArgs): void {
	const { matches, checkId, relPath, deferrals, out } = args;
	for (const m of matches) {
		const lineDeferrals = deferrals.get(m.line);
		const deferred = lineDeferrals?.has(checkId) ?? false;
		const deferReason = lineDeferrals?.get(checkId) ?? null;
		out.push({
			file: relPath,
			checkId,
			line: m.line,
			text: m.text,
			deferred,
			deferReason,
		});
	}
}

const GIT_TIMEOUT_MS = 1_500;

/** `git show <sha>:<path>` — the session-start version of a file, or null when
 *  it did not exist then (new file), git is absent, or the tree is not a repo.
 *  Null degrades STRICTLY: everything reads as introduced, matching
 *  pre-block-gate.ts's own no-baseline rule. */
function gitShowFile(cwd: string, ref: string): string | null {
	try {
		return execFileSync("git", ["-C", cwd, "show", ref], {
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (err) {
		void err;
		return null;
	}
}

interface PatternRescanOpts {
	/** Session id for the repeat-Stop delta and the spool. */
	sessionId?: string | undefined;
	/** Honors the dry-run contract: a probe must not move the gate. */
	dryRun?: boolean | undefined;
	/** Overrides `<cwd>/.interlinked` (tests). */
	interlinkedDir?: string | undefined;
	/** Pre-resolved attribution (tests); production loads it from the timeline. */
	attribution?: SubagentAttribution | undefined;
	/** Injected git reader (tests). */
	gitShow?: ((cwd: string, ref: string) => string | null) | undefined;
}

/**
 * Format the rescan output into stderr-style warning strings.
 *
 * The SCAN is still whole-file and unchanged; what changed (2026-08-16) is the
 * REPORT. `stop-rescan-report.ts` drops findings a subagent's edit produced,
 * findings the session's git baseline already carried, and the sanctioned
 * probe pattern under `scratch/`, then prints only what is new since the
 * previous Stop. Everything it removes is spooled to
 * `.interlinked/stop-digest.jsonl` and still reported by `interlinked verify`.
 *
 * Never blocks; the caller decides whether to surface the strings.
 */
export function buildPatternRescanWarnings(
	session: SessionTrajectory,
	cwd: string,
	opts: PatternRescanOpts = {},
): string[] {
	const unavailable: string[] = [];
	const rows: CheckObservation[] = [];
	const onUnavailable = rescanErrorReporter(cwd, session, unavailable, opts.dryRun ?? false);
	const findings = rescanSessionFiles(session, cwd, { onUnavailable, dryRun: opts.dryRun ?? false,
        onObservation: row => rows.push(row) });
    if (findings.length === 0) {
        retainStopObservations({ cwd, rows, findings, intended: [], dryRun: opts.dryRun ?? false });
        return unavailable;
    }

	const sessionId = opts.sessionId ?? session.session_id;
	const interlinkedDir = opts.interlinkedDir ?? resolve(cwd, ".interlinked");
	const headSha = session.git_session_baseline?.head_sha;
	const gitShow = opts.gitShow ?? gitShowFile;
	const attribution =
		opts.attribution ?? loadSubagentAttribution({ interlinkedDir, sessionId });

	// No HEAD sha ⇒ no honest before/after anchor ⇒ `undefined`, which the
	// report reads as "no baseline": every finding stays introduced rather
	// than being guessed away.
	const scanBaseline = headSha
		? (relFile: string): PatternRescanFinding[] | null => {
				const baseline = gitShow(cwd, `${headSha}:${relFile}`);
				if (baseline === null) return null;
				const beforeErrors = unavailable.length;
				const matches = scanContentFindings({ content: baseline, relPath: relFile, checkPath: resolve(cwd, relFile), onUnavailable });
				return unavailable.length === beforeErrors ? matches : null;
			}
		: undefined;

	const report = digestStopRescan({
		findings,
		cwd,
		sessionId,
		interlinkedDir,
		dryRun: opts.dryRun,
		attribution,
		scanBaseline,
	});
    retainStopObservations({ cwd, rows, findings, intended: report.intendedFindings, dryRun: opts.dryRun ?? false });
	return [...report.warnings, ...unavailable];
}
