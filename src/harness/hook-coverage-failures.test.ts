import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";
import { HookCoverageVerification, type HookCoverageChecker } from "./hook-coverage-verification.js";
import { currentProcessSignal } from "./check-engine/process-cancellation.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "coverage-failures-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "coverage.json"), ledger = new HookCoverageLedger(path);
    ledger.observe("source.ts", "v1", "reservation");
    return { path, ledger, ready: () => true, reconcile: () => {} };
}
const completed: HookCoverageChecker = async entries => new Map(entries.map(entry =>
    [entry.id, { checks: ["lint"], findings: [], unavailable: [] }]));
function create(owner: ReturnType<typeof fixture>, checker: HookCoverageChecker) {
    const verifier = new HookCoverageVerification(owner, checker);
    cleanups.push(() => verifier.stop());
    return verifier;
}

it.each(["before", "after"])("retains every obligation when observations become unavailable %s checking, then recovers", async phase => {
    const owner = fixture(), pending = owner.ledger.observation().pending;
    let available = phase === "after";
    const checker = vi.fn<HookCoverageChecker>(async entries => { available = false; return completed(entries); });
    const verifier = create({ ...owner, ready: () => available }, checker);
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(verifier.status()).toMatchObject({ processed: 0, checked: 0,
        unmeasured: [expect.stringContaining(`observations unavailable ${phase} checks`)] });
    expect(checker).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    const reopened = new HookCoverageLedger(owner.path);
    expect(reopened.observation().pending).toEqual(pending);
    expect(reopened.snapshot().checks).toEqual([]);
    const successor = create({ ...owner, ledger: reopened }, completed);
    successor.start();
    await expect.poll(() => successor.status()?.status).toBe("complete");
    expect(successor.status()).toMatchObject({ processed: 1, checked: 1, unmeasured: [] });
    expect(new HookCoverageLedger(owner.path).observation().pending).toEqual([]);
});

it("preserves the resumable checkpoint when both checking and failure persistence fail", async () => {
    const owner = fixture(), pending = owner.ledger.observation().pending;
    const verifier = create(owner, async () => {
        vi.spyOn(owner.ledger, "saveRecovery").mockImplementation(() => { throw new Error("disk full"); });
        throw new Error("scanner offline");
    });
    verifier.start();
    const id = verifier.status()!.id;
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(verifier.status()).toMatchObject({ processed: 0, checked: 0, unmeasured: [
        expect.stringContaining("scanner offline"), expect.stringContaining("checkpoint could not be saved: Error: disk full"),
    ] });
    const reopened = new HookCoverageLedger(owner.path);
    expect(reopened.recovery()?.job).toMatchObject({ id, status: "running", processed: 0 });
    expect(reopened.observation().pending).toEqual(pending);
    expect(reopened.snapshot().checks).toEqual([]);
    verifier.stop();
    vi.restoreAllMocks();
    const successor = create({ ...owner, ledger: reopened }, completed);
    await expect.poll(() => successor.status()?.status).toBe("complete");
    expect(successor.status()).toMatchObject({ id, checked: 1, unmeasured: [] });
    expect(new HookCoverageLedger(owner.path).observation().pending).toEqual([]);
});

it("does not advance the durable cursor if a successful check's receipt transaction fails", async () => {
    const owner = fixture();
    const transaction = vi.spyOn(owner.ledger, "recordChecks").mockImplementationOnce(() => { throw new Error("receipt write failed"); });
    const verifier = create(owner, completed);
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    const saved = new HookCoverageLedger(owner.path);
    expect(saved.recovery()).toMatchObject({ nextBatch: 0, job: { processed: 0, checked: 0,
        unmeasured: [expect.stringContaining("receipt write failed")] } });
    expect(saved.snapshot().checks).toEqual([]);
    expect(saved.observation().pending).toHaveLength(1);
    transaction.mockRestore();
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(new HookCoverageLedger(owner.path).snapshot()).toMatchObject({ pending: [], checks: [expect.objectContaining({ identity: "v1" })] });
});

it("cancels the owned checker on shutdown without publishing late receipts or replacing its checkpoint", async () => {
    const owner = fixture();
    let signal: AbortSignal | undefined;
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const verifier = create(owner, async entries => {
        signal = currentProcessSignal();
        await hold;
        return completed(entries);
    });
    verifier.start();
    await expect.poll(() => signal).toBeDefined();
    const durableBytes = readFileSync(owner.path, "utf8");
    try {
        verifier.stop();
        expect(signal?.aborted).toBe(true);
    } finally { release(); }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readFileSync(owner.path, "utf8")).toBe(durableBytes);
    expect(new HookCoverageLedger(owner.path).snapshot()).toMatchObject({ checks: [], pending: [expect.objectContaining({ identity: "v1" })] });
    expect(verifier.progress()).toMatchObject({ status: "complete", checked: 0, unmeasuredCount: 1 });
    verifier.start();
    expect(readFileSync(owner.path, "utf8")).toBe(durableBytes);
});

it("marks a preparation failure unmeasured without invoking any checker or losing pending work", async () => {
    const owner = fixture(), checker = vi.fn<HookCoverageChecker>(completed);
    const withPreparation: HookCoverageChecker = Object.assign(checker, {
        prepare: () => { throw new Error("inventory unavailable"); },
    });
    const verifier = create(owner, withPreparation);
    verifier.start();
    await expect.poll(() => verifier.status()?.status).toBe("complete");
    expect(checker).not.toHaveBeenCalled();
    expect(verifier.status()).toMatchObject({ processed: 0, checked: 0, unmeasured: [expect.stringContaining("inventory unavailable")] });
    expect(new HookCoverageLedger(owner.path).observation().pending).toHaveLength(1);
});
