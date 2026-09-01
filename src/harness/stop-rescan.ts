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
// `[[feedback_recurring_warnings_amplify_not_silence]]` the rescan does not
// dedup repeats: every Stop with unaddressed findings re-surfaces them, so
// the signal stays loud until the agent fixes or defers.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { buildAgentSafetyChecks } from "./check-registry/index.js";
import { loadSubagentAttribution, type SubagentAttribution } from "./stop-actor-attribution.js";
import { digestStopRescan } from "./stop-rescan-report.js";
import { scanInlineDeferrals } from "./suppressions.js";
import type { SessionTrajectory } from "./types.js";

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
 * acknowledged-deferred. Best-effort: a file that was deleted between the
 * last write and the rescan is silently skipped, and an individual buggy
 * detector cannot break the whole scan.
 */
export function rescanSessionFiles(
	session: SessionTrajectory,
	cwd: string,
): PatternRescanFinding[] {
	const cwdResolved = resolve(cwd);
	const findings: PatternRescanFinding[] = [];
	const seen = new Set<string>();

	for (const rawPath of session.files_written) {
		// `session.files_written` stores both the path the tool reported and
		// its absolute resolution (see `session-state.ts`). Canonicalise so
		// the same file scanned via two paths produces one set of findings.
		const absPath = isAbsolute(rawPath) ? rawPath : resolve(cwdResolved, rawPath);
		if (seen.has(absPath)) continue;
		seen.add(absPath);
		appendFileFindings(absPath, cwdResolved, findings);
	}

	return findings;
}

/** Read one file, run all detectors, append findings (annotated with
 *  deferral state) to the shared accumulator. Pulled out of
 *  `rescanSessionFiles` to keep nesting at two levels — the outer loop
 *  walks files, this helper walks checks-and-matches. */
function appendFileFindings(
	absPath: string,
	cwdResolved: string,
	out: PatternRescanFinding[],
): void {
	let content: string;
	try {
		content = readFileSync(absPath, "utf-8");
	} catch (_err) {
		// File deleted, permission denied, raced — skip silently. The
		// harness must never block end-of-turn cleanup on a stat error.
		return;
	}
	out.push(
		...scanContentFindings({
			content,
			relPath: relative(cwdResolved, absPath) || absPath,
		}),
	);
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
}): PatternRescanFinding[] {
	const { content, relPath } = args;
	const out: PatternRescanFinding[] = [];
	const deferrals = scanInlineDeferrals(content);
	for (const check of buildAgentSafetyChecks(content, relPath)) {
		let matches: Array<{ line: number; text: string }>;
		try {
			matches = check.fn();
		} catch (_err) {
			continue;
		}
		annotateMatches({ matches, checkId: check.name, relPath, deferrals, out });
	}
	return out;
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

export interface PatternRescanOpts {
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
	const findings = rescanSessionFiles(session, cwd);
	if (findings.length === 0) return [];

	const sessionId = opts.sessionId ?? session.session_id ?? "unknown";
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
				return baseline === null
					? null
					: scanContentFindings({ content: baseline, relPath: relFile });
			}
		: undefined;

	return digestStopRescan({
		findings,
		cwd,
		sessionId,
		interlinkedDir,
		dryRun: opts.dryRun,
		attribution,
		scanBaseline,
	}).warnings;
}
