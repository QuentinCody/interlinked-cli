import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";
import { HookCoverageVerification, type HookCoverageChecker } from "./hook-coverage-verification.js";

const roots: string[] = [], verifiers: HookCoverageVerification[] = [];
afterEach(() => {
    for (const verifier of verifiers.splice(0)) verifier.stop();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(count = 9) {
    const root = mkdtempSync(join(tmpdir(), "hook-coverage-restart-"));
    roots.push(root);
    const path = join(root, "coverage.json"), ledger = new HookCoverageLedger(path);
    ledger.observeBatch(Array.from({ length: count }, (_, i) => ({ path: `source-${i}.ts`, identity: "v1", scope: "reservation" })));
    return { path, ledger, reconcile: () => {}, ready: () => true };
}
const completed: HookCoverageChecker = async entries => new Map(entries.map(entry => [entry.id,
    { checks: ["lint"], findings: [`finding: ${entry.path}`], unavailable: [] }]));
function create(owner: ReturnType<typeof fixture>, checker: HookCoverageChecker = completed) {
    const verifier = new HookCoverageVerification(owner, checker);
    verifiers.push(verifier);
    return verifier;
}
function pause() {
    let release = () => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release: () => release() };
}

describe("durable coverage verification", () => {
    it("does not renew an expired deadline on restart or credit unchecked entries", async () => {
        const owner = fixture(1);
        owner.ledger.saveRecovery({ schema: 1,
            job: { id: "expired", status: "running", total: 1, processed: 0, checked: 0, findings: 0, unmeasured: [] },
            batches: [owner.ledger.observation().pending], nextBatch: 0, deadlineAt: Date.now() - 1 });
        const successor = create(owner, async () => { throw new Error("expired job must not launch checks"); });
        await expect.poll(() => successor.status()?.status).toBe("complete");
        expect(successor.status()).toMatchObject({ id: "expired", processed: 0, checked: 0 });
        expect(successor.status()?.unmeasured.join(" ")).toContain("original 30-minute job budget exhausted");
        const saved = new HookCoverageLedger(owner.path);
        expect(saved.observation().pending).toHaveLength(1);
        expect(saved.recovery()?.job).toEqual(successor.status());
    });
    it("resumes the same job after restart, without losing findings or accepting late old-process evidence", async () => {
        const owner = fixture(), held = pause(), secondBatch = pause();
        const first = create(owner, async entries => {
            if (entries.some(entry => entry.path === "source-8.ts")) { secondBatch.release(); await held.promise; }
            return completed(entries);
        });
        first.start();
        await secondBatch.promise;
        const before = first.status()!;
        expect(before).toMatchObject({ processed: 8, checked: 8, findings: 8 });
        first.stop();
        const reopened = new HookCoverageLedger(owner.path);
        const seen: string[] = [];
        const successor = create({ ...owner, ledger: reopened }, async entries => {
            seen.push(...entries.map(entry => entry.path));
            return completed(entries);
        });
        expect(successor.status()?.id).toBe(before.id);
        await expect.poll(() => successor.status()?.status).toBe("complete");
        held.release();
        await expect.poll(() => first.status()?.status).toBe("complete");
        expect(successor.status()).toMatchObject({ id: before.id, total: 9, processed: 9, checked: 9, findings: 9, unmeasured: [] });
        expect(seen).toEqual(["source-8.ts"]);
        expect(new HookCoverageLedger(owner.path).snapshot().checks).toHaveLength(9);
        expect(reopened.observation().pending).toEqual([]);
    });

    it("retains a completed job's detailed result across restart without rerunning checks", async () => {
        const owner = fixture(1), first = create(owner);
        first.start();
        await expect.poll(() => first.status()?.status).toBe("complete");
        const before = first.status(), bytes = readFileSync(owner.path, "utf8");
        first.stop();
        const successor = create({ ...owner, ledger: new HookCoverageLedger(owner.path) }, async () => { throw new Error("must not rerun"); });
        expect(successor.status()).toEqual(before);
        expect(readFileSync(owner.path, "utf8")).toBe(bytes);
    });

    it("keeps changed versions pending after restarting an interrupted batch", async () => {
        const owner = fixture(1), held = pause(), started = pause();
        const first = create(owner, async entries => { started.release(); await held.promise; return completed(entries); });
        first.start();
        await started.promise;
        const id = first.status()!.id;
        first.stop();
        const ledger = new HookCoverageLedger(owner.path);
        ledger.observe("source-0.ts", "v2", "reservation");
        const successor = create({ ...owner, ledger });
        held.release();
        await expect.poll(() => successor.status()?.status).toBe("complete");
        expect(successor.status()).toMatchObject({ id, processed: 1, checked: 0 });
        expect(successor.status()?.unmeasured.join(" ")).toContain("changed");
        expect(new HookCoverageLedger(owner.path).observation().pending).toEqual([expect.objectContaining({ identity: "v2" })]);
    });
});
