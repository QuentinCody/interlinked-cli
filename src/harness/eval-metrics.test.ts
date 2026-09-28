import { describe, expect, it } from "vitest";
import {
	type ArmCellSummary,
	aggregateMetrics,
	compareArms,
	type EvalMetrics,
	extractEvalMetrics,
	isVerifierCommand,
	noiseRatio,
	taskVerdict,
} from "./eval-metrics.js";

// Synthetic activity.jsonl lines mirroring the real schema_version 5 events
// (verified against this repo's .interlinked/activity.jsonl: tool_use_start /
// tool_use / guard_block / guard_warn / guard_allow with guard_* fields).

function ev(fields: Record<string, unknown>): string {
	return JSON.stringify({ schema_version: 5, ts: "2026-07-06T00:00:00.000Z", session: "s1", ...fields });
}

function start(tool: string): string {
	return ev({ type: "tool_use_start", hook: "PreToolUse", tool });
}

function done(tool: string, command?: string): string {
	const fields: Record<string, unknown> = { type: "tool_use", hook: "PostToolUse", tool };
	if (command !== undefined) fields.tool_input = { command };
	return ev(fields);
}

interface BlockFields {
	rule?: string | null;
	tool?: string | null;
	reason?: string;
}

function block(fields: BlockFields): string {
	return ev({
		type: "guard_block",
		hook: "PreToolUse",
		tool: fields.tool ?? null,
		guard_decision: "block",
		guard_rule_id: fields.rule ?? null,
		guard_reason: fields.reason ?? null,
	});
}

function warn(warnings?: string[]): string {
	return ev({
		type: "guard_warn",
		hook: "PreToolUse",
		tool: "Bash",
		guard_decision: "warn",
		guard_warnings: warnings ?? null,
	});
}

function zeroMetrics(over?: Partial<EvalMetrics>): EvalMetrics {
	return {
		blocks: {},
		blocks_total: 0,
		warnings: 0,
		edits: 0,
		verifier_runs: 0,
		block_retry_success: 0,
		block_loops: 0,
		turns: 0,
		...over,
	};
}

interface CellFields {
	arm: "on" | "off";
	rep: number;
	success: boolean;
	over?: Partial<EvalMetrics>;
}

function cell(fields: CellFields): ArmCellSummary {
	return { arm: fields.arm, rep: fields.rep, success: fields.success, metrics: zeroMetrics(fields.over) };
}

