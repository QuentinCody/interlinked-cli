import { checkSummaryFileCoverage, touchedSummaryEvidence } from "../../commands/verify/summary-file-coverage.js";
import type { HarnessEvent } from "../types.js";

/** Advisory only. The ledger supplies observed touches, not a net filesystem diff. */
export function summaryCoverageWarnings(event: HarnessEvent, fallbackRoot: string): string[] {
    if (event.hook_event !== "Stop" || event.dry_run || !event.last_assistant_message) return [];
    const evidence = touchedSummaryEvidence(event.cwd || fallbackRoot, event.session_id, event.last_assistant_message, Date.parse(event.timestamp));
    return checkSummaryFileCoverage(evidence).slice(0, 6).map(finding => `[summary_file_coverage] ${finding.message}`);
}
