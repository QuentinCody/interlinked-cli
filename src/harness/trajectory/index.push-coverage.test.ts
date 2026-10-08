import { expect, it, vi } from "vitest";

vi.mock("./rules-churn.js", () => ({
    CHURN_RULES: [function () { throw "rule unavailable"; }],
}));
vi.mock("./ltl/shadow.js", () => ({
    evaluateLtlShadow: vi.fn(() => [{
        ruleId: "ltl:healthy", action: "silent_metric", severity: "low", reason: "healthy peer",
    }]),
}));

import { createState, evaluateTrajectory } from "./index.js";

it("records anonymous non-Error rule failures and continues to the LTL evaluator", () => {
    const state = createState("rule-isolation");
    const verdicts = evaluateTrajectory(state, {
        ts: "2026-10-08T00:00:00Z", session: "rule-isolation", agent: "claude",
        tool: "Read", toolUseId: "read-1", hook: "PostToolUse", input: {}, toolOutcome: "success",
    });
    expect(verdicts).toEqual(expect.arrayContaining([
        {
            ruleId: "unavailable:anonymous-rule", action: "silent_metric", severity: "low",
            reason: "NOT CHECKED: trajectory rule failed: rule unavailable",
        },
        { ruleId: "ltl:healthy", action: "silent_metric", severity: "low", reason: "healthy peer" },
    ]));
});
