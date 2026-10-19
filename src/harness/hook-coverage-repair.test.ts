// repairHistoryLoss (hook-coverage-ledger.ts): the explicit operator exit from
// a history log shorter than its committed pointer (2026-10-15 review).
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HISTORY_REPAIR_COMMAND, historyLogPath } from "./hook-coverage-history-log.js";
import { HookCoverageLedger, repairHistoryLoss } from "./hook-coverage-ledger.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function ledgerPath(): string {
    const root = mkdtempSync(join(tmpdir(), "coverage-repair-"));
    roots.push(root);
    return join(root, "hook-coverage.json");
}
const pending = [{ id: "p1", path: "a.ts", identity: "v1", scope: "policy", writer: "unknown" }];
const lost = { schema: 1, generation: 7, policyGeneration: 2, files: { "a.ts": { identity: "v1", scope: "policy" } }, pending, acceptedPolicy: "d1",
    history: { bytes: 100, checks: 1, reviews: 0, recent: { checks: [0], reviews: [] } } };

describe("repairHistoryLoss — positive (must fire)", () => {
    it("P1: the constructor's refusal names the repair command", () => {
        const path = ledgerPath();
        writeFileSync(path, JSON.stringify(lost));
        expect(() => new HookCoverageLedger(path)).toThrow(HISTORY_REPAIR_COMMAND);
    });
    it("P2: a missing log is restarted at zero and the state, pending work and acceptance are kept", () => {
        const path = ledgerPath();
        writeFileSync(path, JSON.stringify(lost));
        const result = repairHistoryLoss(path);
        expect(result).toEqual({ repaired: true, detail: expect.stringContaining("pending obligations kept (1)") });
        expect(result.orphan).toBeUndefined();
        const ledger = new HookCoverageLedger(path);
        expect(ledger.summary()).toEqual({ generation: 7, policyGeneration: 2, pendingCount: 1, acceptedPolicy: "d1" });
        expect(ledger.snapshot()).toMatchObject({ checks: [], reviews: [], pending });
        expect(ledger.acknowledge({ id: "p1", generation: 7, identity: "v1", evidence: "read" })).toBe(true);
    });
    it("P3: a partial log is set aside as an orphan, never deleted", () => {
        const path = ledgerPath();
        writeFileSync(path, JSON.stringify(lost));
        writeFileSync(historyLogPath(path), "{\"partial\":1}\n");
        const result = repairHistoryLoss(path);
        expect(result.repaired).toBe(true);
        expect(result.orphan).toMatch(/hook-coverage-history\.jsonl\.orphan-/);
        expect(existsSync(historyLogPath(path))).toBe(false);
        expect(readdirSync(join(path, "..")).filter(name => name.includes(".orphan-"))).toHaveLength(1);
        expect(() => new HookCoverageLedger(path)).not.toThrow();
    });
});

describe("repairHistoryLoss — negative (must not fire)", () => {
    it("N1: an intact history is not touched", () => {
        const path = ledgerPath();
        writeFileSync(path, JSON.stringify({ ...lost, history: { bytes: 0, checks: 0, reviews: 0, recent: { checks: [], reviews: [] } } }));
        expect(repairHistoryLoss(path)).toEqual({ repaired: false, detail: expect.stringContaining("history intact") });
        expect(existsSync(historyLogPath(path))).toBe(false);
    });
    it("N2: no ledger means nothing to repair", () => {
        expect(repairHistoryLoss(join(ledgerPath(), "..", "missing.json"))).toEqual({ repaired: false, detail: expect.stringContaining("no hook coverage ledger") });
    });
    it("N3: a legacy inline-history ledger is left for the daemon's migration", () => {
        const path = ledgerPath();
        writeFileSync(path, JSON.stringify({ schema: 1, generation: 1, files: {}, pending: [], acceptedPolicy: null, checks: [], reviews: [] }));
        expect(repairHistoryLoss(path)).toEqual({ repaired: false, detail: expect.stringContaining("legacy") });
    });
});
