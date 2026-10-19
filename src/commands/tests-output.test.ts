import { expect, it } from "vitest";
import type { TestPlan } from "../harness/test-plan.js";
import type { TestExecution } from "../harness/test-run-receipt.js";
import { formatPendingTestPaths, formatTestEvidence, formatTestPlan } from "./tests-output.js";

function plan(count = 1): TestPlan {
    return { version: 1, snapshot: "snapshot", changedPaths: ["a.ts"], mode: "full",
        tests: Array.from({ length: count }, (_, index) => ({ path: `test-${index}.test.ts`, reasons: ["Full reconciliation requested"], durationMs: null })),
        omitted: [], reasons: ["Full reconciliation requested"], estimatedSerialMs: null, reusable: false };
}

// test-contract: invariant — large plans fit in bounded model context without changing execution inputs; complete detail remains explicitly available.
it("bounds a large plan while retaining counts, missingness and the complete underlying plan", () => {
    const input = plan(5000);
    input.reasons.push(...Array.from({ length: 500 }, (_, index) => `Unknown input ${index}: ${"x".repeat(1000)}`));
    input.tests[0]!.reasons.push("y".repeat(10000));
    input.classifierEstimate = { omitted: 4500, reusable: true };
    const before = JSON.stringify(input);
    const compact = formatTestPlan(input);
    expect(compact.length).toBeLessThan(10000);
    expect(compact).toContain("5000 test files; 0 omitted");
    expect(compact).toContain("estimated serial time unmeasured");
    expect(compact).toContain("Result reuse: disabled");
    expect(compact).toContain("Classifier estimate (not applied unless --static-selection)");
    expect(compact).toContain("4988 additional test entries hidden");
    expect(compact).toContain("--details or --json");
    expect(compact).not.toContain("test-4999.test.ts");
    const detailed = formatTestPlan(input, true);
    expect(detailed).toContain("test-4999.test.ts: Full reconciliation requested");
    expect(detailed).toContain(input.reasons.at(-1));
    expect(detailed).toContain("y".repeat(10000));
    expect(JSON.stringify(input)).toBe(before);
});

it("keeps a small plan readable and distinguishes execution omissions from display elision", () => {
    const input = plan();
    input.omitted = ["unaffected.test.ts"];
    input.reusable = true;
    input.estimatedSerialMs = 25;
    expect(formatTestPlan(input)).toContain("1 test files; 1 omitted; estimated serial time 25 ms");
    expect(formatTestPlan(input)).toContain("test-0.test.ts: Full reconciliation requested");
    expect(formatTestPlan(input)).not.toContain("Display only");
    expect(formatTestPlan(input, true)).toContain("Omitted from execution: unaffected.test.ts");
});

it("bounds pending inputs and reveals all of them on request, including long paths", () => {
    const paths = Array.from({ length: 1000 }, (_, index) => `${"nested/".repeat(100)}input-${index}.ts`);
    expect(formatPendingTestPaths(paths).length).toBeLessThan(4500);
    expect(formatPendingTestPaths(paths)).toContain("988 additional pending inputs hidden");
    expect(formatPendingTestPaths(paths, true)).toBe(paths.join("\n"));
    expect(formatPendingTestPaths([])).toBe("");
});

const execution = (status: TestExecution["status"]): TestExecution => ({ status, plan: plan(), runId: "r", reused: false, durationMs: 1, output: "", reason: "" });

it.each(["failed", "deferred", "stale", "empty"] as const)("never turns %s into a pass from plan or runtime eligibility", status => {
    const result = { ...execution(status), runtimeVerified: true, reused: true };
    expect(formatTestEvidence(result)).toBe("Evidence: no passing result certified for this request.");
});

it("distinguishes fresh, shared and reused passes without inferring missing runtime validation", () => {
    expect(formatTestEvidence(execution("passed"))).toBe("Evidence: completed run; runtime validation not reported.");
    expect(formatTestEvidence({ ...execution("passed"), shared: true, runtimeVerified: false })).toContain("shared completed run; runtime inputs not fully validated; no reusable or coverage verdict");
    expect(formatTestEvidence({ ...execution("passed"), reused: true, runtimeVerified: true })).toBe("Evidence: reused passing receipt; runtime inputs validated.");
});
