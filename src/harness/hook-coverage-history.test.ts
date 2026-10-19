import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlHookCoverage, isHookCoverageReport } from "./hook-coverage-control.js";
import { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import type { HookCheckReceipt } from "./hook-coverage-evidence.js";
import { recentHistory } from "./hook-coverage-history.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(count: number, large = false) {
    const root = mkdtempSync(join(tmpdir(), "hook-status-history-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "package.json"), "{}");
    const first = startHookFilesystemWatch({ root, reservations: () => [] });
    first.stop();
    const state = first.ledger.snapshot();
    const checks: HookCheckReceipt[] = Array.from({ length: count }, (_, index) => ({
        id: `receipt-${index}`, path: "old.ts", identity: String(index), policyDigest: "old", policyGeneration: 0,
        checks: ["lint"], findings: [], kind: "automated_check", checkedAt: "2026-10-06T00:00:00Z",
    }));
    if (large) checks.push({ ...checks[0]!, id: "oversized", findings: ["x".repeat(2 * 1024 * 1024)] });
    const reviews = Array.from({ length: count }, (_, index) => ({ id: `review-${index}`, path: "old.ts", identity: String(index),
        evidence: "human review", reviewedAt: "2026-10-06T00:00:00Z", kind: "manual_review" as const }));
    const path = join(root, ".interlinked", "hook-coverage.json");
    writeFileSync(path, JSON.stringify({ ...state, checks, reviews }));
    // Loading migrates the legacy inline history once; status must not write after that.
    const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
    cleanups.push(watcher.stop);
    return { path, before: readFileSync(path, "utf8"), watcher };
}

// Incident: one status response serialized 103 MB and raised RSS from 492 MB to 1.38 GB.
describe("coverage status retained history bounds", () => {
    it("bounds aggregate encoded bytes, including nested scopes and escaped or multibyte strings", () => {
        const rows = Array.from({ length: 90 }, (_, id) => ({ id, scopes: [{ inputs: ["\u0000\ud800😀".repeat(4096)] }] }));
        const result = recentHistory(rows);
        expect(Buffer.byteLength(JSON.stringify(result.rows))).toBeLessThanOrEqual(1024 * 1024);
        expect(result.counts.returned).toBeGreaterThan(0);
        expect(result.counts.omitted).toBeGreaterThan(0);
        expect(result.counts.returned + result.counts.omitted).toBe(90);
        expect(rows).toHaveLength(90);
    });

    it("returns at most 100 recent receipts of each kind and reports exactly what was omitted", () => {
        const { path, before, watcher } = fixture(250);
        const report = controlHookCoverage(watcher, { operation: "status" });
        expect(report.checks).toHaveLength(100);
        expect(report.reviews).toHaveLength(100);
        expect(report.checks?.[0]?.id).toBe("receipt-249");
        expect(report.reviews?.[0]?.id).toBe("review-249");
        expect(report.history).toMatchObject({ order: "newest_first", ledgerPath: path,
            checks: { total: 250, returned: 100, omitted: 150 }, reviews: { total: 250, returned: 100, omitted: 150 } });
        expect(isHookCoverageReport(JSON.parse(JSON.stringify(report)))).toBe(true);
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(watcher.ledger.snapshot().checks).toHaveLength(250);
    });

    it("never clones the whole ledger to answer status, including policy mutation responses", () => {
        const { watcher } = fixture(5);
        vi.spyOn(watcher.ledger, "snapshot").mockImplementation(() => { throw new Error("unbounded history clone"); });
        const report = controlHookCoverage(watcher, { operation: "status" });
        expect(report.pending).toHaveLength(1);
        expect(report.checks).toHaveLength(5);
        expect(controlHookCoverage(watcher, { operation: "accept_policy", digest: watcher.ledger.policyDigest() }).changed).toBe(true);
        report.checks?.[0]?.findings.push("caller change");
        expect(controlHookCoverage(watcher, { operation: "status" }).checks?.[0]?.findings).toEqual([]);
    });

    it("omits an oversized receipt without hiding pending work or losing its on-disk evidence", () => {
        const { path, before, watcher } = fixture(2, true);
        const report = controlHookCoverage(watcher, { operation: "status" });
        expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(1024 * 1024);
        expect(report.pending).toHaveLength(1);
        expect(report.history?.checks).toMatchObject({ total: 3, returned: 2, omitted: 1 });
        expect(report.checks?.some(row => row.id === "oversized")).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(watcher.ledger.snapshot().checks.some(row => row.id === "oversized")).toBe(true);
    });
});
