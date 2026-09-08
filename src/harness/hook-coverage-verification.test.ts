import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";
import { HookCoverageVerification, type HookCheckEvidence, type HookCoverageChecker } from "./hook-coverage-verification.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "hook-verification-"));
    roots.push(root);
    const path = join(root, "coverage.json");
    const ledger = new HookCoverageLedger(path);
    ledger.observe("source.ts", "first", "reservation");
    return { ledger, path, reconcile: () => {}, ready: () => true };
}
const measured: HookCheckEvidence = { checks: ["typescript"], findings: ["error: existing type mismatch"], unavailable: [] };
const completed: HookCoverageChecker = async entries => new Map(entries.map(entry => [entry.id, measured]));
function deferred() {
    let finish = () => {};
    const promise = new Promise<void>(resolve => { finish = resolve; });
    return { promise, resolve: () => finish() };
}

describe("coverage verification evidence", () => {
    it("records completed checks with findings durably without accepting policy", async () => {
        const owner = fixture();
        const verifier = new HookCoverageVerification(owner, completed);
        verifier.start();
        await expect.poll(() => verifier.status()?.status).toBe("complete");
        expect(verifier.status()).toMatchObject({ checked: 1, findings: 1, unmeasured: [] });
        const reopened = new HookCoverageLedger(owner.path).snapshot();
        expect(reopened.pending).toEqual([]);
        expect(reopened.acceptedPolicy).toBeNull();
        expect(reopened.reviews).toEqual([]);
        expect(reopened.checks).toEqual([expect.objectContaining({ identity: "first", checks: ["typescript"], findings: measured.findings, kind: "automated_check" })]);
    });

    it.each(["file", "policy"])("retains an obligation if %s changes while checks run", async kind => {
        const owner = fixture();
        owner.ledger.observe("policy.json", "original", "policy");
        const verifier = new HookCoverageVerification(owner, async entries => {
            if (kind === "file") {
                owner.ledger.observe("source.ts", "second", "reservation");
                owner.ledger.observe("source.ts", "first", "reservation");
            } else {
                owner.ledger.observe("policy.json", "changed", "policy");
                owner.ledger.observe("policy.json", "original", "policy");
            }
            return completed(entries);
        });
        verifier.start();
        await expect.poll(() => verifier.status()?.status).toBe("complete");
        expect(owner.ledger.snapshot().checks.some(receipt => receipt.path === "source.ts")).toBe(false);
        expect(owner.ledger.snapshot().pending.map(entry => entry.path)).toContain("source.ts");
        expect(verifier.status()?.unmeasured.join(" ")).toContain("changed");
    });

    it.each([
        { checks: ["typescript"], findings: [], unavailable: ["biome unavailable"] },
        { checks: [], findings: [], unavailable: [] },
    ])("does not discharge partial or empty evidence: %j", async evidence => {
        const owner = fixture();
        const verifier = new HookCoverageVerification(owner, async entries => new Map(entries.map(entry => [entry.id, evidence])));
        verifier.start();
        await expect.poll(() => verifier.status()?.status).toBe("complete");
        expect(owner.ledger.snapshot().pending).toHaveLength(1);
        expect(verifier.status()?.checked).toBe(0);
        expect(verifier.status()?.unmeasured.length).toBeGreaterThan(0);
    });

    it("keeps a single active run and refuses late evidence after shutdown", async () => {
        const owner = fixture();
        const started = deferred();
        const finish = deferred();
        let calls = 0;
        const verifier = new HookCoverageVerification(owner, async entries => {
            calls++;
            started.resolve();
            await finish.promise;
            return completed(entries);
        });
        verifier.start();
        await started.promise;
        const id = verifier.status()?.id;
        verifier.start();
        expect(verifier.status()?.id).toBe(id);
        expect(calls).toBe(1);
        verifier.stop();
        finish.resolve();
        await expect.poll(() => verifier.status()?.status).toBe("complete");
        expect(owner.ledger.snapshot().pending).toHaveLength(1);
        expect(owner.ledger.snapshot().checks).toEqual([]);
    });

    it("preserves pending state when the checker fails", async () => {
        const owner = fixture();
        const verifier = new HookCoverageVerification(owner, async () => { throw new Error("runner unavailable"); });
        verifier.start();
        await expect.poll(() => verifier.status()?.status).toBe("complete");
        expect(verifier.status()?.unmeasured.join(" ")).toContain("runner unavailable");
        expect(owner.ledger.snapshot().pending).toHaveLength(1);
    });
});
