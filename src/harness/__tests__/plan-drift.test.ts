import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	DRIFT_PCT_THRESHOLD,
	detectPlanDrift,
	formatPlanDriftWarning,
	UNEXPECTED_ACTIONS_THRESHOLD,
} from "../plan-drift.js";
import type { CapturedPlan, PlanStep } from "../types/plan.js";
import type { SessionTrajectory } from "../types.js";

// ===========================================
// Helpers
// ===========================================

const FIXED_NOW = 1_700_000_000_000;
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();

function makeSession(
	overrides: Partial<SessionTrajectory> = {},
): SessionTrajectory {
	const base: SessionTrajectory = {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_SESSION_STARTED_AT,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
	};
	return { ...base, ...overrides };
}

function step(intent: string, extra: Partial<PlanStep> = {}): PlanStep {
	return { intent, status: "pending", ...extra };
}

function makePlan(steps: PlanStep[], extra: Partial<CapturedPlan> = {}): CapturedPlan {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		created_at_iso: FIXED_SESSION_STARTED_AT,
		created_at_step: 0,
		source: "TaskCreate",
		steps,
		...extra,
	};
}

// ===========================================
// detectPlanDrift
// ===========================================

describe("detectPlanDrift", () => {
	it("returns null when session has no declared_plan", () => {
		const session = makeSession({
			tool_sequence: ["Edit:src/foo.ts", "Bash:npm test"],
		});
		expect(detectPlanDrift(session)).toBeNull();
	});

	it("declared 3 steps, all executed → drift 0%, no missing", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit src/foo.ts"),
				step("Run npm test"),
				step("Edit README.md"),
			]),
			tool_sequence: [
				"Edit:src/foo.ts",
				"Bash:npm test",
				"Edit:README.md",
			],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.declared_count).toBe(3);
		expect(report!.matched_count).toBe(3);
		expect(report!.missing_steps).toHaveLength(0);
		expect(report!.drift_pct).toBe(0);
	});

	it("declared 3 steps, 2 executed → 1 missing, drift ≈ 0.33", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit src/foo.ts file"),
				step("Edit src/bar.ts file"),
				step("Run npm test"),
			]),
			tool_sequence: ["Edit:src/foo.ts", "Edit:src/bar.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.declared_count).toBe(3);
		expect(report!.matched_count).toBe(2);
		expect(report!.missing_steps).toHaveLength(1);
		expect(nonNull(report!.missing_steps[0]).intent).toContain("npm test");
		expect(report!.drift_pct).toBeCloseTo(1 / 3, 5);
	});

	it("declared 2 steps, 5 actions (3 unexpected non-Read) → 3 unexpected", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit src/foo.ts file"),
				step("Run npm test"),
			]),
			tool_sequence: [
				"Edit:src/foo.ts", // matches step 1
				"Bash:npm test", // matches step 2
				"Edit:src/secret.ts", // unexpected
				"Bash:git commit -am x", // unexpected
				"Write:src/new.ts", // unexpected
			],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(2);
		expect(report!.unexpected_actions).toHaveLength(3);
		expect(report!.unexpected_actions).toContain("Edit:src/secret.ts");
		expect(report!.unexpected_actions).toContain("Bash:git commit -am x");
		expect(report!.unexpected_actions).toContain("Write:src/new.ts");
	});

	it("declared plan with empty steps array → drift_pct 0, declared_count 0", () => {
		const session = makeSession({
			declared_plan: makePlan([]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.declared_count).toBe(0);
		expect(report!.drift_pct).toBe(0);
		expect(report!.missing_steps).toHaveLength(0);
	});

	it("tool_sequence contains only Read/Grep entries → none counted as unexpected", () => {
		const session = makeSession({
			declared_plan: makePlan([step("Edit src/foo.ts")]),
			tool_sequence: [
				"Read:src/a.ts",
				"Read:src/b.ts",
				"Grep:foo",
				"Glob:**/*.ts",
				"LS:src/",
				"NotebookRead:notebook.ipynb",
			],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.unexpected_actions).toHaveLength(0);
		// The single declared step has no match (no Edit entry in sequence).
		expect(report!.missing_steps).toHaveLength(1);
	});

	it("token matching: 'Edit src/foo.ts' step matches 'Edit:src/foo.ts' entry", () => {
		const session = makeSession({
			declared_plan: makePlan([step("Edit src/foo.ts")]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(1);
		expect(report!.missing_steps).toHaveLength(0);
	});

	it("each step claims at most one tool_sequence entry (greedy first-match)", () => {
		// Two declared steps that both could match "Edit:src/foo.ts" — only
		// the first step should consume it; the second step is missing.
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit foo file in src"),
				step("Edit foo file in src"),
			]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(1);
		expect(report!.missing_steps).toHaveLength(1);
	});

	it("respects step.tool_hint and target_hint when tokenizing", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("set up the new module", {
					tool_hint: "Edit",
					target_hint: "src/foo.ts",
				}),
			]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		// Without the hints, "set up the new module" would not tokenize
		// to overlap with "Edit:src/foo.ts". With the hints folded in,
		// the overlap is high enough.
		expect(report!.matched_count).toBe(1);
	});

	it("unexpected_actions list is capped at 10", () => {
		const sequence: string[] = [];
		for (let i = 0; i < 20; i++) {
			sequence.push(`Bash:cmd-${i}`);
		}
		// tool_sequence is bounded at 20 entries in session-state.ts, so a
		// 20-entry pool is the worst-case input shape.
		const session = makeSession({
			declared_plan: makePlan([step("totally unrelated step")]),
			tool_sequence: sequence,
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.unexpected_actions.length).toBeLessThanOrEqual(10);
	});
});

// ===========================================
// formatPlanDriftWarning — threshold behavior
// ===========================================

describe("formatPlanDriftWarning", () => {
	it("emits advisory when drift_pct > threshold (0.4 > 0.3)", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 5,
				matched_count: 3,
				missing_steps: [step("missing one"), step("missing two")],
				unexpected_actions: [],
				drift_pct: 0.4,
			},
		});
		expect(warning).not.toBeNull();
		expect(warning).toContain("[interlinked:plan-drift]");
		expect(warning).toContain("Declared 5");
		expect(warning).toContain("matched 3");
		expect(warning).toContain("missing one");
		expect(warning).toContain("missing two");
	});

	it("suppresses advisory when drift_pct=0.1 and 2 unexpected (both under threshold)", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 10,
				matched_count: 9,
				missing_steps: [step("only one missing")],
				unexpected_actions: ["Edit:src/a.ts", "Edit:src/b.ts"],
				drift_pct: 0.1,
			},
		});
		expect(warning).toBeNull();
	});

	it("emits advisory when 5 unexpected actions cross unexpected-threshold (>3)", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 2,
				matched_count: 2,
				missing_steps: [],
				unexpected_actions: [
					"Edit:src/a.ts",
					"Edit:src/b.ts",
					"Edit:src/c.ts",
					"Edit:src/d.ts",
					"Edit:src/e.ts",
				],
				drift_pct: 0,
			},
		});
		expect(warning).not.toBeNull();
		expect(warning).toContain("Edit:src/a.ts");
	});

	it("returns null when both thresholds are at-or-below their gates", () => {
		// drift_pct exactly equals threshold (uses strict >, so suppress)
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 10,
				matched_count: 7,
				missing_steps: [step("a"), step("b"), step("c")],
				unexpected_actions: ["Edit:x.ts", "Edit:y.ts", "Edit:z.ts"],
				drift_pct: DRIFT_PCT_THRESHOLD,
			},
			driftThreshold: DRIFT_PCT_THRESHOLD,
			unexpectedThreshold: UNEXPECTED_ACTIONS_THRESHOLD,
		});
		expect(warning).toBeNull();
	});

	it("truncates missing-steps list at 5 with an 'and N more' suffix", () => {
		const missing: PlanStep[] = [];
		for (let i = 0; i < 8; i++) {
			missing.push(step(`step number ${i}`));
		}
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 10,
				matched_count: 2,
				missing_steps: missing,
				unexpected_actions: [],
				drift_pct: 0.8,
			},
		});
		expect(warning).not.toBeNull();
		expect(warning).toContain("step number 0");
		expect(warning).toContain("step number 4");
		expect(warning).not.toContain("step number 5");
		expect(warning).toContain("and 3 more");
	});
});