describe("extractEvalMetrics", () => {
	it("correlates one retry by session and canonical target, including apply_patch edits", () => {
		const scoped = (type: string, path: string, id: string) => ev({ type, tool: "Edit", tool_use_id: id, cwd: "/repo", tool_input: { file_path: path }, guard_rule_id: "cap" });
		const lines = [scoped("tool_use_start", "src/a.ts", "deny"), ev({ type: "guard_block", tool: "Edit", tool_use_id: "deny", guard_rule_id: "cap" }),
			scoped("tool_use", "src/b.ts", "other"), scoped("tool_use", "src/../src/a.ts", "retry"),
			ev({ type: "tool_use", tool: "apply_patch", tool_input: { patch: "*** Update File: src/a.ts\n@@\n-a\n+b" } })];
		const metrics = extractEvalMetrics(lines);
		expect(metrics.block_retry_success).toBe(1);
		expect(metrics.edits).toBe(3);
	});
	it("does not join blocks across completed calls or count clean calls as block loops", () => {
		const denied = block({ rule: "a", tool: "Edit" });
		expect(extractEvalMetrics([denied, denied, done("Read"), denied, denied]).block_loops).toBe(0);
		expect(extractEvalMetrics([done("Read"), done("Read"), done("Read")]).block_loops).toBe(0);
	});
	it("counts blocks by rule id, total blocks, and turns (positive)", () => {
		const m = extractEvalMetrics([
			start("Write"),
			block({ rule: "tdd_new_file_gate", tool: "Write" }),
			start("Write"),
			block({ rule: "tdd_new_file_gate", tool: "Write" }),
			start("Bash"),
			block({ tool: "Bash", reason: "BLOCKED: `cat` requesting 101 lines without a downstream filter" }),
			start("Read"),
		]);
		expect(m.blocks.tdd_new_file_gate).toBe(2);
		expect(m.blocks_total).toBe(3);
		expect(m.turns).toBe(4);
		const unattributed = Object.keys(m.blocks).filter((k) => k.startsWith("unattributed:"));
		expect(unattributed).toHaveLength(1);
		expect(m.blocks[unattributed[0] ?? ""]).toBe(1);
	});

	it("keys a block with neither rule id nor reason as unattributed:<no-reason> (positive)", () => {
		const m = extractEvalMetrics([block({}), block({ rule: "" })]);
		expect(m.blocks["unattributed:<no-reason>"]).toBe(2);
	});

	it("counts warnings across guard_warn / guard_allow / guard_block payloads (positive)", () => {
		const m = extractEvalMetrics([
			warn(["[interlinked:sequence] a", "[interlinked:cyclomatic] b"]),
			warn(),
			ev({ type: "guard_allow", hook: "PostToolUse", tool: "Edit", guard_warnings: ["[interlinked:file-size] c"] }),
			ev({ type: "guard_allow", hook: "PostToolUse", tool: "Edit", guard_warnings: null }),
			ev({ type: "guard_block", hook: "PreToolUse", tool: "Bash", guard_rule_id: "r", guard_warnings: ["d"] }),
		]);
		expect(m.warnings).toBe(5);
	});

	it("counts completed edits and verifier runs (positive)", () => {
		const m = extractEvalMetrics([
			done("Edit"),
			done("Write"),
			done("MultiEdit"),
			done("Bash", "npx vitest run src/x.test.ts"),
			done("Bash", "npm run typecheck"),
			done("Bash", "ls -la"),
			done("Read"),
		]);
		expect(m.edits).toBe(3);
		expect(m.verifier_runs).toBe(2);
	});

	it("does not infer a successful retry from a tool name with no target evidence", () => {
		const m = extractEvalMetrics([
			block({ rule: "tdd_new_file_gate", tool: "Write" }),
			done("Write"),
			block({ rule: "complexity_write_guard", tool: "Edit" }),
			done("Bash", "git status"),
		]);
		expect(m.block_retry_success).toBe(0);
	});

	it("detects a block loop at >=3 consecutive same-rule blocks, counting each run once (positive)", () => {
		const a = block({ rule: "a", tool: "Edit" });
		const b = block({ rule: "b", tool: "Write" });
		expect(extractEvalMetrics([a, a, a]).block_loops).toBe(1);
		expect(extractEvalMetrics([a, a, a, a]).block_loops).toBe(1);
		expect(extractEvalMetrics([a, a, a, b, b, b]).block_loops).toBe(2);
	});

	it("ignores malformed, empty, and non-object lines (negative)", () => {
		const m = extractEvalMetrics(["{not json", "", "   ", "42", '"str"', "null", "[1,2]"]);
		expect(m).toEqual(zeroMetrics());
	});

	it("does not count attempts, allows, or non-edit tools as edits (negative)", () => {
		const m = extractEvalMetrics([
			start("Edit"),
			ev({ type: "guard_allow", hook: "PostToolUse", tool: "Edit" }),
			done("Read"),
			done("Grep"),
			ev({ type: "tool_use", hook: "PostToolUse" }),
		]);
		expect(m.edits).toBe(0);
		expect(m.turns).toBe(1);
	});

	it("does not count non-verifier bash or commandless/odd tool_input as verifier runs (negative)", () => {
		const m = extractEvalMetrics([
			done("Bash", "git status"),
			done("Bash", "cat notes.txt"),
			done("Bash"),
			ev({ type: "tool_use", hook: "PostToolUse", tool: "Bash", tool_input: "not-an-object" }),
		]);
		expect(m.verifier_runs).toBe(0);
	});

	it("does not credit retry success for blocks without a tool or with no later completion (negative)", () => {
		const m = extractEvalMetrics([block({}), done("Edit"), block({ rule: "r2", tool: "Write" })]);
		expect(m.block_retry_success).toBe(0);
	});

	it("does not report a loop for runs shorter than 3 or interrupted runs (negative)", () => {
		const a = block({ rule: "a", tool: "Edit" });
		const b = block({ rule: "b", tool: "Edit" });
		expect(extractEvalMetrics([a, a, b, a, a]).block_loops).toBe(0);
	});
});

