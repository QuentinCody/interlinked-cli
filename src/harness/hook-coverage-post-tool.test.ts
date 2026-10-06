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
    resolveQualityCheckTarget: (event: HarnessEvent) => typeof event.tool_input?.file_path === "string"
        ? { filePath: event.tool_input.file_path } : undefined,
}));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
beforeEach(() => { runner.mockReset(); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "hook-post-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "source.ts");
    writeFileSync(path, "export const value = 1;\n");
    const reservations = [path];
    const watcher = startHookFilesystemWatch({ root, reservations: () => reservations });
    cleanups.push(watcher.stop);
    const event: HarnessEvent = { hook_event: "PostToolUse", agent_source: "codex", session_id: "fixture", timestamp: "2026-09-08T00:00:00Z", tool_name: "Write", tool_input: { file_path: path } };
    return { root, path, watcher, event, reservations };
}

describe("PostToolUse coverage receipts", () => {
    it("passes through checks and their accounting when no observer is available", async () => {
        const { root, event } = fixture(), checks: string[] = [];
        const findings = [{ name: "typescript", severity: "warning", message: "actual finding" }];
        runner.mockImplementation(async (_event: HarnessEvent, _checks: object, _cwd: string, options: QualityCheckOptions) => {
            options.outChecksRan?.push("typescript"); return findings;
        });
        expect(await runQualityChecksWithCoverage({ watcher: undefined, event, checks: {}, cwd: root,
            options: { outChecksRan: checks } })).toEqual(findings);
        expect(checks).toEqual(["typescript"]);
    });

    it.each(["stopped observer", "deleted target", "no target", "no completed checks"])("keeps obligations pending with %s", async condition => {
        const { root, path, watcher, event } = fixture();
        if (condition === "stopped observer") watcher.stop();
        if (condition === "deleted target") rmSync(path);
        if (condition === "no target") event.tool_input = {};
        const findings = [{ name: "typescript", severity: "warning", message: "kept in tool output" }];
        runner.mockImplementation(async (_event: HarnessEvent, _checks: object, _cwd: string, options: QualityCheckOptions) => {
            if (condition !== "no completed checks") options.outChecksRan?.push("typescript");
            return findings;
        });
        expect(await runQualityChecksWithCoverage({ watcher, event, checks: {}, cwd: root, options: {} })).toEqual(findings);
        expect(watcher.ledger.snapshot().pending).toEqual([expect.objectContaining({ path })]);
        expect(watcher.ledger.snapshot().checks).toEqual([]);
    });

    it("does not duplicate a receipt when a checked version receives another tool event", async () => {
        const { root, watcher, event } = fixture();
        runner.mockImplementation(async (_event: HarnessEvent, _checks: object, _cwd: string, options: QualityCheckOptions) => {
            options.outChecksRan?.push("typescript");
            return [{ name: "typescript", severity: "error", message: "type mismatch", detail: "line 3: incompatible value" }];
        });
        await runQualityChecksWithCoverage({ watcher, event, checks: {}, cwd: root, options: {} });
        const before = watcher.ledger.snapshot();
        expect(before.checks[0]?.findings).toEqual(["error: typescript: type mismatch\nline 3: incompatible value"]);
        expect(before.pending).toEqual([]);
        await runQualityChecksWithCoverage({ watcher, event, checks: {}, cwd: root, options: {} });
        expect(watcher.ledger.snapshot()).toEqual(before);
    });

    it("does not qualify cached batch evidence under a policy adopted between two file events", async () => {
        const { root, path, watcher, event, reservations } = fixture();
        const second = join(root, "second.ts");
        writeFileSync(second, "export const second = 2;\n");
        reservations.push(second);
        watcher.reconcile();
        const checks = { typescript: { enabled: true, command: "tsc", severity: "warning" as const, timeout_ms: 1000, file_types: [".ts"] } };
        const batch = new ChangeSetEvidence([path, second], checks, root);
        batch.finish();
        const externalBatch = { resultsForFile: async () => [],
            evidenceForFile: async (file: string) => batch.forFile(file, ["typescript"], new Map()) };
        runner.mockResolvedValue([]);
        await runQualityChecksWithCoverage({ watcher, event, checks, cwd: root, options: { skipMultiFileExternalChecks: true }, externalBatch });
        const firstReceipt = watcher.ledger.snapshot().checks[0];
        expect(firstReceipt?.path).toBe(path);
        expect(firstReceipt?.unavailable).toEqual([]);
        writeFileSync(join(root, "tsconfig.json"), "{}");
        watcher.reconcile();
        await runQualityChecksWithCoverage({ watcher, event: { ...event, tool_input: { file_path: second } }, checks,
            cwd: root, options: { skipMultiFileExternalChecks: true }, externalBatch });
        const state = watcher.ledger.snapshot();
        expect(state.pending.map(entry => entry.path)).toContain(second);
        expect(state.checks).toEqual([firstReceipt, expect.objectContaining({ path: second,
            unavailable: ["Policy changed during shared batch execution"] })]);
    });

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
