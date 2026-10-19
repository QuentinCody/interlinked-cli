import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, truncateSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { isHookCheckReceipt, parseHookReviewReceipt, type HookCheckReceipt, type HookReviewReceipt } from "./hook-coverage-evidence.js";
import { LIMIT_PER_KIND } from "./hook-coverage-history.js";

/** Byte offsets of the newest rows of each kind, oldest first, at most LIMIT_PER_KIND each. */
export interface HookHistoryRecent { checks: number[]; reviews: number[] }
/** The committed prefix of the append-only history log. The state file names it,
 * so bytes past `bytes` are an append whose state write never landed. `recent` lets
 * status read the newest rows directly, without scanning the log. */
export interface HookHistoryPointer { bytes: number; checks: number; reviews: number; recent: HookHistoryRecent }
export type HookHistoryRow = HookCheckReceipt | HookReviewReceipt;
export interface HookHistoryRows { checks: HookCheckReceipt[]; reviews: HookReviewReceipt[] }
/** `rollback` returns its own failure, if any; bytes it leaves past the pointer stay uncommitted. */
export interface HookHistoryAppend { pointer: HookHistoryPointer; rollback: () => unknown }

const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export function historyLogPath(ledgerPath: string): string {
    return ledgerPath.endsWith(".json") ? `${ledgerPath.slice(0, -".json".length)}-history.jsonl` : `${ledgerPath}-history.jsonl`;
}

export function fileStamp(): string {
    return new Date().toISOString().replace(/:/g, "-");
}

export function emptyHistoryPointer(): HookHistoryPointer {
    return { bytes: 0, checks: 0, reviews: 0, recent: { checks: [], reviews: [] } };
}

function count(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid hook coverage history ${label}`);
    return value;
}

function parseOffsets(raw: unknown, label: string, bytes: number, total: number): number[] {
    if (!Array.isArray(raw) || raw.length > Math.min(LIMIT_PER_KIND, total)) throw new Error(`Invalid hook coverage history recent ${label}`);
    const offsets = raw.map(value => count(value, `recent ${label}`));
    if (offsets.some((offset, index) => offset >= bytes || (index > 0 && offset <= offsets[index - 1]!))) throw new Error(`Invalid hook coverage history recent ${label}`);
    return offsets;
}

export function parseHistoryPointer(raw: unknown): HookHistoryPointer {
    if (raw === undefined) return emptyHistoryPointer();
    if (!isJsonObject(raw) || !isJsonObject(raw.recent)) throw new Error("Invalid hook coverage history pointer");
    const bytes = count(raw.bytes, "bytes"), checks = count(raw.checks, "checks"), reviews = count(raw.reviews, "reviews");
    return { bytes, checks, reviews, recent: { checks: parseOffsets(raw.recent.checks, "checks", bytes, checks),
        reviews: parseOffsets(raw.recent.reviews, "reviews", bytes, reviews) } };
}

export function parseHistoryRow(raw: unknown): HookHistoryRow {
    if (isJsonObject(raw) && raw.kind === "manual_review") return parseHookReviewReceipt(raw);
    if (!isHookCheckReceipt(raw)) throw new Error("Invalid hook check receipts");
    return raw;
}

/** Tracks row offsets while a log grows, keeping only the newest of each kind. */
export class RecentOffsets {
    readonly recent: HookHistoryRecent;
    constructor(start: HookHistoryRecent = { checks: [], reviews: [] }) { this.recent = { checks: [...start.checks], reviews: [...start.reviews] }; }
    add(kind: HookHistoryRow["kind"], offset: number): void {
        const offsets = kind === "manual_review" ? this.recent.reviews : this.recent.checks;
        offsets.push(offset);
        if (offsets.length > LIMIT_PER_KIND) offsets.shift();
    }
}

function sizeOf(path: string): number | undefined {
    try { return statSync(path).size; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

/** The operator repair for a lost or shortened history log (`hook-coverage-ledger.ts repairHistoryLoss`). */
export const HISTORY_REPAIR_COMMAND = "interlinked harness coverage repair-history";

function shortLog(logPath: string, size: number, committed: number): Error {
    return new Error(`Hook coverage history log ${logPath} holds ${size} of ${committed} committed bytes. ` +
        `Run \`${HISTORY_REPAIR_COMMAND}\` to set the partial log aside and start a new history (current state and pending obligations are kept), then restart the daemon`);
}

/** A log shorter than its committed pointer lost evidence; refuse it instead of reporting less. */
export function assertHistoryCommitted(logPath: string, pointer: HookHistoryPointer): void {
    if (pointer.bytes === 0) return;
    const size = sizeOf(logPath) ?? 0;
    if (size < pointer.bytes) throw shortLog(logPath, size, pointer.bytes);
}

/** Drop an uncommitted tail before appending. With nothing committed the bytes were
 * never this ledger's (a crashed migration, an older state file), so keep them aside. */
function prepareAppend(logPath: string, committed: HookHistoryPointer): boolean {
    const size = sizeOf(logPath);
    if (size === undefined) {
        if (committed.bytes) throw new Error(`Hook coverage history log ${logPath} is missing ${committed.bytes} committed bytes`);
        return false;
    }
    if (size < committed.bytes) throw shortLog(logPath, size, committed.bytes);
    if (size === committed.bytes) return true;
    if (committed.bytes) { truncateSync(logPath, committed.bytes); return true; }
    renameSync(logPath, `${logPath}.orphan-${fileStamp()}-${randomUUID().slice(0, 8)}`);
    return false;
}