describe("isVerifierCommand", () => {
	it("matches common test / typecheck / build invocations (positive)", () => {
		expect(isVerifierCommand("npx vitest run src/a.test.ts")).toBe(true);
		expect(isVerifierCommand("npm test")).toBe(true);
		expect(isVerifierCommand("npm run typecheck")).toBe(true);
		expect(isVerifierCommand("pytest -q")).toBe(true);
		expect(isVerifierCommand("npx tsc --noEmit")).toBe(true);
		expect(isVerifierCommand("node --test")).toBe(true);
	});

	it("does not match ordinary shell work (negative)", () => {
		expect(isVerifierCommand("git status")).toBe(false);
		expect(isVerifierCommand("ls -la src")).toBe(false);
		expect(isVerifierCommand("node scripts/count-lines.mjs")).toBe(false);
		expect(isVerifierCommand("cat package.json")).toBe(false);
	});
});

describe("noiseRatio", () => {
	it("divides warnings by turns, guarding zero turns", () => {
		expect(noiseRatio(zeroMetrics({ warnings: 3, turns: 4 }))).toBe(0.75);
		expect(noiseRatio(zeroMetrics({ warnings: 2, turns: 0 }))).toBe(2);
	});
});

describe("aggregateMetrics", () => {
	it("sums counters and merges block records (positive)", () => {
		const a = zeroMetrics({ blocks: { r1: 1 }, blocks_total: 1, warnings: 2, edits: 3, turns: 10 });
		const b = zeroMetrics({ blocks: { r1: 2, r2: 1 }, blocks_total: 3, warnings: 1, verifier_runs: 2, turns: 5 });
		const sum = aggregateMetrics([a, b]);
		expect(sum.blocks).toEqual({ r1: 3, r2: 1 });
		expect(sum.blocks_total).toBe(4);
		expect(sum.warnings).toBe(3);
		expect(sum.edits).toBe(3);
		expect(sum.verifier_runs).toBe(2);
		expect(sum.turns).toBe(15);
	});

	it("returns zero metrics for an empty list (negative)", () => {
		expect(aggregateMetrics([])).toEqual(zeroMetrics());
	});
});

describe("compareArms", () => {
	it("flags harness_regression when off succeeds and on fails", () => {
		const rows = compareArms(zeroMetrics(), zeroMetrics(), false, true);
		const success = rows.find((r) => r.metric === "success");
		expect(success?.flag).toBe("harness_regression");
		expect(success?.delta).toBe(-1);
	});

	it("flags both_arms_failed when neither arm succeeds", () => {
		const rows = compareArms(zeroMetrics(), zeroMetrics(), false, false);
		expect(rows.find((r) => r.metric === "success")?.flag).toBe("both_arms_failed");
	});

	it("flags block_loop and noisy from the harness-on metrics", () => {
		const on = zeroMetrics({ block_loops: 1, warnings: 6, turns: 10 });
		const rows = compareArms(on, zeroMetrics(), true, true);
		expect(rows.find((r) => r.metric === "block_loops")?.flag).toBe("block_loop");
		expect(rows.find((r) => r.metric === "noise_ratio")?.flag).toBe("noisy");
	});

	it("produces the full row set with numeric deltas and no flags on a clean pair", () => {
		const on = zeroMetrics({ blocks_total: 1, warnings: 2, edits: 5, verifier_runs: 3, turns: 20 });
		const off = zeroMetrics({ edits: 4, verifier_runs: 2, turns: 15 });
		const rows = compareArms(on, off, true, true);
		expect(rows.map((r) => r.metric)).toEqual([
			"success",
			"blocks_total",
			"block_loops",
			"warnings",
			"noise_ratio",
			"edits",
			"verifier_runs",
			"turns",
		]);
		expect(rows.every((r) => r.flag === null)).toBe(true);
		expect(rows.find((r) => r.metric === "turns")?.delta).toBe(5);
		expect(rows.find((r) => r.metric === "noise_ratio")?.on).toBe(0.1);
	});
});

