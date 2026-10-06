import { evidenceRuntimeIdentity } from "./evidence-runtime-identity.js";
import { appendCapturedData } from "../lib/data/capture.js";
import { evidenceDigest, type CheckObservation, type DetectorExecution } from "./finding-outcomes.js";
import type { HarnessEvent } from "./types.js";

// Initial detectors with a declared file-only input domain; corpus qualification is separate.
// Other checks remain partial/legacy evidence until their input closure is declared.
export const FILE_EVIDENCE_COHORT = new Set(["async_promise_executor", "nan_comparison", "unawaited_async_assertion"]);
export function runningEvidenceIdentity(): string { return evidenceRuntimeIdentity(); }

export function makeCheckObservation(args: {
    event: HarnessEvent; file: string; content: string; executions: DetectorExecution[];
    scope: CheckObservation["scope"]; configuration: string;
}): CheckObservation {
    return { schema: "check-observations.v1", ts: args.event.timestamp,
        session: args.event.session_id, call: args.event.tool_use_id ?? args.event.timestamp,
        file: args.file, input: evidenceDigest(args.content), detector: runningEvidenceIdentity(),
        configuration: args.configuration, scope: args.scope, executions: args.executions };
}
export const RAW_FILE_CHECK_CONFIGURATION = evidenceDigest("raw-file-detectors:v1;no-filtering;no-suppression");

/** A batch shares file/input identity. This is the existing check-results evidence stream. */
export function appendCheckObservation(cwd: string, event: HarnessEvent, row: CheckObservation): void {
    if (event.dry_run || row.executions.length === 0) return;
    try {
        appendCapturedData({ cwd, producer: "harness/check-observations", session: event.session_id, provider: event.agent_source }, "check-results", [row]);
    } catch (error) {
        process.stderr.write("[interlinked:evidence-unavailable] Could not retain check observation: " + String(error) + "\n");
    }
}
