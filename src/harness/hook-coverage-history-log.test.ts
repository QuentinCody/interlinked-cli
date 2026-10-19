import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Bytes requested by every `readSync` the module under test issues (N0). */
const reads = vi.hoisted(() => ({ lengths: [] as number[] }));
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    const readSync = (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | bigint | null): number => {
        reads.lengths.push(length);
        return actual.readSync(fd, buffer, offset, length, position);
    };
    return { ...actual, readSync };
});
import type { HookCheckReceipt, HookReviewReceipt } from "./hook-coverage-evidence.js";
import { appendHistoryRows, assertHistoryCommitted, emptyHistoryPointer, historyLogPath, parseHistoryPointer, readHistory, readRecentHistory,
    type HookHistoryPointer } from "./hook-coverage-history-log.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function logPath(): string {
    const root = mkdtempSync(join(tmpdir(), "hook-history-log-"));
    roots.push(root);
    return join(root, "hook-coverage-history.jsonl");
}
const check = (id: string, findings: string[] = []): HookCheckReceipt => ({ id, path: "a.ts", identity: "v1", policyDigest: "d", policyGeneration: 0,
    checks: ["lint"], findings, checkedAt: "2026-10-10T00:00:00Z", kind: "automated_check" });
const review = (id: string): HookReviewReceipt => ({ id, path: "a.ts", identity: "v1", evidence: "read it", reviewedAt: "2026-10-10T00:00:00Z", kind: "manual_review" });
const empty = emptyHistoryPointer();
const lost: HookHistoryPointer = { bytes: 10, checks: 1, reviews: 0, recent: { checks: [0], reviews: [] } };

describe("hook coverage history log — positive (must fire)", () => {
    it("P1: names the sibling log of a ledger path", () => {
        expect(historyLogPath("/r/.interlinked/hook-coverage.json")).toBe("/r/.interlinked/hook-coverage-history.jsonl");
        expect(historyLogPath("/r/ledger")).toBe("/r/ledger-history.jsonl");
    });

    it("P2: appends one row per receipt and counts each kind in the returned pointer", () => {
        const path = logPath();
        const first = appendHistoryRows(path, empty, [check("c1"), review("r1")]).pointer;
        const second = appendHistoryRows(path, first, [check("c2")]).pointer;
        const firstRow = Buffer.byteLength(`${JSON.stringify(check("c1"))}\n`);
        expect(second).toEqual({ bytes: statSync(path).size, checks: 2, reviews: 1, recent: { checks: [0, first.bytes], reviews: [firstRow] } });
        expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(3);
        expect(readHistory(path, second.bytes)).toEqual({ checks: [check("c1"), check("c2")], reviews: [review("r1")] });
    });

    it("P3: truncates an uncommitted tail before the next append, and rollback restores the committed length", () => {
        const path = logPath();
        const committed = appendHistoryRows(path, empty, [check("c1")]).pointer;
        appendFileSync(path, `${JSON.stringify(check("crashed"))}\n`);
        const next = appendHistoryRows(path, committed, [check("c2")]);
        expect(readHistory(path, next.pointer.bytes).checks.map(row => row.id)).toEqual(["c1", "c2"]);
        next.rollback();
        expect(statSync(path).size).toBe(committed.bytes);
    });

    it("P4: sets aside bytes no committed pointer owns instead of deleting them", () => {
        const path = logPath();
        writeFileSync(path, `${JSON.stringify(check("foreign"))}\n`);
        const pointer = appendHistoryRows(path, empty, [check("c1")]).pointer;
        expect(readHistory(path, pointer.bytes).checks.map(row => row.id)).toEqual(["c1"]);
        expect(readdirSync(join(path, "..")).filter(name => name.includes(".orphan-"))).toHaveLength(1);
    });

    it("P5: reads the newest rows of each kind at their recorded offsets, however old the oldest review is", () => {
        const path = logPath();
        let pointer = empty;
        for (let index = 0; index < 150; index++) pointer = appendHistoryRows(path, pointer, [check(`c${index}`), ...(index % 50 === 0 ? [review(`r${index}`)] : [])]).pointer;
        expect(pointer.recent.checks).toHaveLength(100);
        const recent = readRecentHistory(path, pointer);
        expect(recent.checks).toHaveLength(100);
        expect(recent.checks[0]!.id).toBe("c50");
        expect(recent.checks.at(-1)!.id).toBe("c149");
        expect(recent.reviews.map(row => row.id)).toEqual(["r0", "r50", "r100"]);
        expect(parseHistoryPointer(JSON.parse(JSON.stringify(pointer)))).toEqual(pointer);
    });

    it("P6: refuses a log shorter than its committed pointer, and offsets past or out of order", () => {
        const path = logPath();
        expect(() => assertHistoryCommitted(path, lost)).toThrow("0 of 10 committed bytes");
        expect(() => appendHistoryRows(path, lost, [check("c1")])).toThrow("missing 10 committed bytes");
        expect(() => parseHistoryPointer({ ...lost, bytes: -1 })).toThrow("history bytes");
        expect(() => parseHistoryPointer({ ...lost, recent: { checks: [10], reviews: [] } })).toThrow("recent checks");
        expect(() => parseHistoryPointer({ ...lost, checks: 2, recent: { checks: [5, 5], reviews: [] } })).toThrow("recent checks");
        expect(() => parseHistoryPointer({ bytes: 10, checks: 1, reviews: 0 })).toThrow("history pointer");
    });
});

describe("hook coverage history log — negative (must not fire)", () => {
    it("N0: reading the recent rows of a log whose rows are each followed by more than a window costs the rows, not a chunk per row", () => {
        // 2026-10-15 review: rowAt started a 1 MiB streaming chunk per row, so a
        // status call over 200 recorded offsets read ~200 MiB.
        const path = logPath();
        let pointer = empty;
        for (let index = 0; index < 120; index++) pointer = appendHistoryRows(path, pointer, [check(`c${index}`, ["f".repeat(20 * 1024)])]).pointer;
        expect(statSync(path).size).toBeGreaterThan(2 * 1024 * 1024);
        reads.lengths.length = 0;
        const recent = readRecentHistory(path, pointer);
        expect(recent.checks.map(row => row.id).slice(0, 2)).toEqual(["c20", "c21"]);
        expect(recent.checks).toHaveLength(100);
        const total = reads.lengths.reduce((sum, length) => sum + length, 0);
        expect(reads.lengths.length).toBeGreaterThan(0);
        expect(total).toBeLessThan(100 * 64 * 1024);
    });

    it("N1: ignores bytes past the committed pointer when reading", () => {
        const path = logPath();
        const pointer = appendHistoryRows(path, empty, [check("c1")]).pointer;
        appendFileSync(path, "not json\n");
        expect(readHistory(path, pointer.bytes).checks.map(row => row.id)).toEqual(["c1"]);
        expect(readRecentHistory(path, pointer).checks.map(row => row.id)).toEqual(["c1"]);
        expect(() => assertHistoryCommitted(path, pointer)).not.toThrow();
    });

    it("N2: an empty pointer reads nothing and needs no log file", () => {
        const path = logPath();
        expect(readHistory(path, 0)).toEqual({ checks: [], reviews: [] });
        expect(readRecentHistory(path, empty)).toEqual({ checks: [], reviews: [] });
        expect(parseHistoryPointer(undefined)).toEqual(empty);
    });
});
