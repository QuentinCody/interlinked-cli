import { describe, expect, it } from "vitest";
import { createState, evaluateTrajectory } from "./index.js";
import type { ToolEvent } from "./types.js";
import type { HarnessEvent } from "../types.js";
import { __resetTrajectoryShadowForTest, trajectoryShadowWarnings } from "../server/trajectory-shadow.js";

function event(command: string, changes: Partial<ToolEvent> = {}): ToolEvent {
	return {
		ts: "2026-09-07T00:00:00Z", session: "recovery", agent: "test", tool: "Bash",
		toolUseId: "call", hook: "PostToolUse", input: { command }, toolOutcome: "success", ...changes,
	};
}

describe("harness recovery evidence", () => {
	it("does not latch a failed disable command", () => {
		const state = createState("recovery");
		evaluateTrajectory(state, event("pkill -f harness", { toolOutcome: "fail" }));
		expect(state.harnessDisabled).toBeNull();
	});

	it("retires process-disable suspicion after a trusted serving observation", () => {
		const state = createState("recovery");
		evaluateTrajectory(state, event("pkill -f harness"));
		expect(state.harnessDisabled?.how).toBe("killed harness process");
		const findings = evaluateTrajectory(state, event("git commit -m fix", { hook: "PreToolUse", harnessServing: true }));
		expect(state.harnessDisabled).toBeNull();
		expect(findings.map((finding) => finding.ruleId)).not.toContain("sec_harness_disable_then_guarded_op");
	});

	it("retains configuration weakening even while the daemon is serving", () => {
		const state = createState("recovery");
		state.harnessDisabled = { atStep: 1, how: "grew disabled_rules" };
		const findings = evaluateTrajectory(state, event("git commit -m fix", { hook: "PreToolUse", harnessServing: true }));
		expect(findings.map((finding) => finding.ruleId)).toContain("sec_harness_disable_then_guarded_op");
	});

	it("the live daemon supplies serving evidence independently of tool input", () => {
		__resetTrajectoryShadowForTest();
		const base: Pick<HarnessEvent, "session_id" | "agent_source" | "timestamp" | "tool_name"> = { session_id: "recovery", agent_source: "codex", timestamp: "2026-09-07T00:00:00Z", tool_name: "Bash" };
		const config = { trajectory_shadow: { enabled: true } };
		trajectoryShadowWarnings({ ...base, hook_event: "PostToolUse", tool_outcome: "success", tool_input: { command: "pkill -f harness" } }, { decision: "allow" }, config);
		const warnings = trajectoryShadowWarnings({ ...base, hook_event: "PreToolUse", tool_input: { command: "git commit -m fix" } }, { decision: "allow" }, config);
		expect(warnings.filter((warning) => warning.includes("sec_harness_disable_then_guarded_op"))).toEqual([]);
	});
});