describe("taskVerdict", () => {
	it("FAILs when harness-off succeeds but harness-on fails twice in a row", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: false }),
			cell({ arm: "on", rep: 2, success: false }),
		]);
		expect(v.verdict).toBe("FAIL");
		expect(v.reasons.join(" ")).toContain("twice in a row");
	});

	it("WARNs on a single harness-on failure when harness-off succeeds", () => {
		const v = taskVerdict([cell({ arm: "off", rep: 1, success: true }), cell({ arm: "on", rep: 1, success: false })]);
		expect(v.verdict).toBe("WARN");
		expect(v.reasons.join(" ")).toContain("candidate");
	});

	it("WARNs on block loops or a noisy harness-on arm even when both succeed", () => {
		const loops = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { block_loops: 2 } }),
		]);
		expect(loops.verdict).toBe("WARN");
		const noisy = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { warnings: 8, turns: 10 } }),
		]);
		expect(noisy.verdict).toBe("WARN");
	});

	it("PASSes a clean on/off pair (negative: no spurious flags)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { warnings: 1, turns: 10 } }),
		]);
		expect(v).toEqual({ verdict: "PASS", reasons: [] });
	});

	it("SKIPs when either arm is missing (negative)", () => {
		expect(taskVerdict([cell({ arm: "on", rep: 1, success: true })]).verdict).toBe("SKIP");
		expect(taskVerdict([cell({ arm: "off", rep: 1, success: true })]).verdict).toBe("SKIP");
		expect(taskVerdict([]).verdict).toBe("SKIP");
	});

	it("does not FAIL on non-consecutive harness-on failures, but keeps the candidate WARN (negative)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: false }),
			cell({ arm: "on", rep: 2, success: true }),
			cell({ arm: "on", rep: 3, success: false }),
		]);
		expect(v.verdict).toBe("WARN");
	});

	it("keeps FAIL precedence and accumulates auxiliary reasons", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: false, over: { block_loops: 1 } }),
			cell({ arm: "on", rep: 2, success: false }),
		]);
		expect(v.verdict).toBe("FAIL");
		expect(v.reasons.length).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// Mutation-kill additions (Stryker manifest, src/harness/eval-metrics.ts).
// Each case names the mutant id(s) it targets directly above the it(). A
// handful of survivors in the manifest (parseEventLine's type/null guard and
// empty-string checks, recordBlock's/recordCompletedTool's null-tool guards,
// extractEvalMetrics' initial `retries` array literal) are true equivalent
// mutants given the current call graph — see the campaign receipt for the
// structural argument for each; no test is added for those.
// ---------------------------------------------------------------------------

describe("parseEventLine (via extractEvalMetrics) — mutation kill", () => {
	// test-contract: mutation-kill — 3393776f83163e96 (parseEventLine: line.trim() replaced with line)
	it("trims JS-whitespace that JSON.parse itself would reject, e.g. a leading/trailing NBSP (positive)", () => {
		// U+00A0 (NBSP): String.prototype.trim() strips it, but it is not
		// valid JSON insignificant whitespace, so JSON.parse rejects it if
		// left in place. Written via fromCharCode to keep the source file
		// free of invisible non-ASCII characters.
		const nbsp = String.fromCharCode(0xa0);
		const payload = JSON.stringify({ type: "tool_use_start", tool: "Write" });
		const m = extractEvalMetrics([`${nbsp}${payload}${nbsp}`]);
		expect(m.turns).toBe(1);
	});
});

describe("str (via ruleKeyOf) — mutation kill", () => {
	// test-contract: mutation-kill — df51abe4b46d09c0 (str: typeof value === "string" forced true)
	it("does not treat a non-string guard_rule_id as a valid rule key (positive)", () => {
		const m = extractEvalMetrics([
			ev({ type: "guard_block", tool: "Bash", guard_rule_id: 42, guard_reason: "some reason" }),
		]);
		expect(m.blocks["unattributed:some reason"]).toBe(1);
		expect(Object.keys(m.blocks)).toEqual(["unattributed:some reason"]);
	});
});

