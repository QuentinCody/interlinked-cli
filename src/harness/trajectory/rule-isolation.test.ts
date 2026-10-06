import { expect, it, vi } from "vitest";
vi.mock("./rules-churn.js", () => ({ CHURN_RULES: [function brokenRule() { throw new Error("planted failure"); }] }));
vi.mock("./rules-obligations.js", () => ({ OBLIGATION_RULES: [() => ({ ruleId: "healthy", action: "silent_metric", severity: "low", reason: "fired" })] }));
vi.mock("./ltl/shadow.js", () => ({ evaluateLtlShadow: vi.fn(() => [{ ruleId: "ltl:healthy", action: "silent_metric", severity: "low", reason: "fired" }]) }));
import { createState, evaluateTrajectory } from "./index.js";
it("records a throwing rule and still evaluates healthy peers and LTL", () => {
    const verdicts = evaluateTrajectory(createState("s"), { ts: "2026-10-05T00:00:00Z", session: "s", agent: "claude",
        tool: "Read", toolUseId: "1", hook: "PostToolUse", input: {}, toolOutcome: "success" });
    expect(verdicts).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: "unavailable:brokenRule", action: "silent_metric", reason: expect.stringContaining("NOT CHECKED") }),
        expect.objectContaining({ ruleId: "healthy" }), expect.objectContaining({ ruleId: "ltl:healthy" }),
    ]));
});
