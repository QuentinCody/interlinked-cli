import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";

const roots: string[] = [];
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-hook-ledger-"));
    roots.push(root);
    return join(root, "coverage.json");
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable hook coverage", () => {
    it("records initial absence without inventing a write, but retains later creation and deletion", () => {
        const path = fixture(), ledger = new HookCoverageLedger(path);
        const emptyDigest = ledger.policyDigest();
        ledger.observe("package.json", "missing", "policy");
        expect(ledger.observation().files["package.json"]).toEqual({ identity: "missing", scope: "policy" });
        expect(ledger.policyDigest()).not.toBe(emptyDigest);
        expect(new HookCoverageLedger(path).observation().pending).toEqual([]);
        ledger.observe("package.json", "created", "policy");
        expect(ledger.observation().pending).toEqual([expect.objectContaining({ identity: "created" })]);
        ledger.observe("package.json", "missing", "policy");
        expect(new HookCoverageLedger(path).observation().pending).toEqual([expect.objectContaining({ identity: "missing" })]);
    });
    it("exposes isolated current observations without copying or dropping history", () => {
        const path = fixture(), ledger = new HookCoverageLedger(path);
        ledger.observe("old.ts", "old", "reservation");
        const before = ledger.snapshot(), entry = before.pending[0]!;
        expect(ledger.acknowledge({ ...entry, generation: before.generation, evidence: "retained review" })).toBe(true);
        ledger.observe("new.ts", "new", "reservation");
        const observation = ledger.observation(), summary = ledger.summary();
        expect(Object.keys(observation).sort()).toEqual(["files", "pending"]);
        expect(summary.pendingCount).toBe(1);
        observation.pending.length = 0;
        delete observation.files["new.ts"];
        expect(ledger.summary()).toEqual(summary);
        expect(ledger.observation().pending).toHaveLength(1);
        expect(new HookCoverageLedger(path).snapshot().reviews).toEqual([expect.objectContaining({ evidence: "retained review" })]);
    });
    it("retains changes across restart and deduplicates repeated observations", () => {
        const path = fixture();
        const ledger = new HookCoverageLedger(path);
        ledger.observe("package.json", "old", "policy");
        ledger.observe("package.json", "new", "policy");
        const saved = readFileSync(path, "utf8");
        ledger.observe("package.json", "new", "policy");
        expect(readFileSync(path, "utf8")).toBe(saved);
        const reopened = new HookCoverageLedger(path);
        expect(reopened.snapshot().pending).toHaveLength(1);
        expect(reopened.snapshot().pending[0]).toMatchObject({ path: "package.json", identity: "new", writer: "unknown" });
    });

    it.each(["file", "policy"])("rejects stale partial evidence after a %s change", kind => {
        const path = fixture(), ledger = new HookCoverageLedger(path);
        ledger.observe("source.ts", "a", "reservation");
        ledger.observe("policy.json", "p", "policy");
        const entry = ledger.observation().pending.find(item => item.path === "source.ts")!;
        const receipt = { ...entry, policyDigest: ledger.policyDigest(), policyGeneration: ledger.summary().policyGeneration,
            checks: ["lint"], findings: [], unavailable: ["tests busy"], checkedAt: "2026-09-14T00:00:00Z", kind: "automated_check" as const };
        if (kind === "file") ledger.observe("source.ts", "b", "reservation");
        else ledger.observe("policy.json", "q", "policy");
        expect(ledger.recordCheck(receipt)).toBe(false);
        expect(new HookCoverageLedger(path).snapshot().checks).toEqual([]);
    });

    it("rejects an acknowledgment after any newer observed input, including ABA", () => {
        const ledger = new HookCoverageLedger(fixture());
        ledger.observe("package.json", "a", "policy");
        ledger.observe("package.json", "b", "policy");
        const before = ledger.snapshot();
        const pending = before.pending[0]!;
        ledger.observe("package.json", "a", "policy");
        ledger.observe("package.json", "b", "policy");
        expect(ledger.acknowledge({ id: pending.id, generation: before.generation, identity: "b", evidence: "check-1" })).toBe(false);
        const current = ledger.snapshot();
        expect(ledger.acknowledge({ id: current.pending[0]!.id, generation: current.generation, identity: "b", evidence: "check-2" })).toBe(true);
        expect(ledger.snapshot().pending).toHaveLength(0);
        expect(ledger.snapshot().reviews).toEqual([expect.objectContaining({ identity: "b", evidence: "check-2", kind: "manual_review" })]);
    });

    it("never promotes an observed policy to accepted on restart", () => {
        const path = fixture();
        const ledger = new HookCoverageLedger(path);
        ledger.observe("metric-caps.json", "a", "policy");
        const digest = ledger.policyDigest();
        expect(ledger.acceptPolicy("stale")).toBe(false);
        expect(ledger.acceptPolicy(digest)).toBe(true);
        ledger.observe("metric-caps.json", "b", "policy");
        const reopened = new HookCoverageLedger(path);
        expect(reopened.snapshot().acceptedPolicy).toBe(digest);
        expect(reopened.policyDigest()).not.toBe(digest);
    });

    it("refuses corrupt durable state rather than replacing it with a clean ledger", () => {
        const path = fixture();
        writeFileSync(path, "{broken");
        expect(() => new HookCoverageLedger(path)).toThrow();
        expect(readFileSync(path, "utf8")).toBe("{broken");
    });
});