describe("ruleKeyOf — mutation kill", () => {
	// test-contract: mutation-kill — fe3c9ef3735c8b6f, 1322ec6d3fbd5367 (ruleKeyOf: reason===null||reason==="" forced true, and === flipped to !==, for a non-empty reason)
	it("builds the unattributed key from the real reason text when one is present (positive)", () => {
		const m = extractEvalMetrics([block({ tool: "Bash", reason: "totally custom reason text" })]);
		expect(m.blocks["unattributed:totally custom reason text"]).toBe(1);
	});

	// test-contract: mutation-kill — 0a5c083f1857b0d6, c6f8b3e44af4f9a1 (ruleKeyOf: reason==="" forced false, and the "" literal retargeted)
	it("falls back to <no-reason> for an explicitly empty reason string (negative)", () => {
		const m = extractEvalMetrics([block({ tool: "Bash", reason: "" })]);
		expect(m.blocks["unattributed:<no-reason>"]).toBe(1);
	});

	// test-contract: mutation-kill — 0ddff029bd7e7388 (ruleKeyOf: .slice(0, 40) truncation dropped)
	it("truncates a long reason to 40 characters in the unattributed key (positive)", () => {
		const longReason = "a".repeat(60);
		const m = extractEvalMetrics([block({ tool: "Bash", reason: longReason })]);
		const truncatedKey = `unattributed:${"a".repeat(40)}`;
		expect(m.blocks[truncatedKey]).toBe(1);
		expect(Object.keys(m.blocks)).toEqual([truncatedKey]);
	});

	// test-contract: mutation-kill — 8510543264ba745c, 93dda6781bd8b640, 91399d1b7f24bf4f (ruleKeyOf: whitespace-collapse regex narrowed/inverted, or the " " replacement blanked)
	it("collapses a run of tabs into a single space in the unattributed key (positive)", () => {
		const m = extractEvalMetrics([block({ tool: "Bash", reason: "a\t\tb" })]);
		expect(m.blocks["unattributed:a b"]).toBe(1);
		expect(Object.keys(m.blocks)).toEqual(["unattributed:a b"]);
	});
});

describe("warningCountOf — mutation kill", () => {
	// test-contract: mutation-kill — fc7770f8c7e83d15 (warningCountOf: evt.type === "guard_warn" flipped to !==)
	it("counts exactly one warning for a bare guard_warn event and zero for a bare guard_allow event (positive/negative)", () => {
		const warnOnly = extractEvalMetrics([warn()]);
		expect(warnOnly.warnings).toBe(1);
		const allowOnly = extractEvalMetrics([
			ev({ type: "guard_allow", hook: "PostToolUse", tool: "Edit", guard_warnings: null }),
		]);
		expect(allowOnly.warnings).toBe(0);
	});
});

describe("commandOf — mutation kill", () => {
	// test-contract: mutation-kill — 221b702d736f6802 (commandOf: input === null check disabled — would read .command off null and throw)
	it("treats an explicit null tool_input as no command, without throwing (negative)", () => {
		const m = extractEvalMetrics([ev({ type: "tool_use", hook: "PostToolUse", tool: "Bash", tool_input: null })]);
		expect(m.verifier_runs).toBe(0);
		expect(m.edits).toBe(0);
	});
});

describe("recordCompletedTool — mutation kill", () => {
	// test-contract: mutation-kill — f85c6f5bb9a156b7 (recordCompletedTool: tool === "Bash" forced true)
	it("only checks tool_input.command for Bash calls, not other tools (negative)", () => {
		const m = extractEvalMetrics([
			ev({ type: "tool_use", hook: "PostToolUse", tool: "Read", tool_input: { command: "npm test" } }),
		]);
		expect(m.verifier_runs).toBe(0);
	});
});

