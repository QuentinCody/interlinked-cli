import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";
import type { HookCheckReceipt } from "./hook-coverage-evidence.js";
import type { HookVerificationCheckpoint } from "./hook-coverage-job.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof fs>() }));

const roots: string[] = [];
function fixture() {
    const root = fs.mkdtempSync(join(tmpdir(), "hook-ledger-persistence-"));
    roots.push(root);
    const path = join(root, "ledger.json");
    return { root, path, ledger: new HookCoverageLedger(path) };
}
function receipt(ledger: HookCoverageLedger, path: string): HookCheckReceipt {
    const entry = ledger.observation().pending.find(candidate => candidate.path === path)!;
    return { ...entry, policyDigest: ledger.policyDigest(), policyGeneration: ledger.summary().policyGeneration,
        checks: ["lint"], findings: [], checkedAt: "2026-10-05T00:00:00Z", kind: "automated_check" };
}
afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("hook coverage persistence under retained history", () => {
    it("commits recovery progress and receipts together, or retains both previous states on failure", () => {
        const { path, ledger } = fixture();
        ledger.observe("a", "v1", "reservation");
        const checkpoint: HookVerificationCheckpoint = { schema: 1,
            job: { id: "job", status: "running", total: 1, processed: 0, checked: 0, findings: 0, unmeasured: [] },
            batches: [ledger.observation().pending], nextBatch: 0, deadlineAt: 1791239999000 };
        ledger.saveRecovery(checkpoint);
        const next: HookVerificationCheckpoint = { ...checkpoint, nextBatch: 1,
            job: { ...checkpoint.job, status: "complete", processed: 1, checked: 1 } };
        const check = receipt(ledger, "a");
        vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk fault"); });
        expect(() => ledger.recordChecks([check], () => next)).toThrow("disk fault");
        const failed = new HookCoverageLedger(path);
        expect(failed.recovery()).toEqual(checkpoint);
        expect(failed.observation().pending).toHaveLength(1);
        expect(failed.snapshot().checks).toEqual([]);
        expect(ledger.recordChecks([check], () => next)).toEqual([true]);
        const saved = new HookCoverageLedger(path);
        expect(saved.recovery()).toEqual(next);
        expect(saved.observation().pending).toEqual([]);
        expect(saved.snapshot().checks).toEqual([check]);
    });
    it("writes bounded chunks while preserving all historical receipt bytes", () => {
        const { path, ledger } = fixture();
        ledger.observe("source.ts", "a", "reservation");
        const history = Array.from({ length: 100 }, (_, i) => ({ ...receipt(ledger, "source.ts"), id: `old-${i}`, findings: ["x".repeat(16 * 1024)] }));
        fs.writeFileSync(path, JSON.stringify({ ...ledger.snapshot(), checks: history }));
        const reopened = new HookCoverageLedger(path);
        const write = vi.spyOn(fs, "writeFileSync");
        reopened.observe("source.ts", "b", "reservation");
        expect(write.mock.calls.length).toBeGreaterThan(1);
        for (const call of write.mock.calls) expect(Buffer.byteLength(String(call[1]))).toBeLessThan(96 * 1024);
        expect(new HookCoverageLedger(path).snapshot().checks).toEqual(history);
    });

    it("persists observations once per batch and retains ABA generations", () => {
        const { path, ledger } = fixture();
        ledger.observe("policy.json", "a", "policy");
        const original = ledger.snapshot();
        const rename = vi.spyOn(fs, "renameSync");
        ledger.observeBatch([
            { path: "policy.json", identity: "b", scope: "policy" },
            { path: "policy.json", identity: "a", scope: "policy" },
            { path: "other.ts", identity: "c", scope: "reservation" },
        ]);
        expect(rename).toHaveBeenCalledTimes(1);
        const saved = new HookCoverageLedger(path).snapshot();
        expect(saved.generation).toBe(original.generation + 3);
        expect(saved.policyGeneration).toBe(original.policyGeneration + 2);
        expect(saved.pending).toHaveLength(2);
        expect(saved.pending[0]!.id).not.toBe(original.pending[0]!.id);
        ledger.observeBatch([{ path: "other.ts", identity: "c", scope: "reservation" }]);
        expect(rename).toHaveBeenCalledTimes(1);
        expect(original.pending).toHaveLength(1);
    });

    it("commits mixed check outcomes together without aliasing inputs or losing partial evidence", () => {
        const { path, ledger } = fixture();
        for (const name of ["a", "b", "c"]) ledger.observe(name, "v1", "reservation");
        const complete = receipt(ledger, "a"), partial = { ...receipt(ledger, "b"), unavailable: ["tests busy"] };
        const stale = receipt(ledger, "c");
        ledger.observe("c", "v2", "reservation");
        const before = ledger.snapshot();
        const rename = vi.spyOn(fs, "renameSync");
        expect(ledger.recordChecks([complete, partial, stale, complete])).toEqual([true, true, false, false]);
        expect(rename).toHaveBeenCalledTimes(1);
        complete.findings.push("caller mutation");
        partial.unavailable.length = 0;
        const saved = new HookCoverageLedger(path).snapshot();
        expect(saved.checks).toHaveLength(2);
        expect(saved.checks[0]!.findings).toEqual([]);
        expect(saved.checks[1]!.unavailable).toEqual(["tests busy"]);
        expect(saved.pending.map(entry => entry.path)).toEqual(["b", "c"]);
        expect(saved.generation).toBe(before.generation + 2);
        expect(ledger.snapshot()).toEqual(saved);
        expect(before.checks).toEqual([]);
    });

    it.each(["writeFileSync", "renameSync"] as const)("preserves old memory and disk state after a failed %s", operation => {
        const { root, path, ledger } = fixture();
        ledger.observe("a", "v1", "reservation");
        const before = ledger.snapshot(), bytes = fs.readFileSync(path, "utf8");
        vi.spyOn(fs, operation).mockImplementationOnce(() => { throw new Error("disk fault"); });
        expect(() => ledger.recordCheck(receipt(ledger, "a"))).toThrow("disk fault");
        expect(ledger.snapshot()).toEqual(before);
        expect(fs.readFileSync(path, "utf8")).toBe(bytes);
        expect(fs.readdirSync(root)).toEqual(["ledger.json"]);
    });
});
