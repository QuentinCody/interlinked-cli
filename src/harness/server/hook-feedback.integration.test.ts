import { describe, expect, it } from "vitest";
import { makeServerRuntime } from "./__tests__/fixtures.js";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { applyQualityDecision, collectQualityResultEntries } from "./post-tool-file-checks-phases-quality.js";
import { emitAllCleanSummary } from "./post-tool-pipeline-tail.js";
import { buildCheckRow } from "../check-results-sink.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import type { QualityCheckResult } from "../quality-checks/result-types.js";

const event: HarnessEvent = { hook_event: "PostToolUse", session_id: "reader", tool_use_id: "read-call", agent_source: "claude", timestamp: "2026-09-25T00:00:00Z" };
const current: QualityCheckResult = { name: "typescript", severity: "error", message: "Newly observed type error", file: "/repo/src/a.ts", detail: "src/a.ts(211): TS2322: browser is not assignable to http | process", novelty: "newly-observed", findingCount: 1 };

describe("feedback, enforcement and evidence stay independent", () => {
    it("does not lose a new blocking diagnostic when another phase already supplied a reason", () => {
        const decision: HarnessDecision = { decision: "block", reason: "earlier structural block" };
        applyQualityDecision(makeServerRuntime({ cwd: "/repo" }), [current], decision);
        expect(decision.reason).toBe("earlier structural block");
        expect(decision.warnings?.join("\n")).toContain("TS2322");
    });
    it("shows one actionable block and a compact debt count, retaining all 18 old diagnostics", () => {
        const ctx = makeServerRuntime({ cwd: "/repo" });
        const old = { ...current, severity: "warning" as const, novelty: "pre-existing" as const, findingCount: 18,
            detail: Array.from({ length: 18 }, (_, i) => `src/a.ts(${i + 1}): TS2440: conflicting import name${i}`).join("\n") };
        const decision: HarnessDecision = { decision: "allow", check_results: [] };
        collectQualityResultEntries([current, old], decision.check_results!);
        applyQualityDecision(ctx, [current, old], decision);
        expect(decision.decision).toBe("block");
        expect(decision.reason).toContain("TS2322");
        expect(decision.reason).not.toContain("TS2440");
        expect(decision.warnings?.join("\n")).toContain("18 pre-existing");
        expect(decision.warnings?.join("\n")).not.toContain("TS2322");
        expect(buildCheckRow(event, decision)?.finding_details?.[1]?.detail).toBe(old.detail);
    });

    it("does not charge reader A with an unknown writer's TypeScript error, and still gates writer B", () => {
        const ctx = makeServerRuntime({ cwd: "/repo" });
        const session = makeSession();
        const observed = { ...current, writeAttribution: "observed-workspace" as const };
        const decision: HarnessDecision = { decision: "allow", check_results: [] };
        collectQualityResultEntries([observed], decision.check_results!);
        applyQualityDecision(ctx, [observed], decision, session);
        expect(decision.decision).toBe("allow");
        expect(decision.warnings?.join("\n")).toContain("writer unknown");
        const repeated: HarnessDecision = { decision: "allow", check_results: decision.check_results ?? [] };
        applyQualityDecision(ctx, [observed], repeated, session);
        expect(repeated.warnings?.length ?? 0).toBe(0);
        emitAllCleanSummary({ postDecision: repeated, rules: ctx.rules, checksRan: ["typescript"], elapsedMs: 1 });
        expect(repeated.summary).toBeUndefined();
        const writer: HarnessDecision = { decision: "allow" };
        applyQualityDecision(ctx, [{ ...current, writeAttribution: "declared-target" }], writer, makeSession());
        expect(writer.decision).toBe("block");
        applyQualityDecision(ctx, [{ ...current, writeAttribution: "declared-target" }], writer, makeSession());
        expect(writer.decision).toBe("block");
    });

    it("retains a security block despite unknown writer identity", () => {
        const decision: HarnessDecision = { decision: "allow" };
        applyQualityDecision(makeServerRuntime({ cwd: "/repo" }), [{ ...current, name: "gitleaks", writeAttribution: "observed-workspace" }], decision);
        expect(decision.decision).toBe("block");
    });
});
