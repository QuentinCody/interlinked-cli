// ===========================================
// Interlinked Harness — Behavioral Checks
// ===========================================
// Session-level behavioral pattern checks.
// These detect anti-patterns across a session trajectory
// (repeated edits without testing, suppression as workaround,
// domain-sensitive test nudges, persistent warning escalation).
//
// The TDD-cycle state-machine checks, the git-diff-based commit gates, and
// the assertion-density check live in `./behavioral-checks-tdd.ts` (split out
// for the per-file line cap). Their public API is re-exported below so all
// importers see a single `behavioral-checks.js` surface.

import { nonNull } from "../lib/non-null.js";
import { ADVISORY_CHECK_IDS } from "./advisory-check-ids.js";
import {
	checkTddCycleViolation,
	checkTddGreenConfirmation,
	checkTddRegression,
} from "./behavioral-checks-tdd.js";
import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import type { CheckResultEntry, Determinism, SessionTrajectory } from "./types.js";

export type { LocDelta } from "./behavioral-checks-tdd.js";
// Re-export the TDD-cycle / commit-gate / assertion-density public surface so
// every existing importer of `behavioral-checks.js` is unchanged.
export {
	checkAssertionDensity,
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkTddCommitGate,
	checkTddCycleViolation,
	checkTddGreenConfirmation,
	checkTddRegression,
	checkTppLeapfrog,
	countAssertions,
	extractAddedLines,
	getStagedDiff,
	gitNumstatDelta,
} from "./behavioral-checks-tdd.js";

// ---- Helpers ----

const TEST_FILE_RE = /\.(test|spec)\.|__tests__\/|\/tests\//;

const SECURITY_DOMAIN_RE =
	/\/(auth|crypto|security|oauth|jwt|password|secret|encrypt|decrypt|token|credential|session|permission|acl)\//i;

// ---- Individual checks ----

/**
 * Detect a source file edited multiple times without any test run in the session.
 * Skips test files themselves and sessions where any test has been run.
 */
export function checkRepeatedEditWithoutTest(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	const count = session.file_edit_counts.get(filePath);
	if (count === undefined || count < 3) return null;

	// Don't warn about test files — they ARE the tests.
	if (TEST_FILE_RE.test(filePath)) return null;

	// Agent has already run some tests this session — give benefit of the doubt.
	if (session.test_runs.size > 0) return null;

	return {
		source: "structural",
		name: "repeated_edit_without_test",
		severity: "warning",
		message: `File edited ${count} times without running tests. Consider running the test suite.`,
		file: filePath,
		determinism: "heuristic",
	};
}

/**
 * Detect suppression directives added right after a harness warning on the same file.
 * This catches the pattern: warning fires -> agent adds `// @ts-expect-error` or `eslint-disable`
 * instead of fixing the underlying issue.
 */
export function checkSuppressionAsWorkaround(
	session: SessionTrajectory,
	filePath: string,
	currentSuppressionCount: number,
	previousSuppressionCount: number,
): CheckResultEntry | null {
	// No new suppressions added — nothing to flag.
	if (currentSuppressionCount <= previousSuppressionCount) return null;

	// Only flag if the file had a recent harness warning (likely the motivation).
	if (!session.failed_files.has(filePath)) return null;

	const delta = currentSuppressionCount - previousSuppressionCount;
	return {
		source: "structural",
		name: "suppression_as_workaround",
		severity: "warning",
		message: `Added ${delta} suppression directive(s) after a harness warning. Fix the underlying issue instead of suppressing it.`,
		file: filePath,
		determinism: "partially_deterministic",
	};
}

/**
 * Nudge agents to run tests when editing security-sensitive code.
 * Only fires when no tests have been run in the current session.
 */
export function checkDomainSensitiveTestNudge(
	session: SessionTrajectory,
	filePath: string,
): CheckResultEntry | null {
	const match = SECURITY_DOMAIN_RE.exec(filePath);
	if (!match) return null;

	// Agent has already run tests — no need to nag.
	if (session.test_runs.size > 0) return null;

	const domain = match[1];
	return {
		source: "structural",
		name: "domain_sensitive_test_nudge",
		severity: "warning",
		message: `Editing security-sensitive code (${domain}). Run the auth/security test suite to verify changes.`,
		file: filePath,
		determinism: "heuristic",
	};
}

