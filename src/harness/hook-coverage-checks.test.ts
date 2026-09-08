import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookPendingCheck } from "./hook-coverage-ledger.js";
import type { QualityCheckResult } from "./quality-checks/result-types.js";
import type { QualityCheckOptions } from "./quality-checks.js";
import type { HarnessEvent, QualityCheckConfig } from "./types.js";

const mocks = vi.hoisted(() => ({ batch: vi.fn(), quality: vi.fn() }));
vi.mock("./quality-checks/change-set-external.js", () => ({ createChangeSetExternalBatch: mocks.batch }));
vi.mock("./quality-checks.js", () => ({
    runQualityChecks: mocks.quality,
    resolveQualityCheckTarget: () => ({ filePath: "eligible" }),
}));
import { createHookCoverageChecker } from "./hook-coverage-checks.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
beforeEach(() => {
    vi.resetAllMocks();
    mocks.batch.mockReturnValue({ resultsForFile: async () => [] });
    mocks.quality.mockImplementation(async (_event: HarnessEvent, _checks: Record<string, QualityCheckConfig>, _root: string, options: QualityCheckOptions) => {
        options.outChecksRan?.push("strong_typing");
        return [];
    });
});
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "hook-checker-"));
    roots.push(root);
    const content = "export const count = 1;\n";
    const entries: HookPendingCheck[] = ["one.ts", "two.ts"].map(name => {
        const path = join(root, name);
        writeFileSync(path, content);
        return { id: name, path, identity: createHash("sha256").update(content).digest("hex"), scope: "reservation", writer: "unknown" };
    });
    return { root, entries };
}

describe("coverage check scope", () => {
    it("carries a shared external deferral to every file in the batch", async () => {
        const { root, entries } = fixture();
        const deferred: QualityCheckResult = { name: "external_check_deferred", severity: "warning", message: "compiler busy" };
        mocks.batch.mockReturnValue({ resultsForFile: async (path: string) => path.endsWith("one.ts") ? [deferred] : [] });
        const evidence = await createHookCoverageChecker(root, () => ({}))(entries);
        expect(evidence.size).toBe(2);
        expect([...evidence.values()].map(result => result.unavailable)).toEqual([[expect.stringContaining("compiler busy")], [expect.stringContaining("compiler busy")]]);
    });

    it("retains findings while enumerating only completed checks", async () => {
        const { root, entries } = fixture();
        mocks.quality.mockImplementation(async (_event: HarnessEvent, _checks: Record<string, QualityCheckConfig>, _root: string, options: QualityCheckOptions) => {
            options.outChecksRan?.push("strong_typing");
            return [{ name: "strong_typing", severity: "warning", message: "Existing weak type", detail: "line 1" }];
        });
        const evidence = await createHookCoverageChecker(root, () => ({}))(entries);
        expect([...evidence.values()]).toEqual(entries.map(() => ({ checks: ["strong_typing"], findings: ["warning: strong_typing: Existing weak type\nline 1"], unavailable: [] })));
    });

    it("does not run checks against a replaced file under its previous hash", async () => {
        const { root, entries } = fixture();
        const entry = entries[0];
        if (!entry) throw new Error("Missing fixture entry");
        writeFileSync(entry.path, "replacement");
        const evidence = await createHookCoverageChecker(root, () => ({}))([entry]);
        expect(mocks.quality).not.toHaveBeenCalled();
        expect(evidence.get(entry.id)?.unavailable.join(" ")).toContain("changed before checking");
    });

    it("refuses receipts when effective configuration changes during the run", async () => {
        const { root, entries } = fixture();
        const checks: Record<string, QualityCheckConfig> = {};
        mocks.quality.mockImplementation(async () => {
            checks.added = { enabled: true, severity: "error", timeout_ms: 1000, file_types: [".ts"] };
            return [];
        });
        const evidence = await createHookCoverageChecker(root, () => checks)(entries);
        expect([...evidence.values()].every(result => result.unavailable.includes("Configured checks changed during verification"))).toBe(true);
    });

    it("gives recovery related tests a longer deadline without changing live configuration", async () => {
        const { root, entries } = fixture();
        const configured = { affected_tests: { enabled: true, severity: "error" as const, timeout_ms: 15000, max_dependent_tests: 8, file_types: [".ts"] } };
        const evidence = await createHookCoverageChecker(root, () => configured)(entries);
        expect(mocks.batch).toHaveBeenCalledWith(expect.objectContaining({ checks: { affected_tests: { ...configured.affected_tests, timeout_ms: 120000 } } }));
        expect(configured.affected_tests.timeout_ms).toBe(15000);
        expect([...evidence.values()].map(result => result.unavailable)).toEqual([[], []]);
    });
});
