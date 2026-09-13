import { closeSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHookFilesystemWatch } from "./hook-filesystem-watch.js";

const cleanups: Array<() => void> = [];
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-hook-watch-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
}
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("filesystem coverage", () => {
    it("keeps symlinked policy content unmeasured instead of certifying its target", () => {
        const root = fixture();
        writeFileSync(join(root, "target.json"), "{}");
        symlinkSync("target.json", join(root, "package.json"));
        const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(watcher.stop);
        expect(watcher.status()).toMatchObject({ readiness: "unmeasured", unmeasured: [expect.stringContaining("unmeasured symbolic link")] });
        expect(watcher.ledger.snapshot().files[join(root, "package.json")]).toBeUndefined();
    });

    it("reports a directory occupying a policy-file path as unmeasured", () => {
        const root = fixture();
        mkdirSync(join(root, "package.json"));
        const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(watcher.stop);
        expect(watcher.status()).toMatchObject({ readiness: "unmeasured", unmeasured: [expect.stringContaining("unmeasured non-file")] });
        expect(watcher.ledger.snapshot().files[join(root, "package.json")]).toBeUndefined();
    });

    it("does not read or certify a policy file above the size limit", () => {
        const root = fixture();
        const path = join(root, "package.json");
        const fd = openSync(path, "w");
        try { ftruncateSync(fd, 64 * 1024 * 1024 + 1); }
        finally { closeSync(fd); }
        const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(watcher.stop);
        expect(watcher.status()).toMatchObject({ readiness: "unmeasured", unmeasured: [expect.stringContaining("oversized policy")] });
        expect(watcher.ledger.snapshot().files[path]).toBeUndefined();
    });

    it("detects atomic replacement and survives restart", () => {
        const root = fixture();
        writeFileSync(join(root, "package.json"), "old");
        const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(watcher.stop);
        const initial = watcher.ledger.snapshot().generation;
        writeFileSync(join(root, "replacement"), "new");
        renameSync(join(root, "replacement"), join(root, "package.json"));
        watcher.reconcile();
        expect(watcher.ledger.snapshot().generation).toBeGreaterThan(initial);
        expect(watcher.ledger.snapshot().pending.find(entry => entry.path.endsWith("package.json"))?.writer).toBe("unknown");
        watcher.stop();
        const restored = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(restored.stop);
        expect(restored.ledger.snapshot()).toEqual(watcher.ledger.snapshot());
    });

    it("discovers added water-lines and dynamically reserved files", () => {
        const root = fixture();
        const reserved: string[] = [];
        const watcher = startHookFilesystemWatch({ root, reservations: () => reserved });
        cleanups.push(watcher.stop);
        writeFileSync(join(root, ".interlinked", "new-baseline.json"), "{}");
        mkdirSync(join(root, "work"));
        reserved.push("work/owned.txt");
        watcher.reconcile();
        expect(watcher.watchPaths()).toContain(join(root, "work", "owned.txt"));
        expect(watcher.watchPaths()).toContain(join(root, ".interlinked", "new-baseline.json"));
        writeFileSync(join(root, "work", "owned.txt"), "external write");
        watcher.reconcile();
        expect(watcher.ledger.snapshot().pending.find(entry => entry.path.endsWith("owned.txt"))).toMatchObject({ scope: "reservation", writer: "unknown" });
    });

    it("does not certify glob reservations or paths outside the workspace", () => {
        const root = fixture();
        const watcher = startHookFilesystemWatch({ root, reservations: () => ["src/**", "../outside"] });
        cleanups.push(watcher.stop);
        expect(watcher.status().unmeasured).toEqual(expect.arrayContaining(["reservation pattern: src/**", "reservation outside workspace: ../outside"]));
        expect(watcher.watchPaths()).not.toContain(join(root, "..", "outside"));
    });

    it("keeps released reservations measured until their current version is reviewed", () => {
        const root = fixture();
        const path = join(root, "owned.txt");
        writeFileSync(path, "first");
        const reserved = ["owned.txt"];
        const watcher = startHookFilesystemWatch({ root, reservations: () => reserved });
        cleanups.push(watcher.stop);
        const before = watcher.ledger.snapshot();
        const pending = before.pending.find(entry => entry.path === path);
        if (!pending) throw new Error("Missing reserved observation");
        reserved.length = 0;
        writeFileSync(path, "changed after release");
        watcher.reconcile();
        expect(watcher.watchPaths()).toContain(path);
        expect(watcher.ledger.acknowledge({ ...pending, generation: before.generation, evidence: "old review" })).toBe(false);
        const current = watcher.ledger.snapshot();
        const updated = current.pending.find(entry => entry.path === path);
        if (!updated) throw new Error("Missing current observation");
        expect(updated.identity).not.toBe(pending.identity);
        expect(watcher.ledger.acknowledge({ ...updated, generation: current.generation, evidence: "current review" })).toBe(true);
        watcher.reconcile();
        expect(watcher.watchPaths()).not.toContain(path);
    });

    it("receives a native notification before the reconciliation interval", async () => {
        const root = fixture();
        writeFileSync(join(root, "package.json"), "old");
        const watcher = startHookFilesystemWatch({ root, reservations: () => [], reconcileMs: 60_000 });
        cleanups.push(watcher.stop);
        const before = watcher.ledger.snapshot().generation;
        writeFileSync(join(root, "package.json"), "new");
        await expect.poll(() => watcher.ledger.snapshot().generation, { timeout: 5000 }).toBeGreaterThan(before);
    });
});