/**
 * Predicate for `checkPersistentWarningEscalation`'s diff-aware gate:
 * does any line in `findingLines` sit within `radius` of any line in
 * `editedLines`? Pulled out to keep the escalation function's main loop
 * at two-deep nesting; the predicate itself is a clean O(F × E) scan
 * with early exit on the first match.
 */
function anyFindingNearEditedLine(
	findingLines: ReadonlyArray<number>,
	editedLines: ReadonlySet<number>,
	radius: number,
): boolean {
	for (const line of findingLines) {
		if (editedLineWithinRadius(editedLines, line, radius)) return true;
	}
	return false;
}

// Matches the `L<number>:` prefix every inline-check producer writes into a
// finding's `detail` block (e.g. `  L18: export function foo(` or
// `  L18 (in scope): ...`). The single source of per-finding line numbers
// the escalation can attribute to an edit — `CheckResultEntry.line` is a
// single optional slot, but one check (magic_literal, missing_return_types,
// …) routinely reports many lines, all of which live only in `detail`.
const DETAIL_LINE_PREFIX_RE = /(?:^|\n)\s*L(\d+)\b/g;

/**
 * Parse every `L<n>:` finding line out of a check result's `detail` block.
 * Deterministic (regex over the harness's own detail format), no I/O.
 * Returns [] when `detail` is absent or carries no line prefixes (file-level
 * checks like `export_surface` that have no per-line anchor).
 */
function extractDetailLines(detail: string | undefined): number[] {
	if (!detail) return [];
	const out: number[] = [];
	DETAIL_LINE_PREFIX_RE.lastIndex = 0;
	let m: RegExpExecArray | null = DETAIL_LINE_PREFIX_RE.exec(detail);
	while (m !== null) {
		const n = Number.parseInt(nonNull(m[1]), 10);
		if (Number.isFinite(n)) out.push(n);
		m = DETAIL_LINE_PREFIX_RE.exec(detail);
	}
	return out;
}

function editedLineWithinRadius(
	editedLines: ReadonlySet<number>,
	target: number,
	radius: number,
): boolean {
	for (const el of editedLines) {
		if (Math.abs(el - target) <= radius) return true;
	}
	return false;
}

/**
 * Escalate warnings that persist after the agent re-edits the same file.
 * If a warning was already issued and the agent edits the file again without
 * fixing it, escalate from warning to error.
 *
 * Per-finding line attribution (refinement 2026-05, sharpened 2026-05-29) —
 * addresses the FP class where pre-existing findings (already in HEAD before
 * the session started) re-fire on every edit and the escalation amplifies the
 * noise without value. The agent is only responsible for a finding when its
 * edit actually touched the finding's line. Four gates (gate 0 added 2026-07):
 *
 *  0. **Tier gate** — only default-gate, proven-or-low-FP checks escalate.
 *     Advisory-tier ids (`ADVISORY_CHECK_IDS`) and heuristic-determinism
 *     findings are excluded entirely; see `isEscalationEligible`.
 *  1. **Edited-line attribution (fail-CLOSED when edit data is present)** —
 *     when `editedLines` is provided, escalate a finding only if at least one
 *     of its lines is within `±PROXIMITY_RADIUS` of a line the agent's
 *     current edit changed. Critically, this is fail-CLOSED: a finding that
 *     carries NO line evidence (file-level checks, or a finding whose lines we
 *     couldn't recover) is NOT escalated when we have edit data — we cannot
 *     prove the agent is responsible for it, and "findings on unchanged lines
 *     must not escalate" is the contract. This is the fix for the observed FP
 *     where a stable advisory on line X amplified to an error on every edit to
 *     an unrelated line. (The previous gate failed OPEN whenever a finding
 *     lacked a `line` field — and in production findings never carried one,
 *     so the gate never engaged and every pre-existing finding escalated.)
 *  2. **Once-per-record rate limit** — at most one escalation per
 *     (file, check) per session. After the first escalation fires the record
 *     is flagged; subsequent emissions of the same check on the same file
 *     don't re-escalate. Caps amplification independent of the proximity test.
 *  3. **Legacy fail-open** — only when `editedLines` is entirely absent
 *     (truly legacy callers with no edit context at all) does the gate fall
 *     back to the old issue-count-only behavior, so those callers still nag.
 *
 * Finding lines arrive two ways: an explicit `line` slot AND a `lines[]`
 * array (one check often reports many lines). Callers that pass `string[]`
 * or `{name, line}` keep working — `runBehavioralChecks` enriches the input
 * with lines parsed from each finding's `detail` block.
 */
