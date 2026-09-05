import { appendCapturedData } from "../../lib/data/capture.js";
import { dataRecordHash } from "../../lib/data/normalize.js";
import type { SpecDriftFinding } from "../spec/ledger.js";
import type { SessionTrajectory } from "../types.js";

export function captureSpecDrift(cwd: string, rel: string, all: SpecDriftFinding[], session: SessionTrajectory): void {
    const prior = new Set((session.spec_drift_outstanding ?? []).map((finding) => `${finding.file}:${finding.line}:${finding.message}`));
    const rows = all.map((finding) => ({ ...finding, ts: new Date().toISOString(),
        finding_id: dataRecordHash(JSON.stringify(finding)), scope: "repository" as const,
        relation: finding.file === rel || finding.relatedFiles.includes(rel) ? "edited-file" as const : "other-file" as const,
        observation: prior.has(`${finding.file}:${finding.line}:${finding.message.slice(0, 200)}`) ? "previously-observed" as const : "first-observed" as const,
        introduced_by_session: "unknown", related_files: finding.relatedFiles }));
    appendCapturedData({ cwd, producer: "harness/server/spec-ledger-phase", session: session.session_id }, "spec-drift", rows);
    session.spec_drift_outstanding = rows.slice(0, 10).map((row) => ({ file: row.file, line: row.line,
        message: row.message.slice(0, 200), scope: row.scope, relation: row.relation, observation: row.observation, related_files: row.related_files }));
}
