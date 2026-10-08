import { afterEach, expect, it, vi } from "vitest";
import { recordHookObservations } from "../hook-observations.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { __resetTrajectoryShadowForTest, mergeTrajectoryShadow } from "./trajectory-shadow.js";

vi.mock("../hook-observations.js", () => ({ recordHookObservations: vi.fn() }));
afterEach(() => {
    __resetTrajectoryShadowForTest();
    vi.clearAllMocks();
});

it("does not append observations when shadow evaluation is disabled", () => {
    const event: HarnessEvent = {
        hook_event: "PostToolUse", session_id: "shadow-disabled", agent_source: "claude",
        timestamp: "2026-10-08T00:00:00Z", tool_name: "Edit",
        tool_input: { file_path: "/unread.ts", old_string: "before", new_string: "after" },
    };
    const decision: HarnessDecision = { decision: "allow" };
    mergeTrajectoryShadow(event, decision, { trajectory_shadow: { enabled: false } });
    expect(recordHookObservations).not.toHaveBeenCalled();
    expect(decision).toEqual({ decision: "allow" });
});

it("captures non-Error adapter failures as unavailable telemetry without changing the decision", () => {
    const event: HarnessEvent = {
        hook_event: "PostToolUse", session_id: "shadow-failure", agent_source: "claude",
        timestamp: "2026-10-08T00:00:00Z", tool_name: "Edit",
        tool_input: new Proxy({}, { get() { throw "input unavailable"; } }),
    };
    const decision: HarnessDecision = { decision: "allow", warnings: ["existing warning"] };
    mergeTrajectoryShadow(event, decision, { trajectory_shadow: { enabled: true } });
    expect(recordHookObservations).toHaveBeenCalledExactlyOnceWith(event, [{
        kind: "trajectory", check: "trajectory_shadow",
        message: "[interlinked:trajectory] trajectory:unavailable (low, shadow — would silent_metric): NOT CHECKED: trajectory evaluation failed: input unavailable",
    }]);
    expect(decision).toEqual({ decision: "allow", warnings: ["existing warning"] });
});
