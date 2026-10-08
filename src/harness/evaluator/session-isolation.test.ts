import { describe, expect, it } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { registerActor } from "../taint-lineage.js";
import { ratchetActorSensitivity } from "../taint-tracker.js";
import { evaluateTaintGuards } from "./taint-guards.js";
import { makeGuardRules } from "./__tests__/fixtures.js";

describe("actor budget isolation", () => {
    it("keeps a running clean sibling's budget after a worker reads a secret", () => {
        const session = makeSession();
        const rules = makeGuardRules();
        rules.taint_tracking.step_limits = { Public: 100, Internal: 50, Confidential: 10, HighlyConfidential: 5 };
        session.step_limit = 100;
        registerActor(session, "reader");
        registerActor(session, "sibling");
        session.actor_tool_calls = new Map([["reader", 11], ["sibling", 20]]);
        ratchetActorSensitivity(session, "reader", { file: ".env", level: "Confidential" }, rules.taint_tracking);
        const evaluate = (actor: string) => evaluateTaintGuards({
            toolName: "Edit", toolInput: { file_path: "src/app.ts" }, rules, session, actor, pendingEscalation: undefined,
        });
        expect(evaluate("sibling")).toEqual({ kind: "ok", warnings: [], escalation: undefined });
        expect(evaluate("reader").kind).toBe("block");
        registerActor(session, "late-child");
        session.actor_tool_calls.set("late-child", 11);
        expect(evaluate("late-child").kind).toBe("block");
        session.actor_tool_calls.set("sibling", 96);
        const warning = evaluate("sibling");
        expect(warning.kind).toBe("ok");
        expect(warning).toMatchObject({ warnings: [expect.stringContaining("100 limit at Public sensitivity")] });
        session.actor_tool_calls.set("sibling", 101);
        expect(evaluate("sibling").kind).toBe("block");
    });
});
