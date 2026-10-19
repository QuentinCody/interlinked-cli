import { randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, linkSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { isHookCheckReceipt, parseHookReviewReceipt } from "./hook-coverage-evidence.js";
import { fileStamp, parseHistoryPointer, RecentOffsets, type HookHistoryPointer } from "./hook-coverage-history-log.js";
import { scanLedgerFile } from "./hook-coverage-json-scan.js";

const HISTORY_KEYS: ReadonlySet<string> = new Set(["checks", "reviews"]);
const WRITE_BUFFER_CHARACTERS = 1024 * 1024;

export function hasInlineHistory(raw: Record<string, unknown>): boolean {
    return Object.hasOwn(raw, "checks") || Object.hasOwn(raw, "reviews");
}

/** Validates one legacy element and returns its JSONL row. */
function historyRow(key: string, value: unknown, text: string): string {
    if (key === "checks") { if (!isHookCheckReceipt(value)) throw new Error("Invalid hook check receipts"); }
    else parseHookReviewReceipt(value);
    // Compact legacy elements are already one line; anything else is re-encoded.
    return text.includes("\n") || text.includes("\r") ? JSON.stringify(value) : text;
}

class RowWriter {
    private buffered: string[] = [];
    private characters = 0;
    private bytes = 0;
    private readonly counts = { checks: 0, reviews: 0 };
    private readonly offsets = new RecentOffsets();
    constructor(private readonly descriptor: number) {}
    add(key: string, value: unknown, text: string): void {
        const row = historyRow(key, value, text);
        if (key === "checks") this.counts.checks++; else this.counts.reviews++;
        this.offsets.add(key === "checks" ? "automated_check" : "manual_review", this.bytes);
        this.bytes += Buffer.byteLength(row, "utf8") + 1;
        this.buffered.push(row, "\n");
        this.characters += row.length + 1;
        if (this.characters >= WRITE_BUFFER_CHARACTERS) this.flush();
    }
    pointer(): HookHistoryPointer {
        return { bytes: this.bytes, ...this.counts, recent: this.offsets.recent };
    }
    flush(): void {
        if (this.buffered.length) writeSync(this.descriptor, this.buffered.join(""), null, "utf8");
        this.buffered = []; this.characters = 0;
    }
}

function rejectNonArrayHistory(current: Record<string, unknown>): void {
    if (Object.hasOwn(current, "checks")) throw new Error("Invalid hook check receipts");
    if (Object.hasOwn(current, "reviews")) throw new Error("Invalid hook reviews");
}

function keepBackup(path: string): string {
    const backup = `${path}.legacy-${fileStamp()}`;
    const target = existsSync(backup) ? `${backup}-${randomUUID().slice(0, 8)}` : backup;
    // A hard link keeps the legacy bytes without copying them; copy only where links are refused.
    try { linkSync(path, target); } catch { copyFileSync(path, target, constants.COPYFILE_EXCL); }
    return target;
}

interface Placed { log: string; orphan: string | undefined }

/** The migrated log replaces any uncommitted log; that one is set aside, never deleted. */
function placeLog(temporary: string, log: string): Placed {
    const orphan = existsSync(log) ? `${log}.orphan-${fileStamp()}-${randomUUID().slice(0, 8)}` : undefined;
    if (orphan) renameSync(log, orphan);
    renameSync(temporary, log);
    return { log, orphan };
}

function unplaceLog(placed: Placed): void {
    try {
        unlinkSync(placed.log);
        if (placed.orphan) renameSync(placed.orphan, placed.log);
    } catch (error) {
        // The legacy ledger is still in place, so the next load migrates again.
        void error;
    }
}

export interface LedgerLoad<T> { state: T; migrated: boolean }

/** Loads a ledger file of any size. A legacy file that carries `checks` / `reviews` is split:
 * receipts move to `logPath`, the file is kept as `<path>.legacy-<iso>`, and the state is
 * rewritten without them. Any failure throws and leaves the ledger file and log unchanged. */
export function loadLedgerFile<T>(path: string, logPath: string, build: (current: Record<string, unknown>, history: HookHistoryPointer) => T,
    write: (state: T) => void): LedgerLoad<T> {
    const temporary = `${logPath}.${process.pid}.${randomUUID()}.migrating`;
    const descriptor = openSync(temporary, "wx", 0o600);
    let open = true, placed: Placed | undefined;
    try {
        const writer = new RowWriter(descriptor);
        const scan = scanLedgerFile(path, HISTORY_KEYS, (key, value, text) => writer.add(key, value, text));
        writer.flush();
        const pointer = writer.pointer();
        if (fstatSync(descriptor).size !== pointer.bytes) throw new Error("Migrated history log length does not match its rows");
        closeSync(descriptor); open = false;
        rejectNonArrayHistory(scan.current);
        if (!scan.arrays.length) {
            unlinkSync(temporary);
            return { state: build(scan.current, parseHistoryPointer(scan.current.history)), migrated: false };
        }
        if (Object.hasOwn(scan.current, "history")) throw new Error("Ledger carries both a committed history pointer and inline history");
        const state = build(scan.current, pointer);
        placed = placeLog(temporary, logPath);
        keepBackup(path);
        write(state);
        return { state, migrated: true };
    } catch (error) {
        if (open) closeSync(descriptor);
        if (placed) unplaceLog(placed); else if (existsSync(temporary)) unlinkSync(temporary);
        throw new Error(`Hook coverage ledger migration failed; the previous ledger is unchanged: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
}
