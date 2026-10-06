import { appendCheckObservation } from "./check-observation-store.js";
import type { CheckObservation, DetectorExecution } from "./finding-outcomes.js";
import type { RescanFindingLike } from "./stop-rescan-report.js";

function annotateExecution(row: CheckObservation, execution: DetectorExecution,
    findings: RescanFindingLike[], intended: RescanFindingLike[]): void {
    execution.findings = execution.findings.map(hit => {
        const matches = (finding: RescanFindingLike): boolean => finding.file === row.file
            && finding.checkId === execution.check && finding.line === hit.line && finding.text === hit.text;
        const deferred = findings.find(finding => finding.deferred && matches(finding));
        return { ...hit, emitted: intended.some(matches),
            ...(deferred ? { suppressed: deferred.deferReason ?? "Inline deferral without a reason" } : {}) };
    });
}

/** Bind intended individual output after filtering; native delivery remains unknown. */
export function retainStopObservations(args: {
    cwd: string; rows: CheckObservation[]; findings: RescanFindingLike[];
    intended: RescanFindingLike[]; dryRun: boolean;
}): void {
    for (const row of args.rows) {
        for (const execution of row.executions) {
            annotateExecution(row, execution, args.findings, args.intended);
        }
        appendCheckObservation(args.cwd, { hook_event: "Stop", session_id: row.session,
            agent_source: "harness", timestamp: row.ts, dry_run: args.dryRun }, row);
    }
}
