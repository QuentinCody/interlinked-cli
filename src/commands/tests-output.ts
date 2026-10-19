import type { TestPlan } from "../harness/test-plan.js";
import type { TestExecution } from "../harness/test-run-receipt.js";

const DISPLAY_ROWS = 12;
const DISPLAY_WIDTH = 320;

/** Bound presentation only: never alter the plan, scheduler inputs or JSON evidence. */
function listing<T>(items: readonly T[], label: string, render: (item: T) => string, details: boolean): string[] {
    const visible = details ? items : items.slice(0, DISPLAY_ROWS);
    let clipped = false;
    const lines = visible.map(item => {
        const line = render(item);
        if (details || line.length <= DISPLAY_WIDTH) return line;
        clipped = true;
        return `${line.slice(0, DISPLAY_WIDTH)}…`;
    });
    const hidden = items.length - visible.length;
    if (hidden || clipped) {
        lines.push(`Display only: ${hidden} additional ${label} hidden${clipped ? "; long entries shortened" : ""}. Use --details or --json for the complete listing.`);
    }
    return lines;
}

export function formatTestPlan(plan: TestPlan, details = false): string {
    const summary = `${plan.mode}: ${plan.tests.length} test files; ${plan.omitted.length} omitted; estimated serial time ${plan.estimatedSerialMs === null ? "unmeasured" : `${plan.estimatedSerialMs} ms`}`;
    const estimate = plan.classifierEstimate;
    return [summary, `Snapshot: ${plan.snapshot}`, `Result reuse: ${plan.reusable ? "eligible after runtime validation" : "disabled"}`,
        ...(estimate ? [`Classifier estimate (not applied unless --static-selection): ${estimate.omitted} omitted; reuse ${estimate.reusable ? "eligible" : "not eligible"}`] : []),
        ...listing(plan.reasons, "plan reasons", reason => reason, details),
        ...listing(plan.tests, "test entries", test => `${test.path}: ${test.reasons.join("; ")}`, details),
        ...(details ? plan.omitted.map(path => `Omitted from execution: ${path}`) : []),
    ].join("\n");
}

export function formatPendingTestPaths(paths: readonly string[], details = false): string {
    return listing(paths, "pending inputs", path => path, details).join("\n");
}

/** A plan's reuse eligibility is not evidence that this request ran or passed. */
export function formatTestEvidence(result: TestExecution): string {
    if (result.status !== "passed") return "Evidence: no passing result certified for this request.";
    const origin = result.reused ? "reused passing receipt" : result.shared ? "shared completed run" : "completed run";
    const runtime = result.runtimeVerified === true ? "runtime inputs validated"
        : result.runtimeVerified === false ? "runtime inputs not fully validated; no reusable or coverage verdict"
        : "runtime validation not reported";
    return `Evidence: ${origin}; ${runtime}.`;
}
