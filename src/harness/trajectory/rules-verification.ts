// ===========================================
// Deterministic Trajectory-Analysis Engine — Family 7: Verification Discipline
// ===========================================
//
// CONTINUOUS, mid-session verification-discipline signals — deliberately distinct
// from the Stop-time reflection nudges in verification-stop-checks.ts and the
// uncommitted-count nudge in commit-cadence.ts. These fire DURING the session, as
// unverified work accumulates, not at Stop.
//
// Every rule is a pure `(state, event) => Verdict | null` reading the
// already-folded state — chiefly the bounded `recentEvents` window plus the
// session verify/edit counters (`verifyRunCount`, `successfulEditCount`). Reading
// the window (rather than adding new substrate) keeps the fold untouched and the
// rules self-contained. Per the catalog these are NUDGE / SILENT_METRIC, never
// block: "no verifier observed" is a discipline signal, not deterministic harm,
// so a blocked legitimate commit would fail the low-FP bar.

import { isSourceCodeFile, isTestFile, isVerifyCommand, splitSegments } from "./helpers.js";
import type { ToolEvent, TrajectoryRule, Verdict } from "./types.js";

function nudge(ruleId: string, severity: Verdict["severity"], reason: string): Verdict {
	return { ruleId, action: "nudge", severity, reason };
}
function metric(ruleId: string, reason: string): Verdict {
	return { ruleId, action: "silent_metric", severity: "low", reason };
}

/** Lines in a string (0 for empty). */
function lineCount(s: string): number {
	return s.length === 0 ? 0 : s.split("\n").length;
}

/** Lines a Post edit touched (new region + replaced region) — a deterministic churn proxy. */
function editLines(event: ToolEvent): number {
	const added = event.input.content ?? event.input.new_string ?? "";
	const removed = event.input.old_string ?? "";
	return lineCount(added) + lineCount(removed);
}

function isPostEdit(event: ToolEvent): boolean {
	return (
		event.hook === "PostToolUse" &&
		(event.tool === "Edit" || event.tool === "Write" || event.tool === "MultiEdit")
	);
}
function isPostSourceEdit(event: ToolEvent): boolean {
	return isPostEdit(event) && !!event.input.file_path && isSourceCodeFile(event.input.file_path);
}
function isPostVerify(event: ToolEvent): boolean {
	return (
		event.hook === "PostToolUse" &&
		event.tool === "Bash" &&
		typeof event.input.command === "string" &&
		isVerifyCommand(event.input.command)
	);
}

/**
 * git commit / git push in any pipeline segment. Skips bare `git add` and the
 * `git -C <dir>` / `git -c k=v` global-option forms so the subcommand is read
 * correctly (e.g. `git -C repo commit` still matches).
 */
function isGitCommitOrPush(cmd: string): boolean {
	for (const seg of splitSegments(cmd)) {
		const toks = seg.split(/\s+/).filter((t) => t.length > 0);
		const gi = toks.findIndex((t) => t === "git" || t.endsWith("/git"));
		if (gi === -1) continue;
		for (let i = gi + 1; i < toks.length; i++) {
			const t = toks[i] ?? "";
			if (t === "-C" || t === "-c") {
				i++; // this global option consumes its argument
				continue;
			}
			if (t.startsWith("-")) continue; // other flags
			if (t === "commit" || t === "push") return true;
			break; // the first real subcommand isn't commit/push
		}
	}
	return false;
}

// ============================================================
// vd_code_edit_streak_no_verify (N/M)
// ============================================================
// ≥8 source-code edits AND ≥60 lines touched since the last verifier run (no
// test/build/lint between). Fires once per threshold crossing (8/16/24) so it
// does not re-nudge on every later edit; a verifier run resets the streak (the
// backward scan stops at it). Non-source edits (config/docs/data) don't count.
const STREAK_EDIT_THRESHOLDS: ReadonlySet<number> = new Set([8, 16, 24]);
const STREAK_MIN_LINES = 60;
export const vdCodeEditStreakNoVerify: TrajectoryRule = (state, event) => {
	if (!isPostSourceEdit(event)) return null;
	const ev = state.recentEvents;
	let edits = 0;
	let lines = 0;
	for (let i = ev.length - 1; i >= 0; i--) {
		const e = ev[i];
		if (!e) continue;
		if (isPostVerify(e)) break; // reached the last verifier run — streak boundary
		if (isPostSourceEdit(e)) {
			edits += 1;
			lines += editLines(e);
		}
	}
	if (!STREAK_EDIT_THRESHOLDS.has(edits) || lines < STREAK_MIN_LINES) return null;
	return nudge(
		"vd_code_edit_streak_no_verify",
		edits >= 16 ? "high" : "medium",
		`${edits} source edits (~${lines} lines) have landed since the last test / typecheck / lint / ` +
			"build run. Long unverified edit streaks let errors pile up silently — run the verifier now " +
			"to catch regressions while the changes are still fresh.",
	);
};

