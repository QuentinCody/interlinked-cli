import { randomUUID } from "node:crypto";
import { appendCapturedData } from "../lib/data/capture.js";
import { dataRecordHash } from "../lib/data/normalize.js";
import { updateCaptureState } from "../lib/data/state.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { recordRecurrenceEvent } from "./recurrence-io.js";
import type { ScanCodebaseFinding } from "./recurrence-scanner.js";

interface ScanCapture { cwd: string; roots: string[]; extensions: string[]; includeCI: boolean; findings: ScanCodebaseFinding[]; }
function identifiedFinding(finding: ScanCodebaseFinding): JsonObject {
    return { ...finding, finding_id: dataRecordHash(JSON.stringify([finding.file, finding.check_id, finding.line, finding.text])) };
}

function scanDelta(previous: JsonObject, current: JsonObject[]): { introduced: JsonObject[]; absent: JsonObject[] } {
    const old = Array.isArray(previous.findings) ? previous.findings.filter(isJsonObject) : [];
    const oldIds = new Set(old.map((item) => item.finding_id));
    const ids = new Set(current.map((item) => item.finding_id));
    return { introduced: current.filter((item) => !oldIds.has(item.finding_id)), absent: old.filter((item) => !ids.has(item.finding_id)) };
}

/** Unchanged scans retain a receipt; changed inventories append only new/absent evidence. */
export function recordRecurrenceScan(input: ScanCapture): void {
    const scope = { roots: [...input.roots].sort(), extensions: [...input.extensions].sort(), includeCI: input.includeCI };
    const scopeId = dataRecordHash(JSON.stringify(scope));
    updateCaptureState(input.cwd, `recurrence-scan:${scopeId}`, (previous) => {
        const findings = input.findings.map(identifiedFinding);
        const snapshot = dataRecordHash(JSON.stringify(findings.map((finding) => finding.finding_id).sort()));
        const delta = scanDelta(previous, findings);
        const ts = new Date().toISOString();
        const scanId = randomUUID();
        const identity = { ts, scan_id: scanId, scope_id: scopeId, snapshot_id: snapshot };
        for (const finding of delta.introduced) {
            recordRecurrenceEvent({ ts, kind: "codebase_existing", check_id: String(finding.check_id),
                file: String(finding.file), message: String(finding.text), scan_id: scanId, snapshot_id: snapshot,
                finding_id: String(finding.finding_id), observation: "introduced" }, input.cwd);
        }
        const records = delta.absent.map((finding) => ({ ...identity, ...finding, kind: "not-observed-in-scan" }));
        const receipt = { ...identity, kind: "scan", scope, findings: findings.length, introduced: delta.introduced.length,
            not_observed: delta.absent.length, unchanged: snapshot === previous.snapshot_id,
            completeness: "best-effort-detectors; absence is not a proven resolution", detector_contract: "registry-inline.v1" };
        if (!appendCapturedData({ cwd: input.cwd, producer: "harness/recurrence-scanner" }, "recurrence-scans", [...records, receipt])) throw new Error("recurrence scan receipt failed");
        return { state: { ...identity, scope, findings }, result: undefined };
    });
}
