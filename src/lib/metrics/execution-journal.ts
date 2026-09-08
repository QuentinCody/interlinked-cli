import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { record, natural, stringList, textField } from "./evidence-json.js";

export interface MeasurementExecution {
    schemaVersion: 1; gate: string; at: string; sessionId: string; inputFingerprint: string;
    file: string; sourceHash: string; scope: string[]; elapsedMs: number;
    outcome: "measured" | "failed" | "unavailable" | "deferred"; reason: string;
    testsPassed: boolean | null;
}
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
function journalPath(root: string): string { return join(root, ".interlinked", "metrics", "executions.jsonl"); }
export function appendMeasurementExecution(root: string, entry: MeasurementExecution): void {
    const directory = join(root, ".interlinked", "metrics");
    mkdirSync(directory, { recursive: true });
    appendFileSync(journalPath(root), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
function tail(path: string): { content: string; truncated: boolean } {
    const size = statSync(path).size, length = Math.min(size, MAX_TAIL_BYTES), buffer = Buffer.alloc(length), descriptor = openSync(path, "r");
    try { readSync(descriptor, buffer, 0, length, size - length); }
    finally { closeSync(descriptor); }
    const text = buffer.toString("utf8");
    return { content: size > length ? text.slice(text.indexOf("\n") + 1) : text, truncated: size > length };
}
function parseExecution(value: unknown): MeasurementExecution {
    const row = record(value, "measurement execution");
    if (row.schemaVersion !== 1) throw new Error("Unsupported measurement execution version");
    if (row.outcome !== "measured" && row.outcome !== "failed" && row.outcome !== "unavailable" && row.outcome !== "deferred") throw new Error("Invalid execution outcome");
    if (row.testsPassed !== null && typeof row.testsPassed !== "boolean") throw new Error("Invalid test execution state");
    return { schemaVersion: 1, gate: textField(row.gate, "gate"), at: textField(row.at, "at"), sessionId: textField(row.sessionId, "sessionId"),
        inputFingerprint: textField(row.inputFingerprint, "inputFingerprint"), file: textField(row.file, "file"), sourceHash: textField(row.sourceHash, "sourceHash"),
        scope: stringList(row.scope, "scope"), elapsedMs: natural(row.elapsedMs, "elapsedMs"), outcome: row.outcome, testsPassed: row.testsPassed, reason: typeof row.reason === "string" ? row.reason : "" };
}
export function readMeasurementExecutions(root: string): { entries: MeasurementExecution[]; issues: string[]; present: boolean } {
    const entries: MeasurementExecution[] = [], issues: string[] = [], path = journalPath(root);
    if (!existsSync(path)) return { entries, issues, present: false };
    try {
        const result = tail(path);
        if (result.truncated) issues.push("Execution history limited to last 8 MiB");
        for (const line of result.content.split("\n").filter(Boolean)) {
            try { entries.push(parseExecution(JSON.parse(line))); } catch { issues.push("Malformed execution record"); }
        }
    } catch { issues.push("Execution journal unreadable"); }
    return { entries, issues, present: true };
}
