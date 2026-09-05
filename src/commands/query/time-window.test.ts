import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataTimestampMs } from "../../lib/data-time.js";
import { runQuery } from "../query.js";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function queryRows(rows: Record<string, unknown>[]) {
    const root = mkdtempSync(join(tmpdir(), "interlinked-time-window-"));
    roots.push(root);
    const file = join(root, "events.jsonl");
    writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return runQuery(file, {
        clauses: [], budget: { maxRecords: 100, maxBytes: 1024 * 1024 },
        limit: 100, sinceMs: Date.parse("2026-09-05T00:00:00Z"),
    });
}

describe("event-time filtering of append order", () => {
    it("retains newer evidence preceding a late historical backfill", () => {
        const result = queryRows([
            { ts: "2026-09-05T10:00:00Z", id: "earlier-append" },
            { ts: "2024-01-01T00:00:00Z", id: "late-backfill" },
            { ts: "2026-09-05T11:00:00Z", id: "latest-append" },
        ]);
        expect(result.rows.map((row) => row.id)).toEqual(["earlier-append", "latest-append"]);
        expect(result.stats.recordsParsed).toBe(3);
        expect(result.sinceStopped).toBe(false);
    });

    it("filters numeric daemon timestamps and excludes undated evidence from a time window", () => {
        const result = queryRows([
            { at: Date.parse("2026-09-04T12:00:00Z"), id: "old" },
            { at: Date.parse("2026-09-05T12:00:00Z"), id: "new" },
            { id: "unknown" },
        ]);
        expect(result.rows.map((row) => row.id)).toEqual(["new"]);
    });

    it("uses explicit source units and accepts all retained ledger timestamp names", () => {
        expect(dataTimestampMs({ epoch: 1000 }, [{ path: "epoch", unit: "seconds" }])).toBe(1000000);
        for (const field of ["atMs", "emitted_at", "reconciled_at", "measuredAt"]) {
            expect(dataTimestampMs({ [field]: "2026-09-05T12:00:00Z" })).toBe(1788609600000);
        }
        expect(dataTimestampMs({ ts: "invalid", timestamp: "2026-09-05T12:00:00Z" })).toBe(1788609600000);
        expect(dataTimestampMs({ ts: "123" })).toBeUndefined();
        expect(dataTimestampMs({ at: Number.POSITIVE_INFINITY })).toBeUndefined();
    });
});