describe("extractEvalMetrics — additional mutation-kill cases", () => {
	// test-contract: mutation-kill — c01c9b78716b11e5 (extractEvalMetrics: warning-type guard forced true)
	it("does not count warnings for a tool_use_start event even if it carries a guard_warnings array (negative)", () => {
		const m = extractEvalMetrics([ev({ type: "tool_use_start", hook: "PreToolUse", tool: "Write", guard_warnings: ["x", "y"] })]);
		expect(m.warnings).toBe(0);
		expect(m.turns).toBe(1);
	});

	// test-contract: mutation-kill — 8eec441c0cbadcf0 (module: "NotebookEdit" literal in EDIT_TOOLS blanked)
	it("counts a completed NotebookEdit call as an edit (positive)", () => {
		const m = extractEvalMetrics([done("NotebookEdit")]);
		expect(m.edits).toBe(1);
	});
});

describe("aggregateMetrics — additional mutation-kill cases", () => {
	// test-contract: mutation-kill — cb17f2837f4fc061, b160e4e9e2763cc8 (aggregateMetrics: += flipped to -= for block_retry_success and block_loops)
	it("sums block_retry_success and block_loops across the list (positive)", () => {
		const a = zeroMetrics({ block_retry_success: 3, block_loops: 2 });
		const b = zeroMetrics({ block_retry_success: 2, block_loops: 1 });
		const sum = aggregateMetrics([a, b]);
		expect(sum.block_retry_success).toBe(5);
		expect(sum.block_loops).toBe(3);
	});
});

describe("successFlag (via compareArms) — mutation kill", () => {
	// test-contract: mutation-kill — 71b29d43aab89ba5 (successFlag: !offSuccess && !onSuccess flipped to ||)
	it("does not flag both_arms_failed when the on arm succeeds even though the off arm fails (negative)", () => {
		const rows = compareArms(zeroMetrics(), zeroMetrics(), true, false);
		expect(rows.find((r) => r.metric === "success")?.flag).toBeNull();
	});
});

describe("compareArms — additional mutation-kill cases", () => {
	// test-contract: mutation-kill — 8f99f720118274c4 (compareArms: onNoise > threshold flipped to >=)
	it("does not flag noisy when the on-arm noise ratio equals the threshold exactly (boundary, negative)", () => {
		const on = zeroMetrics({ warnings: 5, turns: 10 });
		const rows = compareArms(on, zeroMetrics(), true, true);
		expect(rows.find((r) => r.metric === "noise_ratio")?.flag).toBeNull();
	});
});

describe("regressionReasons (via taskVerdict) — mutation kill", () => {
	// test-contract: mutation-kill — c73e775b60f48d3d, 3305e202e2aba07f, f12c786d141e7e73 (regressionReasons: the off-failed early-return object literal corrupted)
	it("suppresses regression reasons entirely when the off arm itself failed (negative)", () => {
		const v = taskVerdict([cell({ arm: "off", rep: 1, success: false }), cell({ arm: "on", rep: 1, success: true })]);
		expect(v).toEqual({ verdict: "PASS", reasons: [] });
	});

	// test-contract: mutation-kill — cbe893828c573d21 (regressionReasons: the !offSucceeded early-return guard forced false)
	it("still suppresses regression reasons when the off arm failed, even with two consecutive on-arm failures (negative)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: false }),
			cell({ arm: "on", rep: 1, success: false }),
			cell({ arm: "on", rep: 2, success: false }),
		]);
		expect(v).toEqual({ verdict: "PASS", reasons: [] });
	});
});

