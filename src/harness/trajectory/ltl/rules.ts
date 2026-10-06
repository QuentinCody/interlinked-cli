// ===========================================
// Trajectory LTL — rules expressed as formulas (shadow mode)
// ===========================================
//
// Three hand-coded trajectory rules restated as temporal formulas, plus one
// future-time property the hand-coded families cannot express. The parity
// rules carry the hand-coded rule they mirror; `rules.test.ts` checks on
// random recorded-shaped traces that the formula fires at exactly the events
// the hand-coded rule fires at. Every atom is a pure predicate over the
// folded `TrajectoryState` and the current `ToolEvent`.
//
// The three parity rules are all safety properties of the shape
// `always(trigger ⇒ guard)`: the formula layer adds a reviewable statement and
// evidence slicing, not new temporal power. The future-time property is where
// the language earns its place: "a source edit is followed by a verifier run
// within N events" is one line here and a counter ladder in rules-verification.

import { isPostEdit, isSourceCodeFile, isTestFile, isVerifyCommand } from "../helpers.js";
import { rebColdStartFirstEditZeroReads } from "../rules-read-edit.js";
import { vdCodeEditStreakNoVerify, vdCodeToTestEditRatio } from "../rules-verification.js";
import type { ToolEvent, TrajectoryRule, TrajectoryState } from "../types.js";
import type { Property } from "./eval.js";
import { always, and, atom, eventually, implies, or } from "./formula.js";

type A = ReturnType<typeof atom<TrajectoryState, ToolEvent>>;
const pred = (name: string, f: (state: TrajectoryState, event: ToolEvent) => boolean): A =>
	atom<TrajectoryState, ToolEvent>(name, f);

export interface ParityRule {
	readonly property: Property<TrajectoryState, ToolEvent>;
	readonly handCoded: TrajectoryRule;
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const postEdit = pred("postEdit", (_s, e) => isPostEdit(e));
const postSourceEdit = pred(
	"postSourceEdit",
	(_s, e) => isPostEdit(e) && e.input.file_path !== undefined && isSourceCodeFile(e.input.file_path),
);
const postSurgicalEdit = pred(
	"postSurgicalEdit",
	(_s, e) =>
		e.hook === "PostToolUse" &&
		(e.tool === "Edit" || e.tool === "MultiEdit") &&
		!!e.input.file_path &&
		!!e.input.old_string,
);
const multilineOldString = pred("multilineOldString", (_s, e) => (e.input.old_string ?? "").includes("\n"));
const sessionOriented = pred(
	"sessionOriented",
	(s) => s.readCount > 0 || s.searchCount > 0 || s.fileReadSteps.size > 0,
);
const priorEditRecorded = pred("priorEditRecorded", (s) => {
	let total = 0;
	for (const log of s.fileEditLog.values()) {
		total += log.length;
		if (total > 1) return true;
	}
	return false;
});

const RATIO_THRESHOLDS: ReadonlySet<number> = new Set([10, 20]);
function recentEditCounts(s: TrajectoryState): { code: number; test: number } {
	let code = 0;
	let test = 0;
	for (const e of s.recentEvents) {
		const f = e.input.file_path;
		if (!isPostEdit(e) || !f) continue;
		if (isTestFile(f)) test += 1;
		else if (isSourceCodeFile(f)) code += 1;
	}
	return { code, test };
}
const codeEditsAtRatioThreshold = pred("codeEditsAtRatioThreshold", (s) => RATIO_THRESHOLDS.has(recentEditCounts(s).code));
const testEditInWindow = pred("testEditInWindow", (s) => recentEditCounts(s).test > 0);

const postVerify = pred(
	"postVerify",
	(_s, e) => e.hook === "PostToolUse" && e.tool === "Bash" && typeof e.input.command === "string" && isVerifyCommand(e.input.command),
);
const STREAK_THRESHOLDS: ReadonlySet<number> = new Set([8, 16, 24]);
const STREAK_MIN_LINES = 60;
const lineCount = (s: string): number => (s.length === 0 ? 0 : s.split("\n").length);
/** Source edits and lines touched since the last verifier run in the recent window (newest first). */
function unverifiedStreak(s: TrajectoryState): { edits: number; lines: number } {
	let edits = 0;
	let lines = 0;
	for (let i = s.recentEvents.length - 1; i >= 0; i--) {
		const e = s.recentEvents[i];
		if (!e) continue;
		if (postVerify.pred(s, e)) break;
		if (!postSourceEdit.pred(s, e)) continue;
		edits += 1;
		lines += lineCount(e.input.content ?? e.input.new_string ?? "") + lineCount(e.input.old_string ?? "");
	}
	return { edits, lines };
}
const unverifiedStreakAtThreshold = pred("unverifiedStreakAtThreshold", (s) => STREAK_THRESHOLDS.has(unverifiedStreak(s).edits));
const unverifiedStreakIsSmall = pred("unverifiedStreakIsSmall", (s) => unverifiedStreak(s).lines < STREAK_MIN_LINES);

// ---------------------------------------------------------------------------
// Parity rules: always(trigger ⇒ guard)
// ---------------------------------------------------------------------------

/** An early multi-line surgical edit requires orientation (a read or search) or a prior edit. */
const coldStartParity: ParityRule = {
	property: {
		id: "reb_cold_start_first_edit_zero_reads",
		formula: always(implies(and(postSurgicalEdit, multilineOldString), or(sessionOriented, priorEditRecorded))),
	},
	handCoded: rebColdStartFirstEditZeroReads,
};

/** Reaching 10 / 20 recent code edits requires at least one test edit in the window. */
const codeToTestRatioParity: ParityRule = {
	property: {
		id: "vd_code_to_test_edit_ratio",
		formula: always(implies(and(postEdit, codeEditsAtRatioThreshold), testEditInWindow)),
	},
	handCoded: vdCodeToTestEditRatio,
};

/** An unverified streak of 8 / 16 / 24 source edits must stay small (< 60 lines touched). */
const editStreakParity: ParityRule = {
	property: {
		id: "vd_code_edit_streak_no_verify",
		formula: always(implies(and(postSourceEdit, unverifiedStreakAtThreshold), unverifiedStreakIsSmall)),
	},
	handCoded: vdCodeEditStreakNoVerify,
};

export const LTL_PARITY_RULES: readonly ParityRule[] = [coldStartParity, codeToTestRatioParity, editStreakParity];

// ---------------------------------------------------------------------------
// Future-time property (no hand-coded twin)
// ---------------------------------------------------------------------------

/** Events (tool-call hooks, Pre + Post each count) within which a source edit must be followed by a verifier run. */
export const SOURCE_EDIT_VERIFIED_WITHIN = 24;

/** Every shadow-evaluated property: the three parity formulas plus the future-time one. */
export const LTL_SHADOW_PROPERTIES: readonly Property<TrajectoryState, ToolEvent>[] = [
	...LTL_PARITY_RULES.map((r) => r.property),
	{
		id: "source_edit_verified_within_events",
		formula: always(implies(postSourceEdit, eventually(postVerify, SOURCE_EDIT_VERIFIED_WITHIN))),
	},
];