export interface EscalationFinding {
	name: string;
	/** Single finding line (legacy single-slot callers / tests). */
	line?: number | undefined;
	/** All lines this check fired on, recovered from the `detail` block. */
	lines?: number[] | undefined;
	/** The underlying check's determinism tag (used by the tier gate). */
	determinism?: Determinism | undefined;
}

/** Per-check aggregation of the escalation inputs: every finding line plus
 * the check's determinism tag (first tag seen wins — a check id maps to one
 * registry entry, so mixed tags don't occur in practice). */
interface EscalationGroup {
	lines: number[];
	determinism?: Determinism | undefined;
}

/** Group current findings by check name; collect every line number per
 * check (from both the single `line` slot and the `lines[]` array) and
 * the check's determinism tag. Legacy `string` entries contribute the
 * name only. */
/** Fold one finding into its check's escalation group (creating the group
 * on first sight): determinism tag (first seen wins), the single `line`
 * slot, and every entry of the `lines[]` array. Legacy `string` entries
 * contribute only the group's existence (name key). */
function foldEscalationInput(
	groups: Map<string, EscalationGroup>,
	r: string | EscalationFinding,
): void {
	const name = typeof r === "string" ? r : r.name;
	let group = groups.get(name);
	if (!group) {
		group = { lines: [] };
		groups.set(name, group);
	}
	if (typeof r === "string") return;
	if (group.determinism === undefined) group.determinism = r.determinism;
	if (typeof r.line === "number" && Number.isFinite(r.line)) group.lines.push(r.line);
	if (Array.isArray(r.lines)) {
		for (const l of r.lines) {
			if (typeof l === "number" && Number.isFinite(l)) group.lines.push(l);
		}
	}
}

function groupEscalationInputs(
	currentResults: ReadonlyArray<string | EscalationFinding>,
): Map<string, EscalationGroup> {
	const groups = new Map<string, EscalationGroup>();
	for (const r of currentResults) {
		foldEscalationInput(groups, r);
	}
	return groups;
}

/**
 * Tier gate (noise governance, 2026-07 recurrence mining): escalation may
 * amplify only default-gate, proven-or-low-FP findings. Advisory-tier check
 * ids and heuristic-determinism findings are excluded — 18% of the dogfood
 * recurrence log was `persistent_warning_escalation`, dominated by advisory
 * heuristics (magic_literal_in_conditional, complexity, ubs_*) the agent
 * often cannot legitimately "fix"; a persisting FP must never become an
 * error. Unknown determinism (legacy string callers, tool-check names like
 * "typescript") stays eligible so those callers keep their old behavior.
 */
function isEscalationEligible(name: string, determinism: Determinism | undefined): boolean {
	if (isOperationalCheckDeferral(name)) return false;
	if (ADVISORY_CHECK_IDS.has(name)) return false;
	return determinism !== "heuristic";
}

// Diff-aware attribution radius (see `checkPersistentWarningEscalation` doc
// comment, gate 1): a finding's line must sit within this many lines of an
// edited line for the agent to be held responsible for it.
const ESCALATION_PROXIMITY_RADIUS = 3;

/**
 * Decide whether one check's persistent finding should escalate to an error,
 * and build the resulting `CheckResultEntry` if so. Pulled out of
 * `checkPersistentWarningEscalation`'s loop body to keep the loop itself flat
 * — this is the single per-check gate-and-build step, unchanged in behavior.
 * Marks `record.escalation_emitted` as a side effect on escalation, exactly
 * as the inline loop body did.
 */