/** O(rows) append. The caller commits by writing the returned pointer, or rolls back. */
export function appendHistoryRows(logPath: string, committed: HookHistoryPointer, rows: readonly HookHistoryRow[]): HookHistoryAppend {
    mkdirSync(dirname(logPath), { recursive: true });
    const existed = prepareAppend(logPath, committed);
    const rollback = (): unknown => {
        try {
            if (existed) truncateSync(logPath, committed.bytes); else unlinkSync(logPath);
            return undefined;
        } catch (error) { return error; }
    };
    const recent = new RecentOffsets(committed.recent);
    let bytes = committed.bytes;
    const lines = rows.map(row => {
        const line = `${JSON.stringify(row)}\n`;
        recent.add(row.kind, bytes);
        bytes += Buffer.byteLength(line, "utf8");
        return line;
    });
    try {
        const descriptor = openSync(logPath, "a", 0o600);
        try { writeSync(descriptor, lines.join(""), null, "utf8"); } finally { closeSync(descriptor); }
    } catch (error) { rollback(); throw error; }
    const checks = rows.filter(row => row.kind === "automated_check").length;
    return { rollback, pointer: { bytes, checks: committed.checks + checks, reviews: committed.reviews + rows.length - checks, recent: recent.recent } };
}

function readAt(descriptor: number, position: number, length: number): Buffer {
    const chunk = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
        const read = readSync(descriptor, chunk, filled, length - filled, position + filled);
        if (read === 0) throw new Error("Hook coverage history log ended before its committed length");
        filled += read;
    }
    return chunk;
}

function* committedLines(descriptor: number, start: number, bytes: number): Generator<string> {
    let carry: Buffer[] = [];
    for (let offset = start; offset < bytes; offset += READ_CHUNK_BYTES) {
        const chunk = readAt(descriptor, offset, Math.min(READ_CHUNK_BYTES, bytes - offset));
        let begin = 0;
        for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, begin)) {
            carry.push(chunk.subarray(begin, end));
            yield Buffer.concat(carry).toString("utf8");
            carry = []; begin = end + 1;
        }
        if (begin < chunk.length) carry.push(chunk.subarray(begin));
    }
    if (carry.length) throw new Error("Hook coverage history log has an unterminated committed row");
}

function withLog<T>(logPath: string, read: (descriptor: number) => T): T {
    const descriptor = openSync(logPath, "r");
    try { return read(descriptor); } finally { closeSync(descriptor); }
}

function pushRow(rows: HookHistoryRows, row: HookHistoryRow): void {
    if (row.kind === "manual_review") rows.reviews.push(row); else rows.checks.push(row);
}

/** Every committed row, oldest first. Diagnostic and test use: it is O(history). */
export function readHistory(logPath: string, bytes: number): HookHistoryRows {
    const rows: HookHistoryRows = { checks: [], reviews: [] };
    if (!bytes) return rows;
    withLog(logPath, descriptor => { for (const line of committedLines(descriptor, 0, bytes)) pushRow(rows, parseHistoryRow(JSON.parse(line))); });
    return rows;
}

/** First window read for one row; doubled until the row's newline is seen.
 * A status call reads up to 2 × LIMIT_PER_KIND rows, so each read must cost the
 * row, not a streaming chunk (the 1 MiB chunk made status O(rows × 1 MiB)). */
const ROW_WINDOW_BYTES = 4 * 1024;

/** The committed row starting at `offset`, read in a bounded window. */
function lineAt(descriptor: number, offset: number, bytes: number): string {
    const available = bytes - offset;
    if (available <= 0) throw new Error(`Hook coverage history has no row at byte ${offset}`);
    for (let length = Math.min(ROW_WINDOW_BYTES, available); ; length = Math.min(length * 2, available)) {
        const chunk = readAt(descriptor, offset, length);
        const end = chunk.indexOf(NEWLINE);
        if (end !== -1) return chunk.subarray(0, end).toString("utf8");
        if (length === available) throw new Error("Hook coverage history log has an unterminated committed row");
    }
}

function rowAt(descriptor: number, offset: number, bytes: number, kind: HookHistoryRow["kind"]): HookHistoryRow {
    const row = parseHistoryRow(JSON.parse(lineAt(descriptor, offset, bytes)));
    if (row.kind !== kind) throw new Error(`Hook coverage history row at byte ${offset} is not ${kind}`);
    return row;
}

/** The newest rows of each kind, oldest first, read at their recorded offsets: O(returned rows). */
export function readRecentHistory(logPath: string, pointer: HookHistoryPointer): HookHistoryRows {
    if (!pointer.bytes) return { checks: [], reviews: [] };
    return withLog(logPath, descriptor => ({
        checks: pointer.recent.checks.map(offset => rowAt(descriptor, offset, pointer.bytes, "automated_check") as HookCheckReceipt),
        reviews: pointer.recent.reviews.map(offset => rowAt(descriptor, offset, pointer.bytes, "manual_review") as HookReviewReceipt),
    }));
}
