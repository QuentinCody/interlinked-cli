import { describe, expect, it } from "vitest";
import { evaluateActiveWhen, registeredSessionPredicates, unsupportedRulePredicates } from "./active-when.js";
import type { GuardRule, HarnessEvent } from "../types.js";

const event: HarnessEvent = {
    hook_event: "PreToolUse", session_id: "predicate-review", agent_source: "codex", timestamp: "t",
};

function rule(name?: string): GuardRule {
    return {
        id: "scoped", trigger: "PreToolUse", action: "ask", reason: "Review scope",
        enabled: true, tool_match: ["Bash"], patterns: [], severity: "medium",
        ...(name === undefined ? {} : { active_when: { predicate: { name } } }),
    };
}

describe("session predicate registry contract", () => {
    it("reports supported names and flags unknown or inherited names", () => {
        expect(registeredSessionPredicates()).toEqual(["active_agent_count_at_least"]);
        expect(unsupportedRulePredicates(rule())).toEqual([]);
        expect(unsupportedRulePredicates(rule("active_agent_count_at_least"))).toEqual([]);
        for (const name of ["future_predicate", "toString", "constructor", "__proto__"]) {
            expect(unsupportedRulePredicates(rule(name))).toEqual([name]);
            expect(evaluateActiveWhen(rule(name), undefined, event)).toBe(false);
        }
    });
});
