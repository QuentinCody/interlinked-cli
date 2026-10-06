import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReservationEntry } from "../types.js";
import { activateHookCoverage } from "./hook-coverage.js";
import { makeServerRules, makeServerRuntime } from "./__tests__/fixtures.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(paths: (root: string) => string[]) {
    const parent = mkdtempSync(join(tmpdir(), "coverage-reservation-scope-"));
    cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, "repo");
    mkdirSync(root);
    writeFileSync(join(root, "inside.txt"), "must still be checked");
    const reservations: ReservationEntry[] = [];
    const add = (path: string) => reservations.push({ file_pattern: path, agent_name: "peer", cohort: "local",
        reserved_at: "2026-10-06T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" });
    for (const path of paths(root)) add(path);
    const runtime = makeServerRuntime({ cwd: root, rules: makeServerRules(), reservations: { getAll: () => reservations } });
    cleanups.push(activateHookCoverage(runtime));
    const watcher = runtime.hookCoverage;
    if (!watcher) throw new Error(runtime.hookCoverageUnavailable ?? "Missing observer");
    return { root, add, watcher };
}

// Incident: a peer's external Claude memory reservation aborted repository verification at 333/334.
describe("repository coverage reservation scope", () => {
    it("keeps external memory, sibling repositories and normalized traversal out of this repository's observation", () => {
        const { root, watcher } = fixture(root => ["inside.txt", join(root, "../memory/note.md"),
            `${root}-other/file.ts`, "src/../../outside.txt"]);
        expect(watcher.status()).toMatchObject({ readiness: "ready", unmeasured: [] });
        expect(watcher.ledger.observation().pending.map(entry => entry.path)).toEqual([join(root, "inside.txt")]);
        expect(watcher.watchPaths().every(path => path.startsWith(`${root}/`))).toBe(true);
    });

    it("keeps readiness and existing obligations when an external reservation arrives later", () => {
        const { watcher, root, add } = fixture(() => ["inside.txt"]);
        const pending = watcher.ledger.observation().pending;
        add(join(root, "../memory/new-note.md"));
        watcher.reconcile();
        expect(watcher.status().readiness).toBe("ready");
        expect(watcher.ledger.observation().pending).toEqual(pending);
    });

    it("does not hide unsupported reservations inside the repository", () => {
        const { watcher } = fixture(() => ["inside.txt", "src/**"]);
        expect(watcher.status()).toMatchObject({ readiness: "unmeasured", unmeasured: ["reservation pattern: src/**"] });
    });

    it("records the observer's actual reason when verification cannot measure the repository", async () => {
        const { watcher } = fixture(() => ["inside.txt", "src/**"]);
        watcher.verification?.start();
        await vi.waitFor(() => expect(watcher.verification?.status()?.status).toBe("complete"));
        expect(watcher.verification?.status()?.unmeasured.join("\n")).toContain("reservation pattern: src/**");
        expect(watcher.ledger.observation().pending).toHaveLength(1);
    });

    it("retains in-repository symlinks as unmeasured even when the target is outside", () => {
        const { root, watcher, add } = fixture(() => ["inside.txt"]);
        writeFileSync(join(root, "../outside.txt"), "external bytes");
        symlinkSync(join(root, "../outside.txt"), join(root, "link.txt"));
        add(join(root, "link.txt"));
        watcher.reconcile();
        expect(watcher.watchPaths()).toContain(join(root, "link.txt"));
        expect(watcher.status().readiness).toBe("unmeasured");
        expect(watcher.status().unmeasured.join("\n")).toContain("unmeasured symbolic link");
    });
});