describe("taskVerdict — additional mutation-kill cases", () => {
	// test-contract: mutation-kill — 4e590e6518874d5b, f6a74fd0bfd50947, 526d8c650251922b (taskVerdict: on-cell .sort(by rep) dropped, or its comparator broken/gutted — verified empirically that all three variants leave onCells in supplied order for this array size)
	it("sorts on-cells by rep before checking consecutive failures, so a passing rep between two failing reps breaks the streak (positive)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: false }),
			cell({ arm: "on", rep: 3, success: false }),
			cell({ arm: "on", rep: 2, success: true }),
		]);
		expect(v.verdict).toBe("WARN");
		expect(v.reasons.join(" ")).toContain("candidate");
		expect(v.reasons.join(" ")).not.toContain("twice in a row");
	});

	// test-contract: mutation-kill — 14589191f0dbdb89, cd4f015e0dce1070 (taskVerdict: SKIP reason template blanked, or its array literal emptied)
	it("names both arm counts precisely in the SKIP reason (positive)", () => {
		const v = taskVerdict([cell({ arm: "on", rep: 1, success: true })]);
		expect(v.verdict).toBe("SKIP");
		expect(v.reasons).toEqual(["need both arms to compare (have on=1, off=0)"]);
	});

	// test-contract: mutation-kill — 9ab60083c7f13749 (taskVerdict: offCells.some flipped to .every)
	it("treats the off arm as succeeded if ANY rep succeeded, not requiring every rep to succeed (positive)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "off", rep: 2, success: false }),
			cell({ arm: "on", rep: 1, success: false }),
		]);
		expect(v.verdict).toBe("WARN");
		expect(v.reasons.join(" ")).toContain("candidate");
	});

	// test-contract: mutation-kill — 4daa33c3e9ff5555 (taskVerdict: block-loop reason string blanked)
	it("names the block-loop reason text precisely (positive)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { block_loops: 1 } }),
		]);
		expect(v.reasons).toContain("block loop on harness-on arm (same rule blocked >=3x consecutively)");
	});

	// test-contract: mutation-kill — 4d4a6cbc18a8bb89 (taskVerdict: onCells.some flipped to .every for the noise check)
	it("flags on-arm noise if ANY rep exceeds the threshold, not requiring every rep to (positive)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { warnings: 8, turns: 10 } }),
			cell({ arm: "on", rep: 2, success: true, over: { warnings: 0, turns: 10 } }),
		]);
		expect(v.reasons.join(" ")).toContain("noise ratio above");
	});

	// test-contract: mutation-kill — facdf2f1b56ee318 (taskVerdict: noise-ratio reason string blanked)
	it("names the noise-ratio reason text precisely, including the threshold value (positive)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { warnings: 8, turns: 10 } }),
		]);
		expect(v.reasons).toContain("harness-on noise ratio above 0.5 (warnings per tool call)");
	});

	// test-contract: mutation-kill — 89b5f305dc107264 (taskVerdict: on-cell noiseRatio > threshold flipped to >=)
	it("does not flag on-arm noise at exactly the threshold, only strictly above it (boundary, negative)", () => {
		const v = taskVerdict([
			cell({ arm: "off", rep: 1, success: true }),
			cell({ arm: "on", rep: 1, success: true, over: { warnings: 5, turns: 10 } }),
		]);
		expect(v).toEqual({ verdict: "PASS", reasons: [] });
	});
});

describe("isVerifierCommand — additional mutation-kill cases", () => {
	// test-contract: mutation-kill — 1e805ca87e9a7af5 (module: npm regex's first \s+ narrowed to \s)
	it("matches npm test commands with extra internal spacing (positive)", () => {
		expect(isVerifierCommand("npm  test")).toBe(true);
	});

	// test-contract: mutation-kill — c90837d5fc4dad81 (module: npm regex's run-group \s+ narrowed to \s)
	it("matches npm run test commands with extra spacing after run (positive)", () => {
		expect(isVerifierCommand("npm run  test")).toBe(true);
	});

	// test-contract: mutation-kill — 741c0589a08aa6fd (module: node --test regex \s+ narrowed to \s)
	it("matches node --test with extra internal spacing (positive)", () => {
		expect(isVerifierCommand("node  --test")).toBe(true);
	});

	// test-contract: mutation-kill — c7993d5f0c4a5a6e, e8048028550aac54 (module: cargo regex \s+ narrowed to \s, or inverted to \S+)
	it("matches cargo test with extra internal spacing (positive)", () => {
		expect(isVerifierCommand("cargo  test")).toBe(true);
	});

	// test-contract: mutation-kill — d7e9dd675fd29d2d, d048f2c5fa418fc5 (module: go regex \s+ narrowed to \s, or inverted to \S+)
	it("matches go test with extra internal spacing (positive)", () => {
		expect(isVerifierCommand("go  test")).toBe(true);
	});

	// test-contract: mutation-kill — 1e1bd156bc40d4a0, be4f4d2b9d68164b (module: biome regex \s+ narrowed to \s, or inverted to \S+)
	it("matches biome check with extra internal spacing (positive)", () => {
		expect(isVerifierCommand("biome  check")).toBe(true);
	});
});
