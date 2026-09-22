// Warn-only commit gate: the ranker is mocked here (its own test runs a real
// repo); what this pins is the gate's shape — when it speaks, what it says,
// and that it never blocks or short-circuits.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDecision, HarnessEvent } from "../types.js";

const rankStagedCommit = vi.fn();
vi.mock("../jit-commit-rank.js", () => ({ rankStagedCommit: (...a: unknown[]) => rankStagedCommit(...a) }));
vi.mock("./commit-git-io.js", () => ({ resolveRepoRoot: () => "/repo" }));

const { checkCommitJitGate, runCommitJitGate, JIT_WARN_PERCENTILE } = await import("./commit-jit-gate.js");

function event(command: string): HarnessEvent {
	// SAFETY: the gate reads only tool_name / tool_input.command / cwd; the rest of the event shape is irrelevant here.
	return { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command }, timestamp: "t", cwd: "/repo" } as HarnessEvent;
}

const high = { target: "staged", score: 3, percentile: 96, population: 200, version: 1, contributions: { size: 2, diffusion: 0.5, history: 0.5, experience: -0.2, purpose: 0.25 }, inputs: { purpose: { isFix: true, isSecurityFix: false, isRevert: false } } };

beforeEach(() => {
	rankStagedCommit.mockReset();
	rankStagedCommit.mockReturnValue(high);
});

describe("checkCommitJitGate — positive (must fire)", () => {
	it("P1: a real commit whose staged diff ranks above the warn percentile gets one [interlinked:jit] warning", () => {
		const d = checkCommitJitGate(event('git commit -m "fix: wide"'));
		expect(d?.decision).toBe("allow");
		expect(d?.warnings).toHaveLength(1);
		expect(d?.warnings?.[0]).toMatch(/^\[interlinked:jit\]\[heuristic\] .*p96 of 200/);
		expect(rankStagedCommit).toHaveBeenCalledWith("/repo", "fix: wide", expect.anything());
	});
	it("P2: runCommitJitGate appends to preDecision.warnings and returns void", () => {
		const pre: HarnessDecision = { decision: "allow", warnings: ["earlier"] };
		expect(runCommitJitGate(event("git commit -m x"), pre)).toBeUndefined();
		expect(pre.warnings).toHaveLength(2);
	});
});

describe("checkCommitJitGate — negative (must not fire)", () => {
	it("N1: a below-threshold rank is silent", () => {
		rankStagedCommit.mockReturnValue({ ...high, percentile: JIT_WARN_PERCENTILE - 1 });
		expect(checkCommitJitGate(event("git commit -m x"))).toBeNull();
	});
	it("N2: non-commit git commands and non-Bash tools never call the ranker", () => {
		expect(checkCommitJitGate(event("git status"))).toBeNull();
		const pre: HarnessDecision = { decision: "allow" };
		runCommitJitGate({ ...event("git commit"), tool_name: "Edit" }, pre);
		expect(rankStagedCommit).not.toHaveBeenCalled();
	});
	it("N3: no ruler (null percentile) and a ranker throw both stay silent", () => {
		rankStagedCommit.mockReturnValue({ ...high, percentile: null, population: 0 });
		expect(checkCommitJitGate(event("git commit -m x"))).toBeNull();
		rankStagedCommit.mockImplementation(() => { throw new Error("git exploded"); });
		expect(checkCommitJitGate(event("git commit -m x"))).toBeNull();
	});
	it("N4: an already-blocked preDecision is left untouched", () => {
		const pre: HarnessDecision = { decision: "block", reason: "r" };
		runCommitJitGate(event("git commit -m x"), pre);
		expect(pre.warnings).toBeUndefined();
	});
});