// ============================================================
// vd_commit_no_verify_this_session (N — catalog downgrades push-block to nudge)
// ============================================================
// A git commit/push while NO verifier ran the whole session and ≥3 source-code
// edits were made. FP guards: session-total verifyRunCount==0 (a verifier run at
// any point suppresses it); require ≥3 recent SOURCE edits so a docs-only commit
// never nudges. Nudge, never block — "no verifier observed" ≠ harm.
const COMMIT_MIN_SOURCE_EDITS = 3;
export const vdCommitNoVerify: TrajectoryRule = (state, event) => {
	if (event.hook !== "PreToolUse" || event.tool !== "Bash") return null;
	const cmd = event.input.command;
	if (!cmd || !isGitCommitOrPush(cmd)) return null;
	if (state.verifyRunCount > 0) return null; // a verifier ran this session
	let sourceEdits = 0;
	for (const e of state.recentEvents) {
		if (isPostSourceEdit(e)) sourceEdits += 1;
	}
	if (sourceEdits < COMMIT_MIN_SOURCE_EDITS) return null;
	return nudge(
		"vd_commit_no_verify_this_session",
		"medium",
		`${sourceEdits}+ source files were edited this session but no test / typecheck / lint / build ` +
			"was ever run before this commit. Committing unverified code ships whatever broke silently — " +
			"run the verifier first.",
	);
};

// ============================================================
// vd_verification_cadence_decay (M — silent_metric)
// ============================================================
// Verifier runs are getting rarer: the last three inter-verify gaps (measured in
// recent-window positions) are strictly increasing AND the newest is >2× the gap
// two-ago. Needs ≥4 verifier runs in the window; fires only on the freshest
// verify. Silent metric (labeler/Stop-reflection feed), not a nudge.
export const vdVerificationCadenceDecay: TrajectoryRule = (state, event) => {
	if (!isPostVerify(event)) return null;
	const ev = state.recentEvents;
	const verifyIdxs: number[] = [];
	for (let i = 0; i < ev.length; i++) {
		const e = ev[i];
		if (e && isPostVerify(e)) verifyIdxs.push(i);
	}
	if (verifyIdxs.length < 4) return null;
	// Only evaluate on the freshest verify (this event, just pushed as the last).
	if (verifyIdxs[verifyIdxs.length - 1] !== ev.length - 1) return null;
	const gaps: number[] = [];
	for (let i = 1; i < verifyIdxs.length; i++) {
		const a = verifyIdxs[i];
		const b = verifyIdxs[i - 1];
		if (a === undefined || b === undefined) continue;
		gaps.push(a - b);
	}
	const n = gaps.length;
	if (n < 3) return null;
	const gn = gaps[n - 1];
	const gn1 = gaps[n - 2];
	const gn2 = gaps[n - 3];
	if (gn === undefined || gn1 === undefined || gn2 === undefined) return null;
	if (!(gn > gn1 && gn1 > gn2)) return null; // strictly increasing
	if (gn <= 2 * gn2) return null; // and the newest gap more than doubled vs two-ago
	return metric(
		"vd_verification_cadence_decay",
		`Time between verifier runs is stretching (recent gaps ${gn2} → ${gn1} → ${gn} tool calls). ` +
			"Verifying less and less often lets more unverified work accumulate between checks.",
	);
};

// ============================================================
// vd_code_to_test_edit_ratio (M — silent_metric)
// ============================================================
// Recent activity has crossed 10 (then 20) source-code edits with ZERO test-file
// edits — code is changing but no tests are being added or updated alongside it.
// Fires once per threshold; a single test edit in the window suppresses it.
const RATIO_CODE_THRESHOLDS: ReadonlySet<number> = new Set([10, 20]);
export const vdCodeToTestEditRatio: TrajectoryRule = (state, event) => {
	if (!isPostEdit(event)) return null;
	let code = 0;
	let test = 0;
	for (const e of state.recentEvents) {
		if (!isPostEdit(e)) continue;
		const f = e.input.file_path;
		if (!f) continue;
		if (isTestFile(f)) test += 1;
		else if (isSourceCodeFile(f)) code += 1;
	}
	if (test > 0 || !RATIO_CODE_THRESHOLDS.has(code)) return null;
	return metric(
		"vd_code_to_test_edit_ratio",
		`${code} source-code edits with zero test-file edits in recent activity. Code is changing but ` +
			"no tests are being added or updated alongside it — consider whether the new behavior is covered.",
	);
};

/** All Family-7 verification-discipline rules. */
export const VERIFICATION_RULES: ReadonlyArray<TrajectoryRule> = [
	vdCodeEditStreakNoVerify,
	vdCommitNoVerify,
	vdVerificationCadenceDecay,
	vdCodeToTestEditRatio,
];
