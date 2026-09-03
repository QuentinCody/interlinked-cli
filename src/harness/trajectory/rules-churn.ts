// ===========================================
// Deterministic Trajectory-Analysis Engine — Family 1: Churn / Thrash
// ===========================================
//
// Non-progress loops. Each rule is a pure `(state, event) => Verdict | null`
// that reads the already-folded TrajectoryState. All churn rules evaluate at
// PostToolUse (they need the content-hash / outcome / check fields and the
// fold to have run). Per the catalog these are NUDGE/METRIC, never block —
// non-progress is not deterministic harm and a blocked legitimate bisection /
// refactor would fail the low-FP bar.

import { commandFamily, commandHeads, isSourceCodeFile, normalizeCommand } from "./helpers.js";
import type {
	EditRecord,
	ShaEntry,
	ToolEvent,
	TrajectoryRule,
	Verdict,
} from "./types.js";

function isPostEdit(event: ToolEvent): boolean {
	return (
		event.hook === "PostToolUse" &&
		(event.tool === "Edit" || event.tool === "Write" || event.tool === "MultiEdit")
	);
}

function verdict(
	ruleId: string,
	severity: Verdict["severity"],
	reason: string,
): Verdict {
	return { ruleId, action: "nudge", severity, reason };
}

// ============================================================
// churn_sha_cycle_revisit (N/M)
// ============================================================
// New edit produces a content_sha256 already in the file's list → closed loop.
// FP guard: fire only when there are ≥2 distinct revisits OR a failing check
// intervened, and never when the cycle delta is whitespace-only.
/** Indexes before `lastIdx` whose sha equals the current entry's sha. */
function priorShaMatches(hist: ShaEntry[], cur: ShaEntry, lastIdx: number): number[] {
	const priorIdxs: number[] = [];
	for (let i = 0; i < lastIdx; i++) {
		if (hist[i]?.sha === cur.sha) priorIdxs.push(i);
	}
	return priorIdxs;
}

/**
 * Whitespace-only exclusion: if every entry between the matched prior and now
 * shares the current normalized hash, nothing substantive changed.
 */
// `span` is typed to admit holes (`ShaEntry | undefined` elements): `.slice()`
// of a sparse `hist` array preserves the holes, and iterating a sparse array
// with `for...of` yields `undefined` at each hole — a real runtime shape the
// dense `ShaEntry[]` type would otherwise lie about, making the optional
// chain below read as an impossible branch instead of the live guard it is.
function isWhitespaceOnlyCycle(span: Array<ShaEntry | undefined>, curNormSha: string): boolean {
	for (const entry of span) {
		// Optional chain retained deliberately: a sparse-array hole must compare
		// unequal rather than throw (pinned by the mutation-hardening tests).
		if (entry?.normSha !== curNormSha) return false;
	}
	return true;
}

/** A failing-check edit landed strictly between the prior occurrence and now. */
function failingCheckIntervened(
	log: EditRecord[],
	sincePrior: number,
	untilStep: number,
): boolean {
	for (const rec of log) {
		if (rec.atStep > sincePrior && rec.atStep < untilStep && rec.failedCheck) {
			return true;
		}
	}
	return false;
}

export const churnShaCycleRevisit: TrajectoryRule = (state, event) => {
	if (!isPostEdit(event) || !event.contentSha256) return null;
	const file = event.input.file_path;
	if (!file) return null;
	const hist = state.fileShaHistory.get(file);
	if (!hist || hist.length < 2) return null;
	const lastIdx = hist.length - 1;
	const cur = hist[lastIdx];
	if (!cur) return null;

	const priorIdxs = priorShaMatches(hist, cur, lastIdx);
	if (priorIdxs.length === 0) return null;
	const firstPrior = priorIdxs[0] ?? 0;

	if (isWhitespaceOnlyCycle(hist.slice(firstPrior, lastIdx), cur.normSha)) return null;

	const twoDistinctRevisits = priorIdxs.length >= 2;
	const log = state.fileEditLog.get(file) ?? [];
	const sincePrior = hist[firstPrior]?.atStep ?? 0;
	const failingIntervened = failingCheckIntervened(log, sincePrior, cur.atStep);
	if (!twoDistinctRevisits && !failingIntervened) return null;

	return verdict(
		"churn_sha_cycle_revisit",
		"medium",
		`Edit to ${file} returned its content to an earlier state this session ` +
			`(${priorIdxs.length} prior occurrence(s) of this exact content). The file is ` +
			"cycling through states rather than converging — step back and reconsider the approach.",
	);
};

