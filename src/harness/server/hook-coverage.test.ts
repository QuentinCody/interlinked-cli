import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startHookFilesystemWatch } from "../hook-filesystem-watch.js";
import { appendHookCoverageDecision } from "./hook-coverage.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("daemon hook coverage delivery", () => {
    it("returns native watch paths at session start and retains obligations after delivery", () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-hook-delivery-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const watcher = startHookFilesystemWatch({ root, reservations: () => ["reserved.txt"] });
        cleanups.push(watcher.stop);
        const result = appendHookCoverageDecision({ hookCoverage: watcher }, "SessionStart", { decision: "allow" });
        expect(result.watch_paths).toContain(join(root, "reserved.txt"));
        expect(result.warnings?.join("\n")).toContain("NOT CHECKED");
        expect(watcher.ledger.snapshot().pending.length).toBeGreaterThan(0);
    });

    it("rejects runtime application of changed accepted policy without claiming rollback", () => {
        const root = mkdtempSync(join(tmpdir(), "interlinked-hook-policy-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const watcher = startHookFilesystemWatch({ root, reservations: () => [] });
        cleanups.push(watcher.stop);
        watcher.ledger.acceptPolicy(watcher.ledger.policyDigest());
        writeFileSync(join(root, "package.json"), "{}");
        const result = appendHookCoverageDecision({ hookCoverage: watcher }, "ConfigChange", { decision: "allow" });
        expect(result.decision).toBe("block");
        expect(result.reason).toContain("runtime application");
    });
});