function buildEscalationFinding(
	session: SessionTrajectory,
	filePath: string,
	name: string,
	group: EscalationGroup,
	haveEditData: boolean,
	editedLines: ReadonlySet<number> | undefined,
): CheckResultEntry | null {
	// Tier gate: never amplify advisory-tier / heuristic findings.
	if (!isEscalationEligible(name, group.determinism)) return null;
	const currentLines = group.lines;
	const key = `${filePath}::${name}`;
	const record = session.warnings_issued.get(key);
	if (!record || record.issue_count < 1) return null;
	if (record.escalation_emitted) return null;

	// Diff-aware attribution gate. When we know which lines the edit
	// touched, the agent is responsible for a finding ONLY if one of its
	// lines sits within ESCALATION_PROXIMITY_RADIUS of an edited line. Fail
	// closed: a finding with no recoverable line (or no nearby edit) is not
	// the agent's to answer for, so we do not amplify it. The legacy
	// fall-back (escalate on issue_count alone) applies only when there is
	// no edit data at all.
	if (haveEditData) {
		if (currentLines.length === 0) return null;
		if (!anyFindingNearEditedLine(currentLines, nonNull(editedLines), ESCALATION_PROXIMITY_RADIUS)) {
			return null;
		}
	}

	record.escalation_emitted = true;
	return {
		source: "structural",
		name: "persistent_warning_escalation",
		severity: "error",
		message: `Warning "${name}" persists after re-edit (issued ${record.issue_count + 1} times). Fix the underlying issue.`,
		file: filePath,
		determinism: "fully_deterministic",
	};
}

export function checkPersistentWarningEscalation(
	session: SessionTrajectory,
	filePath: string,
	currentResults: ReadonlyArray<string | EscalationFinding>,
	editedLines?: ReadonlySet<number>,
): CheckResultEntry[] {
	const escalated: CheckResultEntry[] = [];
	const groups = groupEscalationInputs(currentResults);
	const haveEditData = editedLines !== undefined && editedLines.size > 0;

	for (const [name, group] of groups) {
		const finding = buildEscalationFinding(session, filePath, name, group, haveEditData, editedLines);
		if (finding) escalated.push(finding);
	}

	return escalated;
}

// ---- Orchestrator ----

/**
 * Run all behavioral checks for a single file edit and return combined results.
 */
export function runBehavioralChecks(
	session: SessionTrajectory,
	filePath: string,
	currentCheckResults: CheckResultEntry[],
	previousSuppressionCount?: number,
	currentSuppressionCount?: number,
	editedLines?: ReadonlySet<number>,
): CheckResultEntry[] {
	const results: CheckResultEntry[] = [];

	// 1. Repeated edit without test (legacy — skipped if TDD cycles are active for this file)
	if (!session.tdd_cycles.has(filePath)) {
		const repeated = checkRepeatedEditWithoutTest(session, filePath);
		if (repeated) results.push(repeated);
	}

	// 2. Suppression as workaround
	if (previousSuppressionCount !== undefined && currentSuppressionCount !== undefined) {
		const suppression = checkSuppressionAsWorkaround(
			session,
			filePath,
			currentSuppressionCount,
			previousSuppressionCount,
		);
		if (suppression) results.push(suppression);
	}

	// 3. Domain-sensitive test nudge
	const nudge = checkDomainSensitiveTestNudge(session, filePath);
	if (nudge) results.push(nudge);

	// 4. Persistent warning escalation — pass full result objects so the
	// diff-aware attribution gate can read each finding's line numbers, plus
	// the optional editedLines set so the gate can decide whether the agent
	// had agency over each persistent finding. A single `CheckResultEntry`
	// carries at most one `line`, but most inline checks report several lines,
	// all of which live only in the `detail` block — so we recover them here.
	// Without this, the gate saw zero finding lines, failed open, and
	// amplified every stale pre-existing finding on every unrelated edit.
	const escalationInputs: EscalationFinding[] = currentCheckResults.map((r) => ({
		name: r.name,
		line: r.line,
		lines: extractDetailLines(r.detail),
		determinism: r.determinism,
	}));
	const escalations = checkPersistentWarningEscalation(
		session,
		filePath,
		escalationInputs,
		editedLines,
	);
	results.push(...escalations);

	// 5. TDD cycle checks
	const cycleViolation = checkTddCycleViolation(session, filePath);
	if (cycleViolation) results.push(cycleViolation);

	const regression = checkTddRegression(session, filePath);
	if (regression) results.push(regression);

	const greenConfirm = checkTddGreenConfirmation(session, filePath);
	if (greenConfirm) results.push(greenConfirm);

	return results;
}
