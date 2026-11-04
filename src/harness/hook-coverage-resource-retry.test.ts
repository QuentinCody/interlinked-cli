import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HookCoverageLedger } from "./hook-coverage-ledger.js";
import { HookCoverageVerification, RESOURCE_RETRY_COOLDOWN_MS } from "./hook-coverage-verification.js";
import { readResourceBudget } from "./resource-budget.js";
vi.mock("./resource-budget.js", () => ({ readResourceBudget: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("retries unchanged versions after capacity returns and cooldown, including across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "il-capacity-retry-")); roots.push(root);
    const ledger = new HookCoverageLedger(join(root, "ledger.json")); ledger.observe("source.ts", "v1", "reservation");
    const owner = { ledger, reconcile() {}, ready: () => true };
    const checker = vi.fn(async (entries: readonly { id: string }[]) => new Map(entries.map(entry => [entry.id,
        { checks: [], findings: [], unavailable: ["Host memory capacity unavailable"] }])));
    const first = new HookCoverageVerification(owner, checker); first.start(true);
    await expect.poll(() => first.status()?.status).toBe("complete");
    const id = first.status()!.id, finished = ledger.recovery()!.completedAt!; first.stop();
    const retry = new HookCoverageVerification(owner, checker);
    vi.spyOn(Date, "now").mockReturnValue(finished + RESOURCE_RETRY_COOLDOWN_MS - 1);
    vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 2 ** 30, reserveBytes: 2 ** 30 });
    retry.start(true); expect(retry.status()!.id).toBe(id);
    vi.mocked(Date.now).mockReturnValue(finished + RESOURCE_RETRY_COOLDOWN_MS);
    vi.mocked(readResourceBudget).mockReturnValue(null);
    retry.start(true); expect(retry.status()!.id).toBe(id);
    vi.mocked(readResourceBudget).mockReturnValue({ maxRssBytes: 2 ** 30, reserveBytes: 2 ** 30 });
    retry.start(true); expect(retry.status()!.id).not.toBe(id);
    await expect.poll(() => retry.status()?.status).toBe("complete");
    expect(ledger.observation().pending).toHaveLength(1); retry.stop();
});
