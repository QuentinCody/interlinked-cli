import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { appendCapturedData, recordCaptureReceipt } from "../lib/data/capture.js";
import { dataRecordHash } from "../lib/data/normalize.js";
import { updateCaptureStateAt } from "../lib/data/state.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { candidateScore } from "./suggestion-candidate-scores.js";
import type { Finding } from "./suggestion-scorer.js";

export interface SuggestionTelemetryOptions {
    interlinkedDir: string; sessionId: string; agentName: string; filePath: string; threshold: number;
}
function findingId(finding: Finding, file: string): string {
    return dataRecordHash(JSON.stringify([file, finding.check, finding.line, finding.message]));
}
function candidateRow(finding: Finding, shown: Set<string>, options: SuggestionTelemetryOptions): JsonObject {
    const score = candidateScore(finding);
    const id = findingId(finding, options.filePath);
    return { finding_id: id, check: finding.check, line: finding.line, file: options.filePath,
        message: finding.message.slice(0, 200), message_full: finding.message, full_message_hash: dataRecordHash(finding.message),
        score: score?.score ?? null, score_status: score ? "measured" : "not-measured",
        suppressed: score?.suppressed ?? null, shown: shown.has(id), outcome: null, threshold: options.threshold,
        delivery_status: shown.has(id) ? "selected-for-presentation" : "not-selected", acknowledgement: "not-measured" };
}
function candidateSummaries(rows: JsonObject[]): JsonObject[] {
    const groups = new Map<string, { candidates: number; shown: number; scored: number; score_sum: number }>();
    for (const row of rows) {
        const key = String(row.check);
        const group = groups.get(key) ?? { candidates: 0, shown: 0, scored: 0, score_sum: 0 };
        group.candidates++; group.shown += Number(row.shown === true);
        if (typeof row.score === "number") { group.scored++; group.score_sum += row.score; }
        groups.set(key, group);
    }
    return [...groups].map(([check, group]) => ({ check, ...group }));
}
function observedOutcomes(previous: JsonObject, current: JsonObject[], identity: JsonObject): JsonObject[] {
    const old = Array.isArray(previous.candidates) ? previous.candidates.filter(isJsonObject) : [];
    const byId = new Map(current.map((row) => [row.finding_id, row]));
    return old.map((row) => {
        const next = byId.get(row.finding_id);
        let outcome = "not_observed";
        if (next) outcome = next.suppressed === true ? "suppressed" : "still_present";
        return { ...identity, finding_id: row.finding_id, check: row.check, file: row.file,
            previous_scan_id: previous.scan_id, outcome, basis: "next same-session file suggestion scan; not a causal fix claim" };
    });
}

export function writeSuggestionTelemetry(all: Finding[], shown: Finding[], options: SuggestionTelemetryOptions): void {
    const context = { cwd: dirname(options.interlinkedDir), dataDir: options.interlinkedDir,
        producer: "harness/suggestion-scorer", session: options.sessionId };
    try {
        const shownIds = new Set(shown.map((finding) => findingId(finding, options.filePath)));
        const identity = { ts: new Date().toISOString(), scan_id: randomUUID(), session_id: options.sessionId, agent_name: options.agentName, file: options.filePath };
        const rows = all.map((finding) => ({ ...identity, ...candidateRow(finding, shownIds, options) }));
        if (!appendCapturedData(context, "suggestion-telemetry", rows)) return;
        appendCapturedData(context, "suggestion-summaries", candidateSummaries(rows).map((row) => ({ ...identity, ...row })));
        updateCaptureStateAt(options.interlinkedDir, `suggestions:${options.sessionId}:${options.filePath}`, (previous) => {
            const outcomes = observedOutcomes(previous, rows, identity);
            if (!appendCapturedData(context, "suggestion-outcomes", outcomes)) throw new Error("outcome-write-failed");
            return { state: { ...identity, candidates: rows }, result: undefined };
        });
    } catch {
        recordCaptureReceipt(context, { source: "suggestion-telemetry", status: "failed", error: "candidate-state-or-write-failed" });
    }
}
