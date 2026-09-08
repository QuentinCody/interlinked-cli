import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { controlHookCoverage, isHookCoverageReport, isHookCoverageRequest } from "./hook-coverage-control.js";
import { startHookFilesystemWatch } from "./hook-filesystem-watch.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "hook-control-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
    cleanups.push(watcher.stop);
    return { root, watcher };
}

describe("daemon coverage controls", () => {
    it("reconciles disk before accepting policy or acknowledging a version", () => {
        const { root, watcher } = fixture();
        const before = controlHookCoverage(watcher, { operation: "status" });
        const pending = before.pending?.find(entry => entry.path === join(root, "package.json"));
        if (!pending || before.generation === undefined || !before.policyDigest) throw new Error("Missing initial observation");
        writeFileSync(pending.path, "{}");
        expect(controlHookCoverage(watcher, { operation: "accept_policy", digest: before.policyDigest }).changed).toBe(false);
        expect(controlHookCoverage(watcher, { operation: "acknowledge", ...pending, generation: before.generation, evidence: "review-1" }).changed).toBe(false);
        expect(watcher.ledger.snapshot().acceptedPolicy).toBeNull();
    });
    it("retains manual review evidence across restart and validates its RPC representation", () => {
        const { root, watcher } = fixture();
        const before = watcher.ledger.snapshot();
        const pending = before.pending[0];
        if (!pending) throw new Error("Missing pending file");
        const result = controlHookCoverage(watcher, { operation: "acknowledge", ...pending, generation: before.generation, evidence: "docs/review.md#policy" });
        expect(result.changed).toBe(true);
        const serialized: unknown = JSON.parse(JSON.stringify(result));
        expect(isHookCoverageReport(serialized)).toBe(true);
        expect(serialized).toMatchObject({ reviews: [expect.objectContaining({ evidence: "docs/review.md#policy", kind: "manual_review" })] });
        watcher.stop();
        const restarted = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(restarted.stop);
        expect(restarted.ledger.snapshot().reviews).toEqual(result.reviews);
    });
    it("never approves unavailable coverage and rejects malformed requests/results", () => {
        expect(controlHookCoverage(undefined, { operation: "accept_policy", digest: "x" })).toEqual(expect.objectContaining({ readiness: "unmeasured" }));
        expect(isHookCoverageRequest({ operation: "acknowledge", generation: "1" })).toBe(false);
        expect(isHookCoverageReport({ readiness: "ready", pending: [{}] })).toBe(false);
        expect(isHookCoverageRequest({ operation: "verify" })).toBe(true);
        expect(isHookCoverageRequest({ operation: "record_check", checks: ["fake"] })).toBe(false);
        expect(isHookCoverageReport({ readiness: "ready", checks: [{ kind: "automated_check" }] })).toBe(false);
    });
});
