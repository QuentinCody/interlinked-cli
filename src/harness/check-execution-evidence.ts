import { isOperationalCheckDeferral } from "./operational-check-deferrals.js";
import type { HarnessDecision } from "./types.js";

interface CheckExecution { id: string; status: string; reason?: string; severity?: string; }
export function checkExecutionEvidence(decision: HarnessDecision): CheckExecution[] {
    const entries = new Map<string, CheckExecution>();
    for (const id of decision.checks_ran ?? []) entries.set(id, { id, status: "completed_no_reported_findings" });
    for (const finding of decision.check_results ?? []) {
        entries.set(finding.name, { id: finding.name,
            status: isOperationalCheckDeferral(finding.name) ? "deferred" : "finding",
            severity: finding.severity, reason: finding.message });
    }
    for (const skipped of decision.checks_skipped ?? []) {
        entries.set(skipped.check, { id: skipped.check, status: skippedStatus(skipped.category), reason: skipped.reason });
    }
    return [...entries.values()];
}
function skippedStatus(category: string): string {
    if (category === "error") return "error";
    if (category === "resource_busy" || category === "timeout") return "deferred";
    return "skipped";
}
