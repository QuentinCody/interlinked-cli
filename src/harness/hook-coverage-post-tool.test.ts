import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "./types.js";
import type { QualityCheckOptions } from "./quality-checks.js";
import { startHookFilesystemWatch } from "./hook-filesystem-watch.js";
import { runQualityChecksWithCoverage } from "./hook-coverage-post-tool.js";
import { ChangeSetEvidence } from "./quality-checks/change-set-evidence.js";

const runner = vi.hoisted(() => vi.fn());
vi.mock("./quality-checks.js", () => ({
    runQualityChecks: runner,
    resolveQualityCheckTarget: (event: HarnessEvent) => ({ filePath: event.tool_input?.file_path }),
}));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
beforeEach(() => { runner.mockReset(); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "hook-post-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "source.ts");
    writeFileSync(path, "export const value = 1;\n");
    const watcher = startHookFilesystemWatch({ root, reservations: () => [path] });
    cleanups.push(watcher.stop);
    const event: HarnessEvent = { hook_event: "PostToolUse", agent_source: "codex", session_id: "fixture", timestamp: "2026-09-08T00:00:00Z", tool_name: "Write", tool_input: { file_path: path } };
    return { root, path, watcher, event };
}

describe("PostToolUse coverage receipts", () => {
    it.each([false, true])("attaches shared check evidence to the exact pending version (partial=%s)", async partial => {
        const { root, path, watcher, event } = fixture();
        const checks = { typescript: { enabled: true, command: "tsc", severity: "warning" as const, timeout_ms: 1000, file_types: [".ts"] } };
        const batch = new ChangeSetEvidence([path], checks, root);
        batch.finish();
        const shared = batch.forFile(path, ["typescript"], new Map());
        if (partial) shared.unavailable.push("security scanner unavailable");
        runner.mockImplementation(async (_event: HarnessEvent, _checks: object, _cwd: string, opts: QualityCheckOptions) => {
            opts.outChecksRan?.push("inline-check"); return [];
        });
        await runQualityChecksWithCoverage({ watcher, event, cwd: root, checks, options: { skipMultiFileExternalChecks: true },
            externalBatch: { resultsForFile: async () => [], evidenceForFile: async () => shared } });
        const state = watcher.ledger.snapshot();
        expect(state.pending.some(entry => entry.path === path)).toBe(partial);
        expect(state.checks).toEqual([expect.objectContaining({ checks: ["inline-check", "typescript"], scopes: shared.scopes })]);
    });

    it("does not apply cached shared evidence to a later file version", async () => {
        const { root, path, watcher, event } = fixture();
        const checks = { typescript: { enabled: true, command: "tsc", severity: "warning" as const, timeout_ms: 1000, file_types: [".ts"] } };
        const batch = new ChangeSetEvidence([path], checks, root); batch.finish();
        const shared = batch.forFile(path, ["typescript"], new Map());
        writeFileSync(path, "export const replacement = 2;"); watcher.reconcile();
        runner.mockResolvedValue([]);
        await runQualityChecksWithCoverage({ watcher, event, cwd: root, checks, options: { skipMultiFileExternalChecks: true },
            externalBatch: { resultsForFile: async () => [], evidenceForFile: async () => shared } });
        expect(watcher.ledger.snapshot().pending.some(entry => entry.path === path)).toBe(true);
        expect(watcher.ledger.snapshot().checks[0]?.unavailable).toContain("Shared evidence describes a different file version");
    });
    it("consumes completed per-file checks and preserves findings and accounting", async () => {
        const { root, path, watcher, event } = fixture();
        const checks: string[] = [];
        const findings = [{ name: "typescript", severity: "error", message: "type mismatch" }];
        runner.mockImplementation(async (_event: HarnessEvent, _checks: object, _cwd: string, opts: QualityCheckOptions) => {
            opts.outChecksRan?.push("typescript");
            return findings;
        });
        expect(await runQualityChecksWithCoverage({ watcher, event, cwd: root, checks: {}, options: { outChecksRan: checks } })).toEqual(findings);
        expect(checks).toEqual(["typescript"]);
        expect(watcher.ledger.snapshot().pending.some(entry => entry.path === path)).toBe(false);
        expect(watcher.ledger.snapshot().checks).toEqual([expect.objectContaining({ path, checks: ["typescript"], findings: ["error: typescript: type mismatch"] })]);
    });

    it.each(["changed", "stopped"])("keeps %s file verification pending", async reason => {
        const { root, path, watcher, event } = fixture();
        runner.mockImplementation(async (_event: HarnessEvent, _checks: object, _cwd: string, opts: QualityCheckOptions) => {
            opts.outChecksRan?.push("typescript");
            if (reason === "changed") writeFileSync(path, "export const value = 2;\n");
            if (reason === "stopped") watcher.stop();
            return [];
        });
        await runQualityChecksWithCoverage({ watcher, event, cwd: root, checks: {}, options: {} });
        expect(watcher.ledger.snapshot().pending.some(entry => entry.path === path)).toBe(true);
        expect(watcher.ledger.snapshot().checks).toEqual([]);
    });

    it.each([false, true])("retains partial per-file checks without clearing missing external evidence (batch=%s)", async batched => {
        const { root, path, watcher, event } = fixture();
        runner.mockImplementation(async (_event: HarnessEvent, _checks: object, _cwd: string, opts: QualityCheckOptions) => {
            opts.outChecksRan?.push("inline-check");
            return [{ name: "external_check_deferred", severity: "warning", message: "busy" },
                { name: "inline-check", severity: "error", message: "actual finding" }];
        });
        await runQualityChecksWithCoverage({ watcher, event, cwd: root, checks: {}, options: { skipMultiFileExternalChecks: batched } });
        const state = watcher.ledger.snapshot();
        expect(state.pending.some(entry => entry.path === path)).toBe(true);
        expect(state.checks).toEqual([expect.objectContaining({ checks: ["inline-check"], findings: ["error: inline-check: actual finding"],
            unavailable: expect.arrayContaining(["external_check_deferred: busy"]) })]);
    });
});
