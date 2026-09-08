import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withPromotionLock } from "./promotion-lock.js";
import { readContributionBlob, writeContributionBlob } from "./store.js";
import type { ShardCoverageContribution } from "./types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "coverage-store-immutable-")); roots.push(root); return root; }
function contribution(hits: number): ShardCoverageContribution { return { shardId: "same-test.ts", files: new Map([["source.ts", { lines: new Map([[1, hits]]), branches: new Map(), functions: new Map() }]]) }; }
it("keeps accepted contribution bytes readable while staging a rerun of the same test", () => {
    const root = fixture(), first = writeContributionBlob(root, contribution(1)), second = writeContributionBlob(root, contribution(0));
    expect(first?.contributionPath).not.toBe(second?.contributionPath);
    if (!first || !second) throw new Error("Contribution write failed");
    expect(readContributionBlob(root, first)?.files.get("source.ts")?.lines.get(1)).toBe(1);
    expect(readContributionBlob(root, second)?.files.get("source.ts")?.lines.get(1)).toBe(0);
});
it("refuses a competing promotion while another writer owns the lock and releases on failure", () => {
    const root = fixture();
    expect(withPromotionLock(root, () => withPromotionLock(root, () => true))).toBe(false);
    expect(() => withPromotionLock(root, () => { throw new Error("crash"); })).toThrow("crash");
    expect(withPromotionLock(root, () => true)).toBe(true);
});
