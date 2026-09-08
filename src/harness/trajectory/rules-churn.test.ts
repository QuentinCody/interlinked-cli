import { describe, expect, it } from "vitest";

import { normalizeCommand, sha256 } from "./helpers.js";
import {
	CHURN_RULES,
	churnEditsWithoutGreen,
	churnLiteralEditRevert,
	churnRepeatedFailingBash,
	churnRerunFailingTestNoSourceChange,
	churnRevertAfterCheckFailCombo,
	churnShaCycleRevisit,
	churnUndoWarValueToggle,
} from "./rules-churn.js";
import { applyEvent, createState } from "./state.js";
import type { ToolEvent, TrajectoryRule, TrajectoryState, Verdict } from "./types.js";

// ===========================================
// Compact event builders
// ===========================================

let seq = 0;
function nextId(): string {
	seq += 1;
	return `t${seq}`;
}

interface EditOpts {
	fail?: boolean;
	outcome?: "success" | "fail";
	tool?: "Edit" | "Write" | "MultiEdit";
}
function editEvents(file: string, oldStr: string, newStr: string, opts: EditOpts = {}): ToolEvent[] {
	const tool = opts.tool ?? "Edit";
	const id = nextId();
	const input = { file_path: file, old_string: oldStr, new_string: newStr };
	const failed = opts.fail ?? false;
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool, toolUseId: id, hook: "PreToolUse", input },
		{
			ts: "2026-01-01T00:00:01Z",
			session: "s",
			agent: "a",
			tool,
			toolUseId: id,
			hook: "PostToolUse",
			input,
			contentSha256: sha256(newStr),
			toolOutcome: opts.outcome ?? "success",
			checkDecision: "allow",
			failedCheckIds: failed ? ["some_check"] : [],
		},
	];
}

function bashEvents(command: string, opts: { outcome?: "success" | "fail" } = {}): ToolEvent[] {
	const id = nextId();
	const input = { command };
	return [
		{ ts: "2026-01-01T00:00:00Z", session: "s", agent: "a", tool: "Bash", toolUseId: id, hook: "PreToolUse", input },
		{
			ts: "2026-01-01T00:00:01Z",
			session: "s",
			agent: "a",
			tool: "Bash",
			toolUseId: id,
			hook: "PostToolUse",
			input,
			toolOutcome: opts.outcome ?? "success",
		},
	];
}

function run(events: ToolEvent[], rules: ReadonlyArray<TrajectoryRule> = CHURN_RULES): Verdict[] {
	const state = createState("s");
	const out: Verdict[] = [];
	for (const ev of events) {
		applyEvent(state, ev);
		for (const r of rules) {
			const v = r(state, ev);
			if (v) out.push(v);
		}
	}
	return out;
}
function firedIds(verdicts: Verdict[]): Set<string> {
	return new Set(verdicts.map((v) => v.ruleId));
}

/** Fold every event and return the resulting state (discarding verdicts). */
function runState(events: ToolEvent[]): TrajectoryState {
	const state = createState("s");
	for (const ev of events) applyEvent(state, ev);
	return state;
}

function lastEvent(events: ToolEvent[]): ToolEvent {
	const e = events[events.length - 1];
	if (!e) throw new Error("no events");
	return e;
}

/** A synthetic PostToolUse edit event not run through applyEvent — for probing
 *  a rule directly against hand-crafted state. */
function postEditEvent(tool: "Edit" | "Write" | "MultiEdit", input: ToolEvent["input"]): ToolEvent {
	return {
		ts: "2026-01-01T00:00:00Z",
		session: "s",
		agent: "a",
		tool,
		toolUseId: nextId(),
		hook: "PostToolUse",
		input,
		contentSha256: sha256(input.new_string ?? ""),
		toolOutcome: "success",
		checkDecision: "allow",
		failedCheckIds: [],
	};
}

/** Crafted state with a pre-populated commandFailures entry (bash-repeat rule). */
function makeBashState(cmd: string, count: number): TrajectoryState {
	const state = createState("s");
	state.commandFailures.set(normalizeCommand(cmd), { count, lastStep: 1 });
	return state;
}

/** Crafted state with a pre-populated familyReruns entry (test/build-rerun rule). */
function makeFamilyState(fam: string, count: number): TrajectoryState {
	const state = createState("s");
	state.familyReruns.set(fam, { failingNoEditCount: count, editCountAtLastRun: 0, lastStep: 1 });
	return state;
}

// Stable multi-line block whose first+last lines are constant → constant anchor.
const F1 = "function f() {\n  return 1;\n}";
const F2 = "function f() {\n  return 2;\n}";
const F3 = "function f() {\n  return 3;\n}";