// ============================================================
// churn_literal_edit_revert (N/M)
// ============================================================
// Strict exact-undo: a prior edit P with E.old===P.new && E.new===P.old.
export const churnLiteralEditRevert: TrajectoryRule = (state, event) => {
	if (!isPostEdit(event)) return null;
	const file = event.input.file_path;
	if (!file) return null;
	const log = state.fileEditLog.get(file);
	if (!log || log.length < 2) return null;
	const e = log[log.length - 1];
	if (!e) return null;
	if (e.old === e.new) return null; // no-op edit
	if (e.old.length === 0 && e.new.length === 0) return null;
	for (let i = log.length - 2; i >= 0; i--) {
		const p = log[i];
		if (!p) continue;
		if (e.old === p.new && e.new === p.old) {
			return verdict(
				"churn_literal_edit_revert",
				"medium",
				`Edit to ${file} is an exact undo of an earlier edit this session (the new text ` +
					"restores what a prior edit replaced, and vice-versa). This is a literal revert — " +
					"if the earlier change was wrong, understand why before re-touching this region.",
			);
		}
	}
	return null;
};

// ============================================================
// churn_undo_war_value_toggle (N/H)
// ============================================================
// Per-(file,anchor) value sequence holds A,B,A: current==value-2-ago != value-1-ago.
// FP guard: suppress if a test/build ran between the toggles (= bisection).
export const churnUndoWarValueToggle: TrajectoryRule = (state, event) => {
	if (!isPostEdit(event)) return null;
	const file = event.input.file_path;
	if (!file) return null;
	for (const [key, seq] of state.anchorValueSeq) {
		if (!key.startsWith(`${file} `)) continue;
		const n = seq.length;
		if (n < 3) continue;
		const a = seq[n - 1];
		const b = seq[n - 2];
		const a2 = seq[n - 3];
		if (!a || !b || !a2) continue;
		if (a.valueHash !== a2.valueHash) continue;
		if (a.valueHash === b.valueHash) continue;
		// Only fire on the freshest toggle (the one this edit just produced).
		if (a.atStep !== state.stepCount) continue;
		// Bisection suppression: a test/build ran between the two A states.
		if (a.verifyCountAtEntry > a2.verifyCountAtEntry) continue;
		return verdict(
			"churn_undo_war_value_toggle",
			"high",
			`A region of ${file} is flapping between two values (A→B→A) with no test/build run ` +
				"between the flips. This is an undo-war, not a bisection — pick one value and verify it, " +
				"or change the surrounding code so the choice is forced.",
		);
	}
	return null;
};

// ============================================================
// churn_edits_without_green (N/M)
// ============================================================
// Per-file edits-since-green counter; emit at 5, escalate at 8/12.
const EDITS_WITHOUT_GREEN_THRESHOLDS = new Set([5, 8, 12]);
export const churnEditsWithoutGreen: TrajectoryRule = (state, event) => {
	if (!isPostEdit(event)) return null;
	const file = event.input.file_path;
	if (!file || !isSourceCodeFile(file)) return null; // exempt config/docs/data/type-only
	const count = state.editsSinceGreen.get(file) ?? 0;
	if (!EDITS_WITHOUT_GREEN_THRESHOLDS.has(count)) return null;
	return verdict(
		"churn_edits_without_green",
		count >= 12 ? "high" : "medium",
		`${file} has had ${count} consecutive edits without reaching a clean state (no edit ` +
			"passed its checks). Repeated edits that never go green are a sign of guessing — " +
			"read the failing output carefully and form a hypothesis before the next edit.",
	);
};

// ============================================================
// churn_repeated_failing_bash (N/M)
// ============================================================
// A normalized command that failed before fails again; fire on the 3rd run.
// FP guards: resets on an intervening edit (in state.foldEdit); flaky/network
// verbs are exempt.
const FLAKY_HEADS = new Set([
	"curl", "wget", "ping", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "dig", "nslookup", "host",
]);
function isFlakyCommand(cmd: string): boolean {
	if (commandHeads(cmd).some((h) => FLAKY_HEADS.has(h))) return true;
	return /\bgit\s+(?:fetch|pull|clone|push|remote)\b/.test(cmd);
}
export const churnRepeatedFailingBash: TrajectoryRule = (state, event) => {
	if (event.hook !== "PostToolUse" || event.tool !== "Bash") return null;
	if (event.toolOutcome !== "fail") return null;
	const cmd = event.input.command;
	if (!cmd || isFlakyCommand(cmd)) return null;
	const entry = state.commandFailures.get(normalizeCommand(cmd));
	if (!entry || entry.count < 3) return null;
	return verdict(
		"churn_repeated_failing_bash",
		"medium",
		`The same Bash command has now failed ${entry.count} times this session with no ` +
			"successful edit between the runs. Re-running an unchanged command yields the same " +
			"failure — change an input or fix the underlying cause before re-issuing it.",
	);
};