// ===========================================
// tokenize / tokenizeStep — internal behavior,
// observed only through detectPlanDrift (both fns are unexported)
// ===========================================

describe("tokenize — STOP_WORDS filtering (mutation-kill)", () => {
	// test-contract: invariant — every entry in STOP_WORDS must be dropped
	// from both the step's and the entry's token set. A stand-alone stop
	// word, matched against the identical literal word as the only
	// tool_sequence entry, tokenizes to an EMPTY set on both sides when
	// filtering works (jaccard's own empty-set guard then forces 0, so
	// there is no match). If any single word stops being recognized as a
	// stop word — including via the whole STOP_WORDS array being emptied —
	// both sides instead tokenize to the singleton {word}, jaccard is a
	// perfect 1.0, and the step wrongly matches.
	const ALL_STOP_WORDS = ["the", "a", "an", "to", "and", "or", "for", "in", "on", "of", "with"];
	it.each(ALL_STOP_WORDS)('stand-alone stop word "%s" never matches itself', (word) => {
		const session = makeSession({
			declared_plan: makePlan([step(word)]),
			tool_sequence: [word],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(0);
		expect(report!.missing_steps).toHaveLength(1);
	});

	// test-contract: invariant — the filter step in tokenize() must run at
	// all (chain-drop / always-true / OR / length>=0 mutants all defeat it
	// the same way): tokens from a leading-punctuation word retain a
	// spurious "" element when the filter is defeated, and two otherwise
	// unrelated leading-punctuation words then share that "" token, pushing
	// jaccard from 0 to 1/3 (> the 0.3 threshold) and creating a false
	// match where the correct tokenizer finds none.
	it("leading-punctuation words do not spuriously match via a leaked empty token", () => {
		const session = makeSession({
			declared_plan: makePlan([step(":zzzznope")]),
			tool_sequence: [":zzzzyup"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(0);
		expect(report!.missing_steps).toHaveLength(1);
	});

	// test-contract: invariant — tokenize's final .split(...) must split ON
	// whitespace (/\s+/), not on non-whitespace runs (/\S+/). A single
	// alnum word with no internal whitespace ("widget") must tokenize to
	// {"widget"} — splitting on non-whitespace instead consumes the whole
	// word as the one delimiter and leaves an empty token set.
	it("a single-word step still tokenizes to a non-empty, matchable set", () => {
		const session = makeSession({
			declared_plan: makePlan([step("widget")]),
			tool_sequence: ["Bash:widget"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(1);
		expect(report!.missing_steps).toHaveLength(0);
	});
});

describe("tokenizeStep — tool_hint folding (mutation-kill)", () => {
	// test-contract: invariant — step.tool_hint must be folded in with `??`
	// (only undefined/null fall back to ""), not `&&` (which discards ANY
	// truthy tool_hint down to ""). Intent is a pure stop word so the only
	// possible source of a token is the hint; with `??` the step token set
	// is {"edit"} and matches the entry's {"edit","zzz"} at jaccard 0.5;
	// with `&&`, the truthy "Edit" collapses to "", the step token set is
	// empty, and jaccard's empty-set guard forces 0 — no match.
	it("a pure-stopword intent still matches via its tool_hint", () => {
		const session = makeSession({
			declared_plan: makePlan([step("the", { tool_hint: "Edit" })]),
			tool_sequence: ["Edit:zzz"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(1);
		expect(report!.missing_steps).toHaveLength(0);
	});
});

// ===========================================
// jaccard — internal behavior via detectPlanDrift
// ===========================================

describe("jaccard — internal behavior via detectPlanDrift (mutation-kill)", () => {
	// test-contract: invariant — the intersection loop must check ACTUAL
	// membership (`b.has(t)`), not something unconditionally true. Two
	// steps whose token sets share nothing must never match; forcing the
	// membership check to always succeed makes jaccard return 1.0 for any
	// non-empty pool entry regardless of real overlap.
	it("completely disjoint token sets never match, even with a non-empty pool", () => {
		const session = makeSession({
			declared_plan: makePlan([step("zalpha zbeta")]),
			tool_sequence: ["Zgamma:zdelta"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(0);
		expect(report!.missing_steps).toHaveLength(1);
	});

	// test-contract: invariant — the final jaccard computation must DIVIDE
	// intersection by union, not multiply. intersection=1, union=5 gives
	// 0.2 (below the 0.3 threshold, no match) under division; the same two
	// numbers under multiplication give 5 (trivially above threshold),
	// producing a false match.
	it("a single shared token against a much larger set stays below threshold", () => {
		const session = makeSession({
			declared_plan: makePlan([step("shared")]),
			tool_sequence: ["shared:w1/w2/w3/w4"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(0);
		expect(report!.missing_steps).toHaveLength(1);
	});
});

// ===========================================
// detectPlanDrift — additional mutation-kill cases
// ===========================================

describe("detectPlanDrift — additional mutation-kill cases", () => {
	// test-contract: invariant — the matchable pool must exclude
	// exploration-prefixed entries (Read:/Grep:/.../NotebookRead:). Without
	// that filter, a step that says "Edit src/foo.ts" would be falsely
	// satisfied by a mere "Read:src/foo.ts" in the tool_sequence.
	it("a Read: of the same target does not satisfy an Edit step", () => {
		const session = makeSession({
			declared_plan: makePlan([step("Edit src/foo.ts")]),
			tool_sequence: ["Read:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(0);
		expect(report!.missing_steps).toHaveLength(1);
	});

	// test-contract: boundary — the empty-declared-plan special case must
	// still cap unexpected_actions at UNEXPECTED_ACTIONS_CAP (10), the same
	// as the general path. 15 significant entries must be truncated to 10.
	it("empty-plan special case caps unexpected_actions at 10", () => {
		const sequence: string[] = [];
		for (let i = 0; i < 15; i++) sequence.push(`Bash:cmd-${i}`);
		const session = makeSession({
			declared_plan: makePlan([]),
			tool_sequence: sequence,
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.unexpected_actions).toHaveLength(10);
	});

	// test-contract: invariant — a step must only match a pool entry when
	// jaccard actually clears the threshold, not unconditionally on the
	// first pool entry. Two completely unrelated phrases (no shared words)
	// must never match.
	it("unrelated intent and entry never match regardless of a non-empty pool", () => {
		const session = makeSession({
			declared_plan: makePlan([step("completely unrelated intent")]),
			tool_sequence: ["Bash:totally-different-thing"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(0);
		expect(report!.missing_steps).toHaveLength(1);
	});

	// test-contract: boundary — the match test is strictly `>`
	// JACCARD_MATCH_THRESHOLD (0.3), not `>=`. A step/entry pair engineered
	// to land at exactly 0.3 (intersection 3, union 10 — 3 and 10 are both
	// exactly representable, and 3/10 === 0.3 in IEEE-754 double
	// arithmetic) must NOT match.
	it("a jaccard score of exactly 0.3 does not clear the strict threshold", () => {
		const session = makeSession({
			declared_plan: makePlan([step("alpha beta gamma")]),
			tool_sequence: ["alpha:beta/gamma-w1-w2-w3-w4-w5-w6-w7"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(0);
		expect(report!.missing_steps).toHaveLength(1);
	});
});

// ===========================================
// formatPlanDriftWarning — exact-string mutation-kill scenarios
// ===========================================

describe("formatPlanDriftWarning — exact-string mutation-kill scenarios", () => {
	// test-contract: boundary — when both missing_steps and unexpected_actions
	// are empty, every conditional block (missingBlock/unexpectedBlock/
	// missingMore/unexpectedMore) must take its "" branch. Pins the exact
	// string with nothing between the header line and the trailing
	// reflection text.
	it("empty missing/unexpected produces the bare header + reflection text", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 5,
				matched_count: 5,
				missing_steps: [],
				unexpected_actions: [],
				drift_pct: 0.9,
			},
		});
		expect(warning).toBe(
			"[interlinked:plan-drift] Declared 5 step(s), matched 5.\n" +
				"Reflect on whether the divergence was deliberate (you learned the plan was wrong) " +
				"or accidental (you forgot a step / wandered). Both are fine outcomes; what's not " +
				"fine is claiming done without naming the divergence.",
		);
	});

	// test-contract: invariant — missingPreview/unexpectedPreview must join
	// with "\n", and the "...and N more" suffix must stay empty while under
	// ADVISORY_LIST_CAP (5). Pins the exact 2-item rendering for both lists.
	it("2 missing + 2 unexpected renders both blocks with newline-joined items and no suffix", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 10,
				matched_count: 8,
				missing_steps: [step("m0"), step("m1")],
				unexpected_actions: ["u0", "u1"],
				drift_pct: 0.5,
			},
		});
		expect(warning).toBe(
			"[interlinked:plan-drift] Declared 10 step(s), matched 8.\n" +
				"Missing:\n  - m0\n  - m1\n" +
				"Unexpected:\n  - u0\n  - u1\n" +
				"Reflect on whether the divergence was deliberate (you learned the plan was wrong) " +
				"or accidental (you forgot a step / wandered). Both are fine outcomes; what's not " +
				"fine is claiming done without naming the divergence.",
		);
	});

	// test-contract: boundary — exactly ADVISORY_LIST_CAP (5) items must NOT
	// trigger the "...and N more" suffix (the check is strictly `>` the cap,
	// not `>=`).
	it("exactly 5 missing + 5 unexpected shows no '...and N more' suffix", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 5,
				matched_count: 0,
				missing_steps: [step("m0"), step("m1"), step("m2"), step("m3"), step("m4")],
				unexpected_actions: ["u0", "u1", "u2", "u3", "u4"],
				drift_pct: 0,
			},
		});
		expect(warning).toBe(
			"[interlinked:plan-drift] Declared 5 step(s), matched 0.\n" +
				"Missing:\n  - m0\n  - m1\n  - m2\n  - m3\n  - m4\n" +
				"Unexpected:\n  - u0\n  - u1\n  - u2\n  - u3\n  - u4\n" +
				"Reflect on whether the divergence was deliberate (you learned the plan was wrong) " +
				"or accidental (you forgot a step / wandered). Both are fine outcomes; what's not " +
				"fine is claiming done without naming the divergence.",
		);
	});

	// test-contract: boundary — 8 unexpected_actions (over the 5-item cap)
	// must both truncate the preview list to 5 AND append the correct
	// "...and 3 more" suffix computed from the un-truncated length.
	it("8 unexpected actions truncates the preview and reports '...and 3 more'", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 3,
				matched_count: 3,
				missing_steps: [],
				unexpected_actions: ["u0", "u1", "u2", "u3", "u4", "u5", "u6", "u7"],
				drift_pct: 0,
			},
		});
		expect(warning).toBe(
			"[interlinked:plan-drift] Declared 3 step(s), matched 3.\n" +
				"Unexpected:\n  - u0\n  - u1\n  - u2\n  - u3\n  - u4\n  ...and 3 more\n" +
				"Reflect on whether the divergence was deliberate (you learned the plan was wrong) " +
				"or accidental (you forgot a step / wandered). Both are fine outcomes; what's not " +
				"fine is claiming done without naming the divergence.",
		);
	});
});
