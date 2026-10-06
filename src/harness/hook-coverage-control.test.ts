import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_DRAIN_ENV, controlHookCoverage, isHookCoverageReport, isHookCoverageRequest, startIdleEvidenceDrain } from "./hook-coverage-control.js";
import { startHookFilesystemWatch } from "./hook-filesystem-watch.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "hook-control-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "package.json"), '{"name":"initial"}');
    const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
    cleanups.push(watcher.stop);
    return { root, watcher };
}

describe("startIdleEvidenceDrain", () => {
    function drainable() {
        const root = mkdtempSync(join(tmpdir(), "hook-drain-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        writeFileSync(join(root, "package.json"), '{"name":"initial"}');
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        // The checker holds until released, so the job stays observably "running".
        const checker = vi.fn(async () => { await gate; return new Map(); });
        const watcher = startHookFilesystemWatch({ root, reservations: () => [], checker });
        cleanups.push(() => { release(); watcher.stop(); });
        return { watcher, checker, release };
    }

    // test-contract: invariant — versions written outside hook events stay pending until a check of that exact version runs; the idle drain starts the bounded verify job when versions are pending and none is running, and the operator can opt out (H5, 2026-10-02)
    it("starts the verify job when versions are pending and no job is running", () => {
        const { watcher } = drainable();
        expect(watcher.ledger.summary().pendingCount).toBeGreaterThan(0);
        expect(startIdleEvidenceDrain(watcher, {})).toBe(true);
        expect(watcher.verification?.isRunning()).toBe(true);
        expect(startIdleEvidenceDrain(watcher, {})).toBe(false);
    });
    it("does nothing when opted out, without a verifier, or without an observer", () => {
        const { watcher } = drainable();
        expect(startIdleEvidenceDrain(watcher, { [AUTO_DRAIN_ENV]: "0" })).toBe(false);
        expect(watcher.verification?.isRunning()).toBe(false);
        expect(startIdleEvidenceDrain(fixture().watcher, {})).toBe(false);
        expect(startIdleEvidenceDrain(undefined, {})).toBe(false);
    });
});

describe("daemon coverage controls", () => {
    it("starts verification with a bounded acknowledgement instead of serializing receipt history", () => {
        const { root, watcher } = fixture();
        watcher.stop();
        const active = startHookFilesystemWatch({ root, reservations: () => [], checker: async () => new Map() });
        cleanups.push(active.stop);
        const snapshot = vi.spyOn(active.ledger, "snapshot");
        const response = controlHookCoverage(active, { operation: "verify", detail: "progress" });
        expect(response).toMatchObject({ readiness: "ready", changed: true, progress: { verification: { status: "running" } } });
        expect(snapshot).not.toHaveBeenCalled();
        expect(response.checks).toBeUndefined();
        expect(response.pending).toBeUndefined();
        expect(isHookCoverageReport(JSON.parse(JSON.stringify(response)))).toBe(true);
        const again = controlHookCoverage(active, { operation: "verify", detail: "progress" });
        expect(again.progress?.verification?.id).toBe(response.progress?.verification?.id);
        const legacy = controlHookCoverage(active, { operation: "verify" });
        expect(legacy.verification?.id).toBe(response.progress?.verification?.id);
        expect(legacy.pending).toBeDefined();
        expect(legacy.checks).toBeDefined();
    });

    it("serves cached progress without reconciliation or copying receipt history", () => {
        const { root, watcher } = fixture();
        const before = watcher.ledger.summary(), observedAt = watcher.status().lastReconciled;
        writeFileSync(join(root, "package.json"), "new bytes after the observation");
        const reconcile = vi.spyOn(watcher, "reconcile");
        const snapshot = vi.spyOn(watcher.ledger, "snapshot");
        const result = controlHookCoverage(watcher, { operation: "status", detail: "progress" });
        expect(result).toMatchObject({ readiness: "ready", generation: before.generation,
            progress: { observedAt, pendingCount: before.pendingCount } });
        expect(isHookCoverageReport(JSON.parse(JSON.stringify(result)))).toBe(true);
        expect(reconcile).not.toHaveBeenCalled();
        expect(snapshot).not.toHaveBeenCalled();
        expect(Object.keys(result).sort()).toEqual(["generation", "progress", "readiness", "reason"]);
        const current = controlHookCoverage(watcher, { operation: "status" });
        expect(current.generation).toBeGreaterThan(before.generation);
    });

    it("keeps a stopped observer unmeasured in compact progress", () => {
        const { watcher } = fixture();
        watcher.stop();
        expect(controlHookCoverage(watcher, { operation: "status", detail: "progress" })).toMatchObject({ readiness: "unmeasured" });
    });
    it("reconciles final verification evidence without cloning retained receipt history", () => {
        const { root, watcher } = fixture();
        const before = watcher.ledger.summary().generation;
        writeFileSync(join(root, "package.json"), "changed during checks");
        const snapshot = vi.spyOn(watcher.ledger, "snapshot");
        const final = controlHookCoverage(watcher, { operation: "status", detail: "verification" });
        expect(final.generation).toBeGreaterThan(before);
        expect(final.pending?.length).toBeGreaterThan(0);
        expect(final.progress).toBeUndefined();
        // Reconciliation persists changed identities via snapshot(); returning
        // the report must not make another copy once that state is current.
        snapshot.mockClear();
        expect(controlHookCoverage(watcher, { operation: "status", detail: "verification" })).toEqual(final);
        expect(snapshot).not.toHaveBeenCalled();
        expect(isHookCoverageReport(JSON.parse(JSON.stringify(final)))).toBe(true);
        expect(isHookCoverageRequest({ operation: "status", detail: "verification" })).toBe(true);
    });
    it("acknowledges an empty verification job that completes synchronously", () => {
        const root = mkdtempSync(join(tmpdir(), "hook-empty-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const watcher = startHookFilesystemWatch({ root, reservations: () => [], checker: async () => new Map() });
        cleanups.push(watcher.stop);
        expect(controlHookCoverage(watcher, { operation: "verify", detail: "progress" })).toMatchObject({
            changed: true, progress: { verification: { status: "complete", total: 0, checked: 0 } },
        });
    });
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
        expect(isHookCoverageRequest({ operation: "verify", detail: "progress" })).toBe(true);
        expect(isHookCoverageRequest({ operation: "verify", detail: "unknown" })).toBe(false);
        expect(isHookCoverageRequest({ operation: "record_check", checks: ["fake"] })).toBe(false);
        expect(isHookCoverageReport({ readiness: "ready", checks: [{ kind: "automated_check" }] })).toBe(false);
        expect(isHookCoverageRequest({ operation: "status", detail: "progress" })).toBe(true);
        expect(isHookCoverageRequest({ operation: "status", detail: "unknown" })).toBe(false);
        expect(isHookCoverageReport({ readiness: "ready", progress: { pendingCount: "1" } })).toBe(false);
    });
});
