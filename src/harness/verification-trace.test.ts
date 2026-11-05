import { describe, expect, it } from "vitest";
import { explainVerificationTrace, latestPushTrace, renderVerificationTrace, type TraceRow } from "./verification-trace.js";

function row(over: Partial<TraceRow> & { ts: string; check: string }): TraceRow {
    return { stage: "push", status: "passed", reused: false, identity: null, trace: "t-1", ...over };
}

// The November 4 push, compressed: daemon fallback + duplicate typecheck + a 300 s test gate the client abandoned,
// then the hook's typecheck waiting 100 s for the slot that gate held, then the full suite.
const november = [
    row({ ts: "2026-11-04T22:46:33.000Z", check: "pre-tool:managed-push", status: "fallback", owner: "daemon", validate_ms: 40, exec_ms: 0, reuse_denied_reason: "handoff-fallback:environment-override" }),
    row({ ts: "2026-11-04T22:46:54.000Z", check: "pre-tool:project-typecheck", owner: "daemon", wait_capacity_ms: 4, exec_ms: 21_000 }),
    row({ ts: "2026-11-04T22:51:54.000Z", check: "pre-tool:project-tests", status: "deferred", owner: "daemon", wait_capacity_ms: 1, exec_ms: 300_000, reuse_denied_reason: "interrupted" }),
    row({ ts: "2026-11-04T22:52:15.000Z", check: "npm run typecheck:stable", owner: "git-hook", wait_capacity_ms: 100_000, exec_ms: 21_000 }),
    row({ ts: "2026-11-04T23:16:50.000Z", check: "vitest:full", owner: "git-hook", wait_capacity_ms: 13, validate_ms: 2_000, exec_ms: 1_400_000, tests_executed: 3002, tests_reused: 0, reuse_denied_reason: "plan-not-reusable:Runtime validation unavailable: ENOENT" }),
];

describe("explainVerificationTrace — positive (must fire)", () => {
    // test-contract: public-api — one trace explains the push: owners, the fallback cause, each phase's cost and the user-visible span
    it("P1: attributes cost per owner and phase, names the fallback cause, and spans first start to last end", () => {
        const summary = explainVerificationTrace(november);
        expect(summary.trace).toBe("t-1");
        expect(summary.rows).toBe(5);
        expect(summary.fallback).toEqual({ cause: "environment-override", check: "pre-tool:managed-push" });
        expect(summary.owners.map(owner => [owner.owner, owner.rows, owner.exec_ms])).toEqual([["daemon", 3, 321_000], ["git-hook", 2, 1_421_000]]);
        expect(summary.phases).toEqual({ queue_ms: 0, wait_capacity_ms: 100_018, validate_ms: 2_040, lookup_ms: 0, exec_ms: 1_742_000, post_ms: 0 });
        expect(summary.tests).toEqual({ executed: 3002, reused: 0, unmeasured_runs: 1 });
        expect(summary.statuses).toEqual({ passed: 3, fallback: 1, deferred: 1 });
        expect(summary.deferred).toEqual([{ check: "pre-tool:project-tests", reason: "interrupted" }]);
        expect(summary.fresh).toEqual([{ check: "vitest:full", reason: "plan-not-reusable:Runtime validation unavailable: ENOENT" }]);
        // First start: the fallback row began 40 ms before 22:46:33; last end: 23:16:50.
        expect(summary.started).toBe("2026-11-04T22:46:32.960Z");
        expect(summary.ended).toBe("2026-11-04T23:16:50.000Z");
        expect(summary.span_ms).toBe(1_817_040);
    });

    // test-contract: invariant — two checks waiting for capacity at the same time are one wait on the clock, not two
    it("P2: counts overlapping capacity waits once in the wall-clock wait", () => {
        const summary = explainVerificationTrace([
            row({ ts: "2026-11-05T00:00:10.000Z", check: "a", wait_capacity_ms: 10_000, exec_ms: 0 }),
            row({ ts: "2026-11-05T00:00:12.000Z", check: "b", wait_capacity_ms: 10_000, exec_ms: 0 }),
            row({ ts: "2026-11-05T00:00:40.000Z", check: "c", wait_capacity_ms: 5_000, exec_ms: 0 }),
        ]);
        expect(summary.phases.wait_capacity_ms).toBe(25_000);
        expect(summary.wall_wait_ms).toBe(17_000);
    });

    // test-contract: public-api — the newest push trace is the one to explain by default
    it("P3: picks the newest trace that carries a push-stage row", () => {
        const rows = [
            row({ ts: "2026-11-05T01:00:00.000Z", check: "vitest:selected", stage: "edit", trace: "edit-only" }),
            row({ ts: "2026-11-05T00:30:00.000Z", check: "vitest:full", trace: "older-push" }),
            row({ ts: "2026-11-05T00:50:00.000Z", check: "pre-tool:managed-push", status: "delegated", trace: "newer-push" }),
            row({ ts: "2026-11-05T00:55:00.000Z", check: "npm run docs:check", trace: "newer-push" }),
        ];
        expect(latestPushTrace(rows)).toBe("newer-push");
    });
});

describe("explainVerificationTrace — negative (must not fire)", () => {
    // test-contract: invariant — a missing runner report leaves the executed count unknown, not zero or the plan size
    it("preserves unknown file counts beside measured runs without counting unrelated checks", () => {
        const summary = explainVerificationTrace([
            row({ ts: "2026-11-05T00:00:01.000Z", check: "vitest:full", status: "failed" }),
            row({ ts: "2026-11-05T00:00:02.000Z", check: "vitest:selected", tests_executed: 2, tests_reused: 0 }),
            row({ ts: "2026-11-05T00:00:03.000Z", check: "vitest:selected", reused: true, tests_executed: 0, tests_reused: 3 }),
            row({ ts: "2026-11-05T00:00:04.000Z", check: "npm run typecheck:stable" }),
        ]);
        expect(summary.tests).toEqual({ executed: 2, reused: 3, unmeasured_runs: 1 });
        expect(renderVerificationTrace(summary)).toContain("test files: 2 observed executed, 3 reused; counts unavailable for 1 run(s)");
    });

    // test-contract: invariant — rows of other traces and rows without durations neither join nor inflate the summary
    it("N1: ignores rows from other traces and treats missing durations as zero without fabricating a start", () => {
        const summary = explainVerificationTrace([
            row({ ts: "2026-11-05T00:00:00.000Z", check: "e2e-merge", post_ms: 9_000 }),
            row({ ts: "2026-11-05T00:00:30.000Z", check: "other", trace: "t-2", exec_ms: 999 }),
        ], "t-1");
        expect(summary.rows).toBe(1);
        expect(summary.phases.exec_ms).toBe(0);
        expect(summary.phases.post_ms).toBe(9_000);
        expect(summary.fallback).toBeNull();
        expect(summary.started).toBe("2026-11-04T23:59:51.000Z");
        expect(summary.span_ms).toBe(9_000);
        expect(latestPushTrace([row({ ts: "2026-11-05T00:00:00.000Z", check: "x", stage: "edit" })])).toBeNull();
    });
});
