import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CatalogueFinding } from "./catalogue-types.js";
import { readTouchedLedger } from "../../harness/session-touched-files.js";

const SUMMARY_LOG_BYTES = 8 * 1024 * 1024;
export interface BoundedLog {
    rows: Record<string, unknown>[];
    truncated: boolean;
    bytes: number;
    malformed: number;
    available: boolean;
}
export function readBoundedLog(path: string, limit = SUMMARY_LOG_BYTES): BoundedLog {
    const result: BoundedLog = { rows: [], truncated: false, bytes: 0, malformed: 0, available: false };
    let fd: number | undefined;
    try {
        fd = openSync(path, "r");
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - limit);
        const buffer = Buffer.alloc(size - start);
        let bytes = 0;
        while (bytes < buffer.length) {
            const n = readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes);
            if (!n) break;
            bytes += n;
        }
        result.available = true; result.bytes = bytes; result.truncated = start > 0;
        const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
        if (start > 0) lines.shift();
        if (lines.pop()) result.malformed++;
        for (const line of lines) {
            if (!line) continue;
            try {
                const value: unknown = JSON.parse(line);
                if (value && typeof value === "object" && !Array.isArray(value)) result.rows.push(value as Record<string, unknown>);
                else result.malformed++;
            } catch { result.malformed++; }
        }
    } catch { result.available = false; }
    finally { if (fd !== undefined) closeSync(fd); }
    return result;
}

export interface SummaryEvidence {
    session: string;
    message: string;
    diffPaths: string[];
    complete: boolean;
    root: string;
    basis?: "touched-files" | "net-diff";
    mentionsComplete?: boolean;
    at?: number;
}
function repositoryPath(path: string, root: string): string | null {
    const value = path.replace(/:\d+(?::\d+)?$/, "").replaceAll("\\", "/");
    const rel = isAbsolute(value) ? relative(root, value).replaceAll("\\", "/") : value.replace(/^\.\//, "");
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
    return rel;
}
function* summaryProse(message: string) {
    let fence: string | undefined;
    for (const [index, line] of message.split(/\r?\n/).entries()) {
        const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (delimiter) {
            if (!fence) fence = delimiter;
            else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
            continue;
        }
        if (fence) continue;
        yield { index, line };
    }
}

function summaryMentions(message: string, root: string): Map<string, number> {
    const mentioned = new Map<string, number>();
    for (const { index, line } of summaryProse(message)) {
        // URLs are references, not repository paths. Preserve offsets for evidence.
        const localText = line.replace(/https?:\/\/[^\s)<>]+/g, value => " ".repeat(value.length));
        for (const match of localText.matchAll(/(?<![\w@])(?:[A-Za-z]:)?(?:\.{0,2}\/|\/)?(?:[\w.@-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]*(?::\d+(?::\d+)?)?/g)) {
            const path = repositoryPath(match[0], root);
            if (path !== null) mentioned.set(path, index + 1);
        }
    }
    return mentioned;
}

/** File mentions are an advisory coverage proxy, not a claim that every mention says "changed". */
export function checkSummaryFileCoverage(input: SummaryEvidence): CatalogueFinding[] {
    if (!input.complete || !input.session || !input.message.trim()) return [];
    const changed = new Set(input.diffPaths.map(path => repositoryPath(path, input.root)).filter((path): path is string => path !== null));
    const mentioned = summaryMentions(input.message, input.root);
    const findings: CatalogueFinding[] = [];
    const population = input.basis === "touched-files" ? "touched-file ledger" : "recorded diff";
    for (const [path, line] of mentioned) if (input.mentionsComplete !== false && !changed.has(path)) findings.push({ check: "summary_file_coverage", file: path, line: 1,
        message: `Final message mentions ${path}, outside this session's ${population}. It may be a contextual reference.`, evidence: `${input.session}: message line ${line}` });
    for (const path of changed) if (!mentioned.has(path)) findings.push({ check: "summary_file_coverage", file: path, line: 1,
        message: `Final message does not name ${path}, which is in this session's ${population}.`, evidence: input.session });
    return findings;
}

export function touchedSummaryEvidence(root: string, session: string, message: string, until?: number): SummaryEvidence {
    const ledger = readTouchedLedger(root, session, until);
    return { root, session, message, diffPaths: [...new Set(ledger.rows.map(row => row.path))], complete: ledger.available,
        mentionsComplete: ledger.complete, basis: "touched-files" };
}

type TouchRow = Record<string, unknown>;
type Change = { before: string | null; after: string | null };

function fileChange(row: TouchRow, root: string): { path: string; change: Change } | null {
    if (row.observation_complete !== true || typeof row.path !== "string") return null;
    const before = row.before_sha256, after = row.after_sha256;
    if (!(before === null || typeof before === "string") || !(after === null || typeof after === "string")) return null;
    const path = repositoryPath(row.path, root);
    return path ? { path, change: { before, after } } : null;
}

function netChanges(rows: TouchRow[], root: string) {
    const chains = new Map<string, Change>();
    let continuous = true;
    for (const row of rows) {
        const entry = fileChange(row, root);
        if (!entry) { continuous = false; continue; }
        const { path, change } = entry;
        const prior = chains.get(path);
        if (prior && prior.after !== change.before) continuous = false;
        chains.set(path, { before: prior ? prior.before : change.before, after: change.after });
    }
    const diffPaths = [...chains].filter(([, change]) => change.before !== change.after).map(([path]) => path);
    return { continuous, diffPaths };
}

/** A net diff needs complete observations and a continuous before/after chain. */
export function summaryEvidenceFromLogs(root: string, activity: BoundedLog, touches: BoundedLog): SummaryEvidence[] {
    const starts = new Map<string, number>();
    for (const row of activity.rows) {
        if (row.type !== "session_start" || typeof row.session !== "string") continue;
        const time = Date.parse(String(row.ts));
        if (Number.isFinite(time)) starts.set(row.session, Math.min(time, starts.get(row.session) ?? Infinity));
    }
    const observations = new Map<string, TouchRow[]>();
    for (const row of touches.rows) {
        if (typeof row.session_id !== "string") continue;
        const prior = observations.get(row.session_id);
        if (prior) prior.push(row);
        else observations.set(row.session_id, [row]);
    }
    const logComplete = activity.available && touches.available && !activity.malformed && !touches.malformed && !touches.truncated;
    const stops = activity.rows.filter(row => row.type === "agent_stop" && row.dry_run !== true && typeof row.session === "string");
    return stops.map(stop => {
        const session = String(stop.session), stopTime = Date.parse(String(stop.ts));
        const startTime = starts.get(session) ?? NaN;
        const rows = (observations.get(session) ?? []).filter(row => {
            const at = Date.parse(String(row.ts));
            return Number.isFinite(at) && at >= startTime && at <= stopTime;
        });
        const { diffPaths, continuous } = netChanges(rows, root);
        return { session, at: stopTime, message: typeof stop.last_assistant_message === "string" ? stop.last_assistant_message : "",
            diffPaths, complete: logComplete && rows.length > 0 && continuous, root: resolve(root) };
    });
}