// ============================================================
// churn_rerun_failing_test_no_source_change (N/M)
// ============================================================
// Test/build re-run after a same-family failure with zero successful edits
// between. One confirmation re-run is allowed; reset on install/checkout/env.
export const churnRerunFailingTestNoSourceChange: TrajectoryRule = (state, event) => {
	if (event.hook !== "PostToolUse" || event.tool !== "Bash") return null;
	if (event.toolOutcome !== "fail") return null;
	const cmd = event.input.command;
	if (!cmd) return null;
	const fam = commandFamily(cmd);
	if (fam !== "test" && fam !== "build") return null;
	const entry = state.familyReruns.get(fam);
	if (!entry || entry.failingNoEditCount < 3) return null;
	return verdict(
		"churn_rerun_failing_test_no_source_change",
		"medium",
		`The ${fam} suite has been re-run ${entry.failingNoEditCount} times while still failing, ` +
			"with no successful source edit between the runs. The result is deterministic — edit the " +
			"code (or the test) before running it again.",
	);
};

// ============================================================
// churn_revert_after_check_fail_combo (N/H)
// ============================================================
// The auto-labeler's top bad-edit combo: E1 fails a check → a literal revert of
// E1 → E3 byte-identically re-applies E1, ≤6 edits apart, no green between, no
// install/env/git disruptor between.
const REVERT_COMBO_WINDOW = 6;

/** A literal revert of `e1` sits somewhere in `span`. */
// `span` is typed to admit holes (`EditRecord | undefined` elements) for the
// same sparse-`.slice()` reason as `isWhitespaceOnlyCycle` above.
function hasLiteralRevertIn(span: Array<EditRecord | undefined>, e1: EditRecord): boolean {
	for (const p of span) {
		// Truthiness guard retained deliberately: a sparse-array hole must be
		// skipped rather than throw.
		if (p && p.old === e1.new && p.new === e1.old) return true;
	}
	return false;
}

/**
 * The edit at `i` is a failing edit that the log's last edit re-applies
 * byte-for-byte, with a literal revert in between, no green since, and no
 * install/env/git disruptor between.
 */
function isReapplyOfFailingEdit(
	log: EditRecord[],
	i: number,
	lastDisruptStep: number,
): boolean {
	const e3Idx = log.length - 1;
	const e3 = log[e3Idx];
	const e1 = log[i];
	if (!e3 || !e1 || !e1.failedCheck) return false;
	// Byte-identical re-apply of the failing edit E1.
	if (e1.old !== e3.old || e1.new !== e3.new) return false;
	// A literal revert of E1 must sit strictly between E1 and E3.
	if (!hasLiteralRevertIn(log.slice(i + 1, e3Idx), e1)) return false;
	// No green anywhere between E1 and E3 (covers "other file passed a check").
	if (e3.greenCountAtEntry !== e1.greenCountAtEntry) return false;
	// No install/env/git disruptor between E1 and E3.
	if (lastDisruptStep > e1.atStep && lastDisruptStep < e3.atStep) return false;
	return true;
}

export const churnRevertAfterCheckFailCombo: TrajectoryRule = (state, event) => {
	if (!isPostEdit(event)) return null;
	const file = event.input.file_path;
	if (!file) return null;
	const log = state.fileEditLog.get(file);
	if (!log || log.length < 3) return null;
	const e3Idx = log.length - 1;
	const e3 = log[e3Idx];
	if (!e3 || (e3.old === e3.new)) return null;

	const lo = Math.max(0, e3Idx - REVERT_COMBO_WINDOW);
	for (let i = e3Idx - 1; i >= lo; i--) {
		if (!isReapplyOfFailingEdit(log, i, state.lastDisruptStep)) continue;
		return {
			ruleId: "churn_revert_after_check_fail_combo",
			action: "nudge",
			severity: "high",
			reason:
				`${file} just re-applied, byte-for-byte, an edit that already failed a check earlier ` +
				"this session (with a revert in between and no passing check since). Re-applying a " +
				"known-failing change without addressing why it failed will fail the same way — fix the " +
				"root cause instead of toggling.",
		};
	}
	return null;
};

/** All Family-1 churn rules. */
export const CHURN_RULES: ReadonlyArray<TrajectoryRule> = [
	churnShaCycleRevisit,
	churnLiteralEditRevert,
	churnUndoWarValueToggle,
	churnEditsWithoutGreen,
	churnRepeatedFailingBash,
	churnRerunFailingTestNoSourceChange,
	churnRevertAfterCheckFailCombo,
];