// ===========================================
// churn_sha_cycle_revisit
// ===========================================
describe("churn_sha_cycle_revisit", () => {
	it("fires on A→B→A when a failing check intervened, with an exact reason and medium severity", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B", { fail: true }),
			...editEvents("src/a.ts", "B", "A"),
		]);
		const hit = v.find((x) => x.ruleId === "churn_sha_cycle_revisit");
		expect(hit?.severity).toBe("medium");
		expect(hit?.reason).toBe(
			"Edit to src/a.ts returned its content to an earlier state this session " +
				"(1 prior occurrence(s) of this exact content). The file is " +
				"cycling through states rather than converging — step back and reconsider the approach.",
		);
	});

	it("fires on A→B→A→B→A with two distinct revisits", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(true);
	});

	it("fires on A→B→C→A with a failing edit in the loop", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B", { fail: true }),
			...editEvents("src/a.ts", "B", "C"),
			...editEvents("src/a.ts", "C", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(true);
	});

	it("does NOT fire on a single A→B→A with no failing check (one revisit)", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});

	it("does NOT fire on a whitespace-only cycle (x=1 → x=1 → x=1)", () => {
		const v = run([
			...editEvents("src/a.ts", "", "x=1"),
			...editEvents("src/a.ts", "x=1", "x=1 "),
			...editEvents("src/a.ts", "x=1 ", "x=1"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});

	it("does NOT fire when there is no cycle (A→B→C distinct)", () => {
		const v = run([
			...editEvents("src/a.ts", "", "A"),
			...editEvents("src/a.ts", "A", "B"),
			...editEvents("src/a.ts", "B", "C"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});
});

// ===========================================
// churn_literal_edit_revert
// ===========================================
describe("churn_literal_edit_revert", () => {
	it("fires on a strict exact undo (foo→bar then bar→foo), with an exact reason and medium severity", () => {
		const v = run([
			...editEvents("src/a.ts", "foo", "bar"),
			...editEvents("src/a.ts", "bar", "foo"),
		]);
		const hit = v.find((x) => x.ruleId === "churn_literal_edit_revert");
		expect(hit?.severity).toBe("medium");
		expect(hit?.reason).toBe(
			"Edit to src/a.ts is an exact undo of an earlier edit this session (the new text " +
				"restores what a prior edit replaced, and vice-versa). This is a literal revert — " +
				"if the earlier change was wrong, understand why before re-touching this region.",
		);
	});

	it("fires when the revert follows an unrelated edit in between", () => {
		const v = run([
			...editEvents("src/a.ts", "alpha", "beta"),
			...editEvents("src/b.ts", "p", "q"),
			...editEvents("src/a.ts", "beta", "alpha"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});

	it("fires on a second region's exact undo", () => {
		const v = run([
			...editEvents("src/a.ts", "let x = 1", "let x = 2"),
			...editEvents("src/a.ts", "let x = 2", "let x = 1"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});

	it("does NOT fire on a non-exact (substring) reversal", () => {
		const v = run([
			...editEvents("src/a.ts", "bar", "foobar"),
			...editEvents("src/a.ts", "foobar", "bar2"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(false);
	});

	it("does NOT fire when the second edit is not the inverse (a→b then b→c)", () => {
		const v = run([
			...editEvents("src/a.ts", "a", "b"),
			...editEvents("src/a.ts", "b", "c"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(false);
	});

	it("does NOT fire on a no-op edit (old === new)", () => {
		const v = run([
			...editEvents("src/a.ts", "same", "same"),
			...editEvents("src/a.ts", "same", "same"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(false);
	});
});

// ===========================================
// churn_undo_war_value_toggle
// ===========================================
describe("churn_undo_war_value_toggle", () => {
	it("fires on A→B→A at a stable anchor with no verify between", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...editEvents("src/a.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(true);
	});

	it("fires with the high severity band and an exact reason", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...editEvents("src/a.ts", F1, F2),
		]);
		const hit = v.find((x) => x.ruleId === "churn_undo_war_value_toggle");
		expect(hit?.severity).toBe("high");
		expect(hit?.reason).toBe(
			"A region of src/a.ts is flapping between two values (A→B→A) with no test/build run " +
				"between the flips. This is an undo-war, not a bisection — pick one value and verify it, " +
				"or change the surrounding code so the choice is forced.",
		);
	});

	it("fires on a different file's toggle", () => {
		const v = run([
			...editEvents("src/z.ts", F1, F2),
			...editEvents("src/z.ts", F2, F1),
			...editEvents("src/z.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(true);
	});

	it("does NOT fire when a test ran between the toggles (bisection)", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...bashEvents("npm test", { outcome: "fail" }),
			...editEvents("src/a.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(false);
	});

	it("does NOT fire on a single flip A→B (no return)", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(false);
	});

	it("does NOT fire on three distinct values A→B→C", () => {
		const v = run([
			...editEvents("src/a.ts", F1, F2),
			...editEvents("src/a.ts", F2, F1),
			...editEvents("src/a.ts", F1, F3),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(false);
	});
});

// ===========================================
// churn_edits_without_green
// ===========================================
describe("churn_edits_without_green", () => {
	function nFailingEdits(file: string, n: number): ToolEvent[] {
		const evs: ToolEvent[] = [];
		for (let i = 0; i < n; i++) evs.push(...editEvents(file, `v${i}`, `v${i + 1}`, { fail: true }));
		return evs;
	}

	it("fires at exactly 5 failing edits on a source file, with an exact reason and medium severity", () => {
		const v = run(nFailingEdits("src/a.ts", 5));
		const hit = v.find((x) => x.ruleId === "churn_edits_without_green");
		expect(hit?.severity).toBe("medium");
		expect(hit?.reason).toBe(
			"src/a.ts has had 5 consecutive edits without reaching a clean state (no edit " +
				"passed its checks). Repeated edits that never go green are a sign of guessing — " +
				"read the failing output carefully and form a hypothesis before the next edit.",
		);
	});

	it("fires at the 8-edit escalation, still at medium severity (not yet 12)", () => {
		const v = run(nFailingEdits("src/a.ts", 8));
		const hits = v.filter((x) => x.ruleId === "churn_edits_without_green");
		expect(hits.length).toBeGreaterThanOrEqual(2);
		expect(hits.every((h) => h.severity === "medium")).toBe(true);
	});

	it("fires with high severity at 12", () => {
		const v = run(nFailingEdits("src/a.ts", 12));
		const hits = v.filter((x) => x.ruleId === "churn_edits_without_green");
		expect(hits.some((h) => h.severity === "high")).toBe(true);
	});

	it("does NOT fire on a non-source (doc) file", () => {
		const v = run(nFailingEdits("docs/notes.md", 6));
		expect(firedIds(v).has("churn_edits_without_green")).toBe(false);
	});

	it("does NOT fire below the threshold (4 edits)", () => {
		const v = run(nFailingEdits("src/a.ts", 4));
		expect(firedIds(v).has("churn_edits_without_green")).toBe(false);
	});

	it("does NOT fire when a clean edit resets the counter", () => {
		const v = run([
			...nFailingEdits("src/a.ts", 4),
			...editEvents("src/a.ts", "clean-old", "clean-new"), // clean → reset
			...nFailingEdits("src/a.ts", 4),
		]);
		expect(firedIds(v).has("churn_edits_without_green")).toBe(false);
	});
});

// ===========================================
// churn_repeated_failing_bash
// ===========================================
describe("churn_repeated_failing_bash", () => {
	it("fires on the third identical failing command, with an exact reason and medium severity", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		const hit = v.find((x) => x.ruleId === "churn_repeated_failing_bash");
		expect(hit?.severity).toBe("medium");
		expect(hit?.reason).toBe(
			"The same Bash command has now failed 3 times this session with no " +
				"successful edit between the runs. Re-running an unchanged command yields the same " +
				"failure — change an input or fix the underlying cause before re-issuing it.",
		);
	});

	it("keeps firing on the fourth failing run", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		expect(v.filter((x) => x.ruleId === "churn_repeated_failing_bash").length).toBeGreaterThanOrEqual(2);
	});

	it("fires across number-normalized variants (port drift)", () => {
		const v = run([
			...bashEvents("node server.js 3000", { outcome: "fail" }),
			...bashEvents("node server.js 3001", { outcome: "fail" }),
			...bashEvents("node server.js 3002", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(true);
	});

	it("does NOT fire after only two failures", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});

	it("does NOT fire when an edit intervenes (reset)", () => {
		const v = run([
			...bashEvents("make widget", { outcome: "fail" }),
			...bashEvents("make widget", { outcome: "fail" }),
			...editEvents("src/a.ts", "x", "y"),
			...bashEvents("make widget", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});

	it("does NOT fire on flaky/network verbs (curl)", () => {
		const v = run([
			...bashEvents("curl https://api.example.com/health", { outcome: "fail" }),
			...bashEvents("curl https://api.example.com/health", { outcome: "fail" }),
			...bashEvents("curl https://api.example.com/health", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});
});

// ===========================================
// churn_rerun_failing_test_no_source_change
// ===========================================
describe("churn_rerun_failing_test_no_source_change", () => {
	it("fires on a third failing test run with no source change, with an exact reason and medium severity", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		const hit = v.find((x) => x.ruleId === "churn_rerun_failing_test_no_source_change");
		expect(hit?.severity).toBe("medium");
		expect(hit?.reason).toBe(
			"The test suite has been re-run 3 times while still failing, " +
				"with no successful source edit between the runs. The result is deterministic — edit the " +
				"code (or the test) before running it again.",
		);
	});

	it("fires for a build-family rerun", () => {
		const v = run([
			...bashEvents("npm run build", { outcome: "fail" }),
			...bashEvents("npm run build", { outcome: "fail" }),
			...bashEvents("npm run build", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(true);
	});

	it("fires for a direct vitest rerun", () => {
		const v = run([
			...bashEvents("vitest run", { outcome: "fail" }),
			...bashEvents("vitest run", { outcome: "fail" }),
			...bashEvents("vitest run", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(true);
	});

	it("does NOT fire when a source edit lands between runs", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...editEvents("src/a.ts", "x", "y"),
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(false);
	});

	it("does NOT fire on a single confirmation re-run (twice)", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(false);
	});

	it("does NOT fire when an install disruptor resets the family", () => {
		const v = run([
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm install left-pad", { outcome: "success" }),
			...bashEvents("npm test", { outcome: "fail" }),
			...bashEvents("npm test", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_rerun_failing_test_no_source_change")).toBe(false);
	});
});

// ===========================================
// churn_revert_after_check_fail_combo
// ===========================================
describe("churn_revert_after_check_fail_combo", () => {
	function combo(opts: { e1Fail?: boolean; revertClean?: boolean; reapplyNew?: string } = {}): ToolEvent[] {
		const e1Fail = opts.e1Fail ?? true;
		const revertClean = opts.revertClean ?? false;
		const reNew = opts.reapplyNew ?? "b";
		return [
			...editEvents("src/a.ts", "a", "b", { fail: e1Fail }), // E1 (fails)
			...editEvents("src/a.ts", "b", "a", { fail: !revertClean }), // revert
			...editEvents("src/a.ts", "a", reNew, { fail: true }), // E3 re-apply
		];
	}

	it("fires on fail → literal revert → byte-identical re-apply with no green between, with an exact reason", () => {
		const v = run(combo());
		const hit = v.find((x) => x.ruleId === "churn_revert_after_check_fail_combo");
		expect(hit?.action).toBe("nudge");
		expect(hit?.severity).toBe("high");
		expect(hit?.reason).toBe(
			"src/a.ts just re-applied, byte-for-byte, an edit that already failed a check earlier " +
				"this session (with a revert in between and no passing check since). Re-applying a " +
				"known-failing change without addressing why it failed will fail the same way — fix the " +
				"root cause instead of toggling.",
		);
	});

	it("fires when an unrelated-region edit sits inside the window", () => {
		const v = run([
			...editEvents("src/a.ts", "a", "b", { fail: true }),
			...editEvents("src/a.ts", "b", "a", { fail: true }),
			...editEvents("src/a.ts", "zzz", "yyy", { fail: true }),
			...editEvents("src/a.ts", "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(true);
	});

	it("fires in a different file", () => {
		const v = run([
			...editEvents("src/q.ts", "a", "b", { fail: true }),
			...editEvents("src/q.ts", "b", "a", { fail: true }),
			...editEvents("src/q.ts", "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(true);
	});

	it("does NOT fire when a green (clean check) happens between (revert went green)", () => {
		expect(firedIds(run(combo({ revertClean: true }))).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when an install/git disruptor intervenes", () => {
		const v = run([
			...editEvents("src/a.ts", "a", "b", { fail: true }),
			...editEvents("src/a.ts", "b", "a", { fail: true }),
			...bashEvents("git checkout -- src/a.ts"),
			...editEvents("src/a.ts", "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when E1 never failed a check", () => {
		expect(firedIds(run(combo({ e1Fail: false }))).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when the re-apply is not byte-identical", () => {
		expect(
			firedIds(run(combo({ reapplyNew: "different" }))).has("churn_revert_after_check_fail_combo"),
		).toBe(false);
	});
});

// ===========================================
// Additional branch coverage — missing file_path guards + crafted-state paths
// ===========================================
describe("additional branch coverage", () => {
	it("churn_sha_cycle_revisit: returns null when the event has no file_path", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { old_string: "a", new_string: "b" });
		expect(churnShaCycleRevisit(state, ev)).toBeNull();
	});

	it("churn_sha_cycle_revisit: falls back to an empty edit log via a crafted state (fileEditLog has no entry for the file)", () => {
		const state = createState("s");
		state.fileShaHistory.set("src/craft.ts", [
			{ sha: "A", normSha: "a", atStep: 1 },
			{ sha: "B", normSha: "b", atStep: 2 },
			{ sha: "A", normSha: "a", atStep: 3 },
		]);
		state.stepCount = 3;
		// fileEditLog deliberately left empty for this file — hits the `?? []` fallback.
		const ev = postEditEvent("Edit", { file_path: "src/craft.ts", old_string: "x", new_string: "A" });
		const v = churnShaCycleRevisit(state, ev);
		// priorIdxs has 1 match (not >=2) and no fileEditLog entries so no failing check
		// intervened either — the FP guard suppresses firing, but the fallback line executed.
		expect(v).toBeNull();
	});

	it("churn_literal_edit_revert: returns null when the event has no file_path", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { old_string: "a", new_string: "b" });
		expect(churnLiteralEditRevert(state, ev)).toBeNull();
	});

	it("churn_undo_war_value_toggle: returns null when the event has no file_path", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { old_string: "a", new_string: "b" });
		expect(churnUndoWarValueToggle(state, ev)).toBeNull();
	});

	it("churn_undo_war_value_toggle: does not fire when the freshest anchor entry equals its own predecessor", () => {
		// Three consecutive no-op-content edits at the same anchor: a2 === b === a,
		// so `a.valueHash === b.valueHash` short-circuits before the toggle check.
		const v = run([
			...editEvents("src/same.ts", F1, F2),
			...editEvents("src/same.ts", F2, F2),
			...editEvents("src/same.ts", F2, F2),
		]);
		expect(firedIds(v).has("churn_undo_war_value_toggle")).toBe(false);
	});

	it("churn_undo_war_value_toggle: does not fire on a stale toggle left by a non-latest anchor", () => {
		const state = createState("s");
		const file = "src/stale.ts";
		const events = [
			...editEvents(file, F1, F2),
			...editEvents(file, F2, F1),
			...editEvents(file, F1, F2), // completes the A,B,A toggle at this anchor, at step 3
		];
		for (const ev of events) applyEvent(state, ev);
		// A later edit at a DIFFERENT anchor becomes the freshest step, leaving the
		// F-anchor's toggle stale (its `a.atStep` no longer equals state.stepCount).
		const freshest = editEvents(file, "let x = 1", "let x = 2")[1]!;
		applyEvent(state, freshest);
		expect(churnUndoWarValueToggle(state, freshest)).toBeNull();
	});

	it("churn_edits_without_green: falls back to 0 via a fresh, unfolded state", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { file_path: "src/fresh.ts", old_string: "a", new_string: "b" });
		expect(churnEditsWithoutGreen(state, ev)).toBeNull();
	});

	it("churn_rerun_failing_test_no_source_change: returns null when the Bash event has no command", () => {
		const state = createState("s");
		const ev: ToolEvent = {
			ts: "t",
			session: "s",
			agent: "a",
			tool: "Bash",
			toolUseId: nextId(),
			hook: "PostToolUse",
			input: {},
			toolOutcome: "fail",
		};
		expect(churnRerunFailingTestNoSourceChange(state, ev)).toBeNull();
	});

	it("churn_revert_after_check_fail_combo: returns null when the event has no file_path", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { old_string: "a", new_string: "b" });
		expect(churnRevertAfterCheckFailCombo(state, ev)).toBeNull();
	});

	it("churn_revert_after_check_fail_combo: returns null when the latest (E3) edit is a no-op", () => {
		const v = run([
			...editEvents("src/noop3.ts", "a", "b", { fail: true }),
			...editEvents("src/noop3.ts", "b", "a", { fail: true }),
			...editEvents("src/noop3.ts", "same", "same", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});
});

// ===========================================
// isPostEdit — shared post-edit gate (exercised through the rules that call it)
// ===========================================
describe("isPostEdit gate", () => {
	it("a PreToolUse clone of a matching event never satisfies the post-edit gate (churn_sha_cycle_revisit)", () => {
		const events = [
			...editEvents("src/pre-sha.ts", "", "A"),
			...editEvents("src/pre-sha.ts", "A", "B", { fail: true }),
			...editEvents("src/pre-sha.ts", "B", "A"),
		];
		const state = runState(events);
		const preEvent: ToolEvent = { ...lastEvent(events), hook: "PreToolUse" };
		expect(churnShaCycleRevisit(state, preEvent)).toBeNull();
	});

	it("a Bash tool event never satisfies the post-edit gate, even with hook=PostToolUse and matching state", () => {
		const events = [
			...editEvents("src/g.ts", "foo", "bar"),
			...editEvents("src/g.ts", "bar", "foo"),
		];
		const state = runState(events);
		const fakeEvent: ToolEvent = {
			ts: "t",
			session: "s",
			agent: "a",
			tool: "Bash",
			toolUseId: nextId(),
			hook: "PostToolUse",
			input: { file_path: "src/g.ts", old_string: "bar", new_string: "foo" },
			toolOutcome: "success",
		};
		expect(churnLiteralEditRevert(state, fakeEvent)).toBeNull();
	});

	it("fires for a Write-tool edit just like an Edit-tool edit", () => {
		const v = run([
			...editEvents("src/w.ts", "foo", "bar", { tool: "Write" }),
			...editEvents("src/w.ts", "bar", "foo", { tool: "Write" }),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});

	it("fires for a MultiEdit-tool edit just like an Edit-tool edit", () => {
		const v = run([
			...editEvents("src/m.ts", "foo", "bar", { tool: "MultiEdit" }),
			...editEvents("src/m.ts", "bar", "foo", { tool: "MultiEdit" }),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});
});

// ===========================================
// Module-level FLAKY_HEADS + isFlakyCommand (churn_repeated_failing_bash FP guard)
// ===========================================
describe("isFlakyCommand — FLAKY_HEADS verb coverage", () => {
	const FLAKY_VERBS = [
		"wget", "ping", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "dig", "nslookup", "host",
	];
	it.each(FLAKY_VERBS)("does NOT fire churn_repeated_failing_bash for repeated failing '%s' commands", (verb) => {
		const v = run([
			...bashEvents(`${verb} example.com`, { outcome: "fail" }),
			...bashEvents(`${verb} example.com`, { outcome: "fail" }),
			...bashEvents(`${verb} example.com`, { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});

	it("treats a pipeline as flaky when only SOME of its heads are flaky (.some, not .every)", () => {
		const v = run([
			...bashEvents("echo start && curl http://example.com/health", { outcome: "fail" }),
			...bashEvents("echo start && curl http://example.com/health", { outcome: "fail" }),
			...bashEvents("echo start && curl http://example.com/health", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});

	it("matches 'git fetch' with a single space (the +git regex, not a non-whitespace requirement)", () => {
		const v = run([
			...bashEvents("git fetch", { outcome: "fail" }),
			...bashEvents("git fetch", { outcome: "fail" }),
			...bashEvents("git fetch", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});

	it("matches 'git  fetch' across multiple spaces (the + quantifier, not a single \\s)", () => {
		const v = run([
			...bashEvents("git  fetch", { outcome: "fail" }),
			...bashEvents("git  fetch", { outcome: "fail" }),
			...bashEvents("git  fetch", { outcome: "fail" }),
		]);
		expect(firedIds(v).has("churn_repeated_failing_bash")).toBe(false);
	});
});

// ===========================================
// churn_sha_cycle_revisit — guard clauses and loop boundaries
// ===========================================
describe("churn_sha_cycle_revisit — mutation hardening", () => {
	it("does NOT fire when contentSha256 is absent, even with matching history", () => {
		const events = [
			...editEvents("src/nosha.ts", "", "A"),
			...editEvents("src/nosha.ts", "A", "B", { fail: true }),
			...editEvents("src/nosha.ts", "B", "A"),
		];
		const state = runState(events);
		const evNoSha: ToolEvent = { ...lastEvent(events) };
		delete evNoSha.contentSha256;
		expect(churnShaCycleRevisit(state, evNoSha)).toBeNull();
	});

	it("does NOT throw when there is no prior sha history for the file (hist undefined)", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { file_path: "src/brandnew.ts", old_string: "", new_string: "hello" });
		expect(churnShaCycleRevisit(state, ev)).toBeNull();
	});

	it("does NOT fire on a distinct sequence even with a failing edit inside it (no actual cycle)", () => {
		const v = run([
			...editEvents("src/nocycle2.ts", "", "A"),
			...editEvents("src/nocycle2.ts", "A", "B", { fail: true }),
			...editEvents("src/nocycle2.ts", "B", "C"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});
});

// ===========================================
// churn_sha_cycle_revisit — firstPrior must anchor at the ACTUAL first match
// ===========================================
describe("churn_sha_cycle_revisit — firstPrior anchoring", () => {
	it("does NOT fire when a failing edit occurred BEFORE the real revisit pair began (firstPrior must be the actual first sha match, not index 0)", () => {
		// If firstPrior were ever miscomputed as 0 (or the sincePrior step
		// derived from it), the failingIntervened scan would widen to include
		// src/fp.ts's step-2 failing edit — which sits BEFORE the real A-revisit
		// pair (idx2="A" .. idx4="A") — and wrongly fire.
		const v = run([
			...editEvents("src/fp.ts", "", "Z"), // idx0
			...editEvents("src/fp.ts", "Z", "Y", { fail: true }), // idx1 — failing, but before the real pair
			...editEvents("src/fp.ts", "Y", "A"), // idx2 — the REAL firstPrior
			...editEvents("src/fp.ts", "A", "B"), // idx3
			...editEvents("src/fp.ts", "B", "A"), // idx4 = cur, revisits idx2's "A"
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});

	it("does NOT fire when every revisited entry is byte-identical (pure identical-content churn stays whitespace-only even with 2 distinct revisits)", () => {
		// allWhitespace must be seeded true and must gate BEFORE the
		// twoDistinctRevisits check — three byte-identical edits give
		// priorIdxs.length===2 (twoDistinctRevisits=true) but every entry in
		// the revisit span shares cur's normSha, so this must still be null.
		const v = run([
			...editEvents("src/idem.ts", "", "X"),
			...editEvents("src/idem.ts", "X", "X"),
			...editEvents("src/idem.ts", "X", "X"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});

	it("does NOT fire when the ENTIRE forward span from firstPrior to now is whitespace-only, even with a failing edit inside that span (the scan must walk FORWARD from firstPrior, not backward)", () => {
		const v = run([
			...editEvents("src/fwd.ts", "", "Z"),
			...editEvents("src/fwd.ts", "Z", "A"),
			...editEvents("src/fwd.ts", "A", "A ", { fail: true }),
			...editEvents("src/fwd.ts", "A ", "A"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});
});

// ===========================================
// churn_sha_cycle_revisit — allWhitespace must default true and gate the
// twoDistinctRevisits/failingIntervened path, and the intervened-window
// bounds must be exact (strict, not inclusive)
// ===========================================
describe("churn_sha_cycle_revisit — allWhitespace default and window exactness", () => {
	it("does NOT fire on a whitespace-only cycle even with TWO distinct revisits (allWhitespace must default true and gate before twoDistinctRevisits, not just single-revisit cases)", () => {
		// Every entry shares normSha with cur (only trailing-space count differs),
		// so priorIdxs has 2 exact-sha matches (twoDistinctRevisits=true) yet the
		// whole span is whitespace-only. If allWhitespace ever defaulted false, or
		// its guard were bypassed, this would incorrectly fire.
		const v = run([
			...editEvents("src/ws2.ts", "", "x=1"),
			...editEvents("src/ws2.ts", "x=1", "x=1 "),
			...editEvents("src/ws2.ts", "x=1 ", "x=1"),
			...editEvents("src/ws2.ts", "x=1", "x=1  "),
			...editEvents("src/ws2.ts", "x=1  ", "x=1"),
		]);
		expect(firedIds(v).has("churn_sha_cycle_revisit")).toBe(false);
	});

	it("a failing edit exactly AT sincePrior does not count as intervened (the window's lower bound is strict '>', not '>=')", () => {
		const state = createState("s");
		const file = "src/windowlo.ts";
		state.fileShaHistory.set(file, [
			{ sha: "A", normSha: "a", atStep: 2 }, // firstPrior; sincePrior = 2
			{ sha: "B", normSha: "b", atStep: 4 },
			{ sha: "A", normSha: "a", atStep: 6 }, // cur
		]);
		state.fileEditLog.set(file, [
			{ old: "x", new: "B", anchor: "z", atStep: 2, failedCheck: true, greenCountAtEntry: 0 },
		]);
		const ev = postEditEvent("Edit", { file_path: file, old_string: "B", new_string: "A" });
		expect(churnShaCycleRevisit(state, ev)).toBeNull();
	});

	it("a failing edit exactly AT cur.atStep does not count as intervened (the window's upper bound is strict '<', not '<=')", () => {
		const state = createState("s");
		const file = "src/windowhi.ts";
		state.fileShaHistory.set(file, [
			{ sha: "A", normSha: "a", atStep: 2 },
			{ sha: "B", normSha: "b", atStep: 4 },
			{ sha: "A", normSha: "a", atStep: 6 }, // cur; sincePrior = 2
		]);
		state.fileEditLog.set(file, [
			{ old: "x", new: "B", anchor: "z", atStep: 6, failedCheck: true, greenCountAtEntry: 0 },
		]);
		const ev = postEditEvent("Edit", { file_path: file, old_string: "B", new_string: "A" });
		expect(churnShaCycleRevisit(state, ev)).toBeNull();
	});

});

// ===========================================
// churn_literal_edit_revert — guard clauses and asymmetric matches
// ===========================================
describe("churn_literal_edit_revert — mutation hardening", () => {
	it("does NOT throw when the file has no edit log yet (log undefined)", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { file_path: "src/brandnewlit.ts", old_string: "a", new_string: "b" });
		expect(churnLiteralEditRevert(state, ev)).toBeNull();
	});

	it("does NOT block a deletion-then-insertion revert (asymmetric empty-string guard)", () => {
		const v = run([
			...editEvents("src/emptyrevert.ts", "", "X"),
			...editEvents("src/emptyrevert.ts", "X", ""),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(true);
	});

	it("does NOT fire when only the new-half of the revert-match coincides (old-half differs)", () => {
		const v = run([
			...editEvents("src/halfrevert.ts", "X", "Y"),
			...editEvents("src/halfrevert.ts", "Z", "X"),
		]);
		expect(firedIds(v).has("churn_literal_edit_revert")).toBe(false);
	});
});

// ===========================================
// churn_undo_war_value_toggle — guard clauses + defensive holes
// ===========================================
describe("churn_undo_war_value_toggle — mutation hardening", () => {
	it("does NOT fire on a PreToolUse clone of the event, even with a matching toggle", () => {
		const events = [
			...editEvents("src/pretoggle.ts", F1, F2),
			...editEvents("src/pretoggle.ts", F2, F1),
			...editEvents("src/pretoggle.ts", F1, F2),
		];
		const state = runState(events);
		const preEvent: ToolEvent = { ...lastEvent(events), hook: "PreToolUse" };
		expect(churnUndoWarValueToggle(state, preEvent)).toBeNull();
	});

	it("does NOT fire when file_path is missing, even though a file literally named 'undefined' has a matching toggle", () => {
		const events = [
			...editEvents("undefined", F1, F2),
			...editEvents("undefined", F2, F1),
			...editEvents("undefined", F1, F2),
		];
		const state = runState(events);
		const ev = postEditEvent("Edit", { old_string: F1, new_string: F2 });
		expect(churnUndoWarValueToggle(state, ev)).toBeNull();
	});

	it("does NOT fire when a different file's key merely shares the prefix (anchor key must include the separator)", () => {
		const events = [
			...editEvents("src/a.tsx", F1, F2),
			...editEvents("src/a.tsx", F2, F1),
			...editEvents("src/a.tsx", F1, F2),
		];
		const state = runState(events);
		// "src/a.ts" is a PREFIX of "src/a.tsx" — must not match its anchor keys.
		const ev = postEditEvent("Edit", { file_path: "src/a.ts", old_string: F1, new_string: F2 });
		expect(churnUndoWarValueToggle(state, ev)).toBeNull();
	});

});

// ===========================================
// churn_edits_without_green — isPostEdit gate
// ===========================================
describe("churn_edits_without_green — mutation hardening", () => {
	it("does NOT fire on a PreToolUse clone of the event, even with a matching edits-without-green count", () => {
		const events = [
			...editEvents("src/pregreen.ts", "v0", "v1", { fail: true }),
			...editEvents("src/pregreen.ts", "v1", "v2", { fail: true }),
			...editEvents("src/pregreen.ts", "v2", "v3", { fail: true }),
			...editEvents("src/pregreen.ts", "v3", "v4", { fail: true }),
			...editEvents("src/pregreen.ts", "v4", "v5", { fail: true }),
		];
		const state = runState(events);
		const preEvent: ToolEvent = { ...lastEvent(events), hook: "PreToolUse" };
		expect(churnEditsWithoutGreen(state, preEvent)).toBeNull();
	});
});

// ===========================================
// churn_repeated_failing_bash — guard clauses (direct-call, crafted state)
// ===========================================
describe("churn_repeated_failing_bash — mutation hardening", () => {
	it("does NOT fire when the guard-bypassing event is not PostToolUse", () => {
		const state = makeBashState("make widget", 5);
		const ev: ToolEvent = {
			ts: "t", session: "s", agent: "a", tool: "Bash", toolUseId: nextId(),
			hook: "PreToolUse", input: { command: "make widget" }, toolOutcome: "fail",
		};
		expect(churnRepeatedFailingBash(state, ev)).toBeNull();
	});

	it("does NOT fire when the tool is not Bash", () => {
		const state = makeBashState("make widget", 5);
		const ev: ToolEvent = {
			ts: "t", session: "s", agent: "a", tool: "Edit", toolUseId: nextId(),
			hook: "PostToolUse", input: { command: "make widget" }, toolOutcome: "fail",
		};
		expect(churnRepeatedFailingBash(state, ev)).toBeNull();
	});

	it("does NOT fire when the triggering event itself did not fail", () => {
		const state = makeBashState("make widget", 5);
		const ev: ToolEvent = {
			ts: "t", session: "s", agent: "a", tool: "Bash", toolUseId: nextId(),
			hook: "PostToolUse", input: { command: "make widget" }, toolOutcome: "success",
		};
		expect(churnRepeatedFailingBash(state, ev)).toBeNull();
	});
});

// ===========================================
// churn_rerun_failing_test_no_source_change — guard clauses (direct-call)
// ===========================================
describe("churn_rerun_failing_test_no_source_change — mutation hardening", () => {
	it("does NOT fire when the guard-bypassing event is not PostToolUse", () => {
		const state = makeFamilyState("test", 5);
		const ev: ToolEvent = {
			ts: "t", session: "s", agent: "a", tool: "Bash", toolUseId: nextId(),
			hook: "PreToolUse", input: { command: "npm test" }, toolOutcome: "fail",
		};
		expect(churnRerunFailingTestNoSourceChange(state, ev)).toBeNull();
	});

	it("does NOT fire when the tool is not Bash", () => {
		const state = makeFamilyState("test", 5);
		const ev: ToolEvent = {
			ts: "t", session: "s", agent: "a", tool: "Edit", toolUseId: nextId(),
			hook: "PostToolUse", input: { command: "npm test" }, toolOutcome: "fail",
		};
		expect(churnRerunFailingTestNoSourceChange(state, ev)).toBeNull();
	});

	it("does NOT fire when the triggering event itself did not fail", () => {
		const state = makeFamilyState("test", 5);
		const ev: ToolEvent = {
			ts: "t", session: "s", agent: "a", tool: "Bash", toolUseId: nextId(),
			hook: "PostToolUse", input: { command: "npm test" }, toolOutcome: "success",
		};
		expect(churnRerunFailingTestNoSourceChange(state, ev)).toBeNull();
	});

	it("does NOT fire for a non test/build family even with a matching rerun counter", () => {
		const state = makeFamilyState("lint", 5);
		const ev: ToolEvent = {
			ts: "t", session: "s", agent: "a", tool: "Bash", toolUseId: nextId(),
			hook: "PostToolUse", input: { command: "eslint ." }, toolOutcome: "fail",
		};
		expect(churnRerunFailingTestNoSourceChange(state, ev)).toBeNull();
	});
});

// ===========================================
// churn_revert_after_check_fail_combo — guard clauses, holes, window bound,
// AND-chain isolation, boundary-exact disruptor checks
// ===========================================
describe("churn_revert_after_check_fail_combo — mutation hardening", () => {
	function combo(opts: { e1Fail?: boolean; revertClean?: boolean; reapplyNew?: string } = {}): ToolEvent[] {
		const e1Fail = opts.e1Fail ?? true;
		const revertClean = opts.revertClean ?? false;
		const reNew = opts.reapplyNew ?? "b";
		return [
			...editEvents("src/a.ts", "a", "b", { fail: e1Fail }),
			...editEvents("src/a.ts", "b", "a", { fail: !revertClean }),
			...editEvents("src/a.ts", "a", reNew, { fail: true }),
		];
	}

	it("does NOT fire on a PreToolUse clone of the event, even though the combo state matches", () => {
		const events = combo();
		const state = runState(events);
		const preEvent: ToolEvent = { ...lastEvent(events), hook: "PreToolUse" };
		expect(churnRevertAfterCheckFailCombo(state, preEvent)).toBeNull();
	});

	it("does NOT throw when the file has no edit log yet (log undefined)", () => {
		const state = createState("s");
		const ev = postEditEvent("Edit", { file_path: "src/brandnewcombo.ts", old_string: "a", new_string: "b" });
		expect(churnRevertAfterCheckFailCombo(state, ev)).toBeNull();
	});

	it("does NOT fire when E3 is a no-op, even when an identical earlier failing pair would otherwise match", () => {
		const v = run([
			...editEvents("src/noopmatch.ts", "z", "z", { fail: true }),
			...editEvents("src/noopmatch.ts", "z", "z", { fail: true }),
			...editEvents("src/noopmatch.ts", "z", "z", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("Math.max window bound: does NOT find a matching E1 that sits outside the 6-edit lookback window", () => {
		const file = "src/window.ts";
		const v = run([
			...editEvents(file, "p", "q", { fail: true }),
			...editEvents(file, "q", "p", { fail: true }),
			...editEvents(file, "f0", "f1", { fail: true }),
			...editEvents(file, "f1", "f2", { fail: true }),
			...editEvents(file, "f2", "f3", { fail: true }),
			...editEvents(file, "f3", "f4", { fail: true }),
			...editEvents(file, "f4", "f5", { fail: true }),
			...editEvents(file, "f5", "f6", { fail: true }),
			...editEvents(file, "p", "q", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when the matching earlier edit never failed a check (even though the tool call itself failed)", () => {
		const file = "src/e1nofail.ts";
		const v = run([
			...editEvents(file, "a", "b", { outcome: "fail", fail: false }),
			...editEvents(file, "b", "a", { fail: true }),
			...editEvents(file, "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when only the old-half of the byte-identical match holds (new-half differs)", () => {
		const file = "src/halfmatch.ts";
		const v = run([
			...editEvents(file, "different-old", "b", { fail: true }),
			...editEvents(file, "b", "different-old", { fail: true }),
			...editEvents(file, "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("does NOT fire when the byte-identical match has no literal revert in between (unrelated edit only)", () => {
		const file = "src/norevert.ts";
		const v = run([
			...editEvents(file, "x", "y", { fail: true }),
			...editEvents(file, "m", "n", { fail: true }),
			...editEvents(file, "x", "y", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("inner loop start bound: does not treat a same-shaped pair BEFORE E1 as the required revert-between", () => {
		const file = "src/loopdir.ts";
		const v = run([
			...editEvents(file, "start", "mid", { fail: true }),
			...editEvents(file, "y", "x", { fail: true }),
			...editEvents(file, "x", "y", { fail: true }),
			...editEvents(file, "m", "n", { fail: true }),
			...editEvents(file, "x", "y", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("revertBetween requires ALL three AND-chain conditions — a new-only partial match does not count", () => {
		const file = "src/partial1.ts";
		const v = run([
			...editEvents(file, "a", "b", { fail: true }),
			...editEvents(file, "different", "a", { fail: true }),
			...editEvents(file, "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("revertBetween requires ALL three AND-chain conditions — an old-only partial match does not count", () => {
		const file = "src/partial2.ts";
		const v = run([
			...editEvents(file, "a", "b", { fail: true }),
			...editEvents(file, "b", "different", { fail: true }),
			...editEvents(file, "a", "b", { fail: true }),
		]);
		expect(firedIds(v).has("churn_revert_after_check_fail_combo")).toBe(false);
	});

	it("lastDisruptStep boundary: a disruptor exactly AT e1's step does not suppress (must be strictly after)", () => {
		const state = createState("s");
		const file = "src/disruptbound1.ts";
		state.fileEditLog.set(file, [
			{ old: "a", new: "b", anchor: "x", atStep: 2, failedCheck: true, greenCountAtEntry: 0 },
			{ old: "b", new: "a", anchor: "x", atStep: 4, failedCheck: true, greenCountAtEntry: 0 },
			{ old: "a", new: "b", anchor: "x", atStep: 8, failedCheck: true, greenCountAtEntry: 0 },
		]);
		state.lastDisruptStep = 2;
		state.stepCount = 8;
		const ev = postEditEvent("Edit", { file_path: file, old_string: "a", new_string: "b" });
		expect(churnRevertAfterCheckFailCombo(state, ev)).not.toBeNull();
	});

	it("lastDisruptStep boundary: a disruptor exactly AT e3's step does not suppress (must be strictly before)", () => {
		const state = createState("s");
		const file = "src/disruptbound2.ts";
		state.fileEditLog.set(file, [
			{ old: "a", new: "b", anchor: "x", atStep: 2, failedCheck: true, greenCountAtEntry: 0 },
			{ old: "b", new: "a", anchor: "x", atStep: 4, failedCheck: true, greenCountAtEntry: 0 },
			{ old: "a", new: "b", anchor: "x", atStep: 8, failedCheck: true, greenCountAtEntry: 0 },
		]);
		state.lastDisruptStep = 8;
		state.stepCount = 8;
		const ev = postEditEvent("Edit", { file_path: file, old_string: "a", new_string: "b" });
		expect(churnRevertAfterCheckFailCombo(state, ev)).not.toBeNull();
	});
});

// ===========================================
// Wiring sanity
// ===========================================
describe("CHURN_RULES registry", () => {
	it("exports all seven churn rules", () => {
		expect(CHURN_RULES.length).toBe(7);
	});
	it("every rule is nudge action (no churn blocks)", () => {
		const sample = [
			churnShaCycleRevisit,
			churnLiteralEditRevert,
			churnUndoWarValueToggle,
			churnEditsWithoutGreen,
			churnRepeatedFailingBash,
			churnRerunFailingTestNoSourceChange,
			churnRevertAfterCheckFailCombo,
		];
		expect(sample.length).toBe(7);
		const v = run([
			...editEvents("src/a.ts", "foo", "bar"),
			...editEvents("src/a.ts", "bar", "foo"),
		]);
		expect(v.every((x) => x.action === "nudge")).toBe(true);
	});
});
