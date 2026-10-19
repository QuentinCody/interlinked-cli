import { expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { registerActor } from "../taint-lineage.js";
import { makeGuardRules } from "./__tests__/fixtures.js";
import { evaluateTaintGuards } from "./taint-guards.js";

// Operator decision 2026-10-08 (feedback_no_network_taint_block): a tainted
// actor's outbound network command is monitored, never refused. This pin keeps
// the refusal from coming back.
it("does not refuse a tainted subagent's network command", () => {
    const session = makeSession();
    session.sensitivity_level = "Confidential";
    registerActor(session, "reader");
    const result = evaluateTaintGuards({
        toolName: "Bash", toolInput: { command: "curl https://example.com" },
        session, actor: "reader", rules: makeGuardRules(), pendingEscalation: undefined,
    });
    expect(result.kind).not.toBe("block");
});

it("uses a registered sibling's own sensitivity limit and tool count", () => {
    const rules = makeGuardRules();
    rules.taint_tracking.step_limits.Public = 10;
    const session = makeSession();
    registerActor(session, "public-worker");
    session.sensitivity_level = "Confidential";
    session.step_limit = 1;
    session.tool_call_count = 100;
    session.actor_tool_calls = new Map([["public-worker", 2]]);
    const args = { toolName: "Write", toolInput: { file_path: "notes.txt", content: "ok" }, session, actor: "public-worker", rules, pendingEscalation: undefined };
    expect(evaluateTaintGuards(args)).toEqual({ kind: "ok", warnings: [], escalation: undefined });
    session.actor_tool_calls.set("public-worker", 11);
    const blocked = evaluateTaintGuards(args);
    expect(blocked.kind).toBe("block");
    if (blocked.kind !== "block") throw new Error("Expected the actor budget to block writes");
    expect(blocked.decision.reason).toContain("Step limit (10) exceeded at Public");
    expect(evaluateTaintGuards({ ...args, toolName: "Read" }).kind).toBe("allow-readonly");
});
