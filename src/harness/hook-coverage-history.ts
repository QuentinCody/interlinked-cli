import { isJsonObject } from "../lib/json-types.js";
import { wireLiteral, wireNumber, wireObject, wireString } from "../lib/value-validation.js";

const LIMIT_PER_KIND = 100;
const MAX_BYTES_PER_KIND = 1024 * 1024;
interface HistoryCounts { total: number; returned: number; omitted: number }
export interface HookCoverageHistory {
    order: "newest_first";
    ledgerPath: string;
    limitPerKind: number;
    maxBytesPerKind: number;
    checks: HistoryCounts;
    reviews: HistoryCounts;
}
const counts = wireObject<HistoryCounts>({ total: wireNumber, returned: wireNumber, omitted: wireNumber });
export const isHookCoverageHistory = wireObject<HookCoverageHistory>({
    order: wireLiteral("newest_first"), ledgerPath: wireString, limitPerKind: wireNumber,
    maxBytesPerKind: wireNumber, checks: counts, reviews: counts,
});

function* objectParts(value: Record<string, unknown>): Generator<unknown> {
    for (const [key, entry] of Object.entries(value)) { yield key; yield entry; }
}

function containerBudget(parts: Iterable<unknown>, remaining: number): number {
    let bytes = 2;
    for (const part of parts) {
        bytes += 2 + jsonBudget(part, remaining - bytes);
        if (bytes > remaining) break;
    }
    return bytes;
}

/** Conservative JSON size, stopping at the budget without serializing a huge row.
 * Each UTF-16 code unit needs at most six bytes as a JSON escape. */
function jsonBudget(value: unknown, remaining: number): number {
    if (remaining <= 0) return 1;
    if (typeof value === "string") return 2 + value.length * 6;
    if (Array.isArray(value)) return containerBudget(value, remaining);
    if (isJsonObject(value)) return containerBudget(objectParts(value), remaining);
    return 32;
}

/** Bound both candidate work and returned bytes. Omitted rows remain in the ledger. */
export function recentHistory<T>(rows: readonly T[]): { rows: T[]; counts: HistoryCounts } {
    const selected: T[] = [];
    let remaining = MAX_BYTES_PER_KIND - 2;
    for (let index = rows.length - 1; index >= Math.max(0, rows.length - LIMIT_PER_KIND); index--) {
        const row = rows[index];
        if (row === undefined) continue;
        const bytes = 1 + jsonBudget(row, remaining);
        if (bytes > remaining) continue;
        selected.push(row);
        remaining -= bytes;
    }
    return { rows: structuredClone(selected), counts: { total: rows.length, returned: selected.length, omitted: rows.length - selected.length } };
}

export function historySummary(ledgerPath: string, checks: HistoryCounts, reviews: HistoryCounts): HookCoverageHistory {
    return { order: "newest_first", ledgerPath, limitPerKind: LIMIT_PER_KIND, maxBytesPerKind: MAX_BYTES_PER_KIND, checks, reviews };
}
