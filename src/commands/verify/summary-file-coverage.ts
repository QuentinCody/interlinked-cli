import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CatalogueFinding } from "./catalogue-types.js";
import { readTouchedLedger } from "../../harness/session-touched-files.js";

export const SUMMARY_LOG_BYTES = 8 * 1024 * 1024;
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
/** File mentions are an advisory coverage proxy, not a claim that every mention says "changed". */
export function checkSummaryFileCoverage(input: SummaryEvidence): CatalogueFinding[] {
    if (!input.complete || !input.session || !input.message.trim()) return [];
    const changed = new Set(input.diffPaths.map(path => repositoryPath(path, input.root)).filter((path): path is string => path !== null));
    const mentioned = new Map<string, number>();
    let fence: string | undefined;
    for (const [index, line] of input.message.split(/\r?\n/).entries()) {
        const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (delimiter) {
            if (!fence) fence = delimiter;
            else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
            continue;
        }
        if (fence) continue;
        // URLs are references, not repository paths. Preserve offsets for evidence.
        const localText = line.replace(/https?:\/\/[^\s)<>]+/g, value => " ".repeat(value.length));
        for (const match of localText.matchAll(/(?<![\w@])(?:[A-Za-z]:)?(?:\.{0,2}\/|\/)?(?:[\w.@-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]*(?::\d+(?::\d+)?)?/g)) {
            const path = repositoryPath(match[0], input.root);
            if (path !== null) mentioned.set(path, index + 1);
        }
    }
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

/** A net diff needs complete observations and a continuous before/after chain. */
export function summaryEvidenceFromLogs(root: string, activity: BoundedLog, touches: BoundedLog): SummaryEvidence[] {
    const stops = activity.rows.filter(row => row.type === "agent_stop" && row.dry_run !== true && typeof row.session === "string");
    return stops.map(stop => {
        const session = String(stop.session);
        const stopTime = Date.parse(String(stop.ts));
        const starts = activity.rows.filter(row => row.type === "session_start" && row.session === session && Date.parse(String(row.ts)) <= stopTime);
        const startTime = starts.length ? Math.min(...starts.map(row => Date.parse(String(row.ts)))) : NaN;
        const rows = touches.rows.filter(row => row.session_id === session && Date.parse(String(row.ts)) >= startTime && Date.parse(String(row.ts)) <= stopTime);
        let complete = activity.available && touches.available && !activity.malformed && !touches.malformed
            && Number.isFinite(startTime) && rows.length > 0;
        const chains = new Map<string, { before: string | null; after: string | null }>();
        for (const row of rows) {
            if (row.observation_complete !== true || typeof row.path !== "string"
                || !(typeof row.before_sha256 === "string" || row.before_sha256 === null)
                || !(typeof row.after_sha256 === "string" || row.after_sha256 === null)) { complete = false; continue; }
            const path = repositoryPath(row.path, root);
            if (!path) { complete = false; continue; }
            const prior = chains.get(path);
            if (prior && prior.after !== row.before_sha256) complete = false;
            chains.set(path, { before: prior ? prior.before : row.before_sha256, after: row.after_sha256 });
        }
        // Truncated touch tails cannot establish that every session write was observed.
        if (touches.truncated) complete = false;
        return { session, at: stopTime, message: typeof stop.last_assistant_message === "string" ? stop.last_assistant_message : "",
            diffPaths: [...chains].filter(([, value]) => value.before !== value.after).map(([path]) => path), complete, root: resolve(root) };
    });
}
