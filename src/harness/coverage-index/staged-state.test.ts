import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StrictCapturedShard } from "./captured-elements.js";
import type { CoverageIndexContext } from "./context.js";
import { readAcceptedManifest } from "./store.js";
import type { CanonicalCoverageElementSet, CoverageIndexManifest, ShardCoverageContribution } from "./types.js";

const dependencyHashes = vi.fn((_context: unknown, tests: string[], _covered: string[]): Record<string, string> => Object.fromEntries(tests.map(test => [test, "h1"])));
vi.mock("./context.js", () => ({ dependencyHashes: (context: unknown, tests: string[], covered: string[]) => dependencyHashes(context, tests, covered) }));
const verifyOriginalRuntime = vi.fn(async (_root: string, _runtime: unknown) => undefined);
vi.mock("./runtime-context.js", () => ({ verifyOriginalRuntime: (root: string, runtime: unknown) => verifyOriginalRuntime(root, runtime) }));
vi.mock("../../lib/metrics/evidence-identity.js", () => ({ evidenceIdentity: () => ({ identity: "fixed" }) }));
vi.mock("../../lib/metrics/inventory.js", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/metrics/inventory.js")>(), collectRepositoryInventory: (root: string) => ({ root, files: [], gaps: [], issues: [] }) }));

const { beginStaging, indexStore, iterateContributions, promoteMatchingProposal, readContributions, stageCoverageIndex } = await import("./staged-state.js");
const { hashBytes } = await import("../../lib/metrics/inventory.js");

const VALIDITY = { runnerId: "vitest-exact-v1", runnerVersion: "1", coverageEngine: "engine", coverageConfigHash: "c", testDiscoveryHash: "t", dependencyGraphVersion: "g", environmentHash: "e", shardBoundary: "file" as const };
const SOURCE_FINGERPRINT = hashBytes(JSON.stringify({ identity: "fixed" }));
const roots: string[] = [];
beforeEach(() => { dependencyHashes.mockClear(); verifyOriginalRuntime.mockClear(); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function context(overrides: Partial<{ fingerprint: string; sourceFingerprint: string; storeRoot: string }> = {}): CoverageIndexContext {
    const root = overrides.storeRoot ?? realpathSync(mkdtempSync(join(tmpdir(), "staged-state-")));
    if (!overrides.storeRoot) roots.push(root);
    // SAFETY: staged-state reads only inventory.root, storeRoot, validity, fingerprint and sourceFingerprint; the rest of the context is never touched here.
    return { inventory: { root, files: [], gaps: [], issues: [] }, storeRoot: root, validity: VALIDITY, fingerprint: overrides.fingerprint ?? "fp", sourceFingerprint: overrides.sourceFingerprint ?? SOURCE_FINGERPRINT,
        testFiles: [], runtime: { deadline: 0 } } as unknown as CoverageIndexContext;
}
function elements(hits: number): CanonicalCoverageElementSet {
    return { lines: new Map([[1, hits]]), branches: new Map(), functions: new Map(), statements: new Map([["s", hits]]) };
}
function shard(id: string, hits = 1): StrictCapturedShard {
    const contribution: ShardCoverageContribution = { shardId: id, files: new Map([["src/a.ts", elements(hits)]]) };
    return { contribution, tests: [id], durationMs: 12 };
}

describe("stageCoverageIndex / beginStaging — positive (must fire)", () => {
    // test-contract: public-api — a full staging writes each shard's blob, a manifest generation 1 carrying the context's validity inputs, and one pending proposal that is NOT the accepted manifest yet
    it("P1: stages a full run as generation 1 under pending/ only", () => {
        const ctx = context(), manifest = stageCoverageIndex(ctx, [shard("a.test.ts"), shard("b.test.ts")], null, true);
        expect(manifest).toMatchObject({ version: 1, generation: 1, sourceRevision: "fp", runnerId: "vitest-exact-v1", environmentHash: "e" });
        expect(Object.keys(manifest.shards).sort()).toEqual(["a.test.ts", "b.test.ts"]);
        expect(manifest.shards["a.test.ts"]).toMatchObject({ testPaths: ["a.test.ts"], dependencyHashes: { "a.test.ts": "h1" }, lastDurationMs: 12, passed: true, instability: { quarantined: false, consecutiveStableRuns: 1, events: [] } });
        expect(readAcceptedManifest(indexStore(ctx.storeRoot))).toBeNull();
        const [proposal] = readdirSync(join(indexStore(ctx.storeRoot), "pending"));
        expect(proposal).toMatch(/^[a-f0-9]{64}$/);
        expect(readAcceptedManifest(join(indexStore(ctx.storeRoot), "pending", proposal ?? ""))).toMatchObject({ generation: 1 });
    });
    // test-contract: invariant — an incremental staging carries every previous entry, replaces only the re-added shard, advances the generation and counts a byte-identical re-run as one more stable run
    it("P2: carries previous entries and bumps the stable-run counter on an identical re-run", () => {
        const ctx = context(), first = stageCoverageIndex(ctx, [shard("a.test.ts"), shard("b.test.ts")], null, true);
        const second = beginStaging(ctx, first);
        second.add(shard("a.test.ts"));
        const manifest = second.finish();
        expect(manifest.generation).toBe(2);
        expect(Object.keys(manifest.shards).sort()).toEqual(["a.test.ts", "b.test.ts"]);
        expect(manifest.shards["a.test.ts"]?.instability.consecutiveStableRuns).toBe(2);
        expect(manifest.shards["b.test.ts"]).toEqual(first.shards["b.test.ts"]);
    });
    // test-contract: invariant — changed dependency hashes mean the shard legitimately re-measured: different coverage is NOT churn, so staging accepts it and restarts from the new contribution
    it("P3: accepts different coverage when the shard's dependencies changed", () => {
        const ctx = context(), first = stageCoverageIndex(ctx, [shard("a.test.ts", 1)], null, true);
        dependencyHashes.mockReturnValueOnce({ "a.test.ts": "h2" });
        const manifest = stageCoverageIndex(ctx, [shard("a.test.ts", 0)], first);
        expect(manifest.shards["a.test.ts"]).toMatchObject({ dependencyHashes: { "a.test.ts": "h2" }, instability: { quarantined: false } });
    });
});

describe("stageCoverageIndex / beginStaging — negative (must not fire)", () => {
    // test-contract: invariant — identical inputs that produce different coverage are churn: the shard is refused (quarantined) instead of staged, so a flaky shard never becomes accepted evidence
    it("N1: refuses churn, a quarantined previous entry, and an unreadable previous blob", () => {
        const ctx = context(), first = stageCoverageIndex(ctx, [shard("a.test.ts", 1)], null, true);
        expect(() => stageCoverageIndex(ctx, [shard("a.test.ts", 0)], first)).toThrow("Unstable coverage shard quarantined: a.test.ts");
        const quarantined: CoverageIndexManifest = { ...first, shards: { "a.test.ts": { ...first.shards["a.test.ts"]!, instability: { events: [], consecutiveStableRuns: 0, quarantined: true } } } };
        expect(() => stageCoverageIndex(ctx, [shard("a.test.ts", 1)], quarantined)).toThrow("Unstable coverage shard quarantined: a.test.ts");
        const lost: CoverageIndexManifest = { ...first, shards: { "a.test.ts": { ...first.shards["a.test.ts"]!, contributionPath: `shards/${"0".repeat(32)}.json.gz` } } };
        expect(() => stageCoverageIndex(ctx, [shard("a.test.ts", 1)], lost)).toThrow("Unstable coverage shard quarantined: a.test.ts");
    });
    // test-contract: boundary — when a blob cannot be persisted the shard is refused, never recorded without its evidence
    it("N2: refuses a shard whose blob cannot be written", () => {
        const storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "staged-state-blocked-")));
        roots.push(storeRoot);
        writeFileSync(join(storeRoot, ".interlinked"), "a file where the store directory must go");
        expect(() => stageCoverageIndex(context({ storeRoot }), [shard("a.test.ts")], null, true)).toThrow("Cannot persist coverage contribution");
    });
    // test-contract: invariant — a replaceAll staging forgets previous entries and ignores the previous shard's quarantine, since a full run re-establishes every shard
    it("N3: a full replacement starts from nothing even when the previous entry was quarantined", () => {
        const ctx = context(), first = stageCoverageIndex(ctx, [shard("a.test.ts"), shard("old.test.ts")], null, true);
        const quarantined: CoverageIndexManifest = { ...first, shards: { ...first.shards, "a.test.ts": { ...first.shards["a.test.ts"]!, instability: { events: [], consecutiveStableRuns: 0, quarantined: true } } } };
        const manifest = stageCoverageIndex(ctx, [shard("a.test.ts")], quarantined, true);
        expect(Object.keys(manifest.shards)).toEqual(["a.test.ts"]);
        expect(manifest.generation).toBe(2);
    });
});

describe("iterateContributions / readContributions — boundaries", () => {
    // test-contract: public-api — contributions are read back blob by blob in the requested order (default: manifest order) with their coverage intact
    it("P1: yields the accepted contributions, all or the named subset", () => {
        const ctx = context(), manifest = stageCoverageIndex(ctx, [shard("a.test.ts", 1), shard("b.test.ts", 0)], null, true);
        expect([...iterateContributions(ctx.storeRoot, manifest)].map(contribution => contribution.shardId).sort()).toEqual(["a.test.ts", "b.test.ts"]);
        const [only] = [...iterateContributions(ctx.storeRoot, manifest, ["b.test.ts"])];
        expect(only?.files.get("src/a.ts")?.lines.get(1)).toBe(0);
        expect([...readContributions(ctx.storeRoot, manifest).keys()].sort()).toEqual(["a.test.ts", "b.test.ts"]);
    });
    // test-contract: invariant — an unknown shard id, or an entry whose blob is missing or holds another shard, is an error: a partial read must never look like a complete aggregate
    it("N1: refuses unknown, missing and mismatched contributions", () => {
        const ctx = context(), manifest = stageCoverageIndex(ctx, [shard("a.test.ts"), shard("b.test.ts")], null, true);
        expect(() => [...iterateContributions(ctx.storeRoot, manifest, ["ghost.test.ts"])]).toThrow("Unknown shard: ghost.test.ts");
        const swapped: CoverageIndexManifest = { ...manifest, shards: { ...manifest.shards, "a.test.ts": manifest.shards["b.test.ts"]! } };
        expect(() => [...iterateContributions(ctx.storeRoot, swapped, ["a.test.ts"])]).toThrow("Missing or corrupt contribution: a.test.ts");
        expect(() => readContributions(ctx.storeRoot, swapped)).toThrow("Missing or corrupt contribution: a.test.ts");
    });
});

describe("promoteMatchingProposal — lazy reconciliation", () => {
    // test-contract: public-api — a pending proposal whose input fingerprint matches the tree now on disk is promoted to the accepted manifest after the runtime is re-verified
    it("P1: promotes the matching proposal", async () => {
        const ctx = context();
        stageCoverageIndex(ctx, [shard("a.test.ts")], null, true);
        expect(await promoteMatchingProposal(ctx)).toBe(true);
        expect(readAcceptedManifest(indexStore(ctx.storeRoot))).toMatchObject({ generation: 1, sourceRevision: "fp" });
        expect(verifyOriginalRuntime).toHaveBeenCalledTimes(1);
    });
    // test-contract: invariant — nothing is promoted without a proposal, for a different source fingerprint, for a proposal of another revision, or when the proposal's blobs are missing
    it("N1: promotes nothing when no proposal certifies the current tree", async () => {
        const ctx = context();
        expect(await promoteMatchingProposal(ctx)).toBe(false);
        mkdirSync(join(indexStore(ctx.storeRoot), "pending"), { recursive: true });
        expect(await promoteMatchingProposal(ctx)).toBe(false);
        mkdirSync(join(indexStore(ctx.storeRoot), "pending", "not-a-proposal"));
        expect(await promoteMatchingProposal(ctx)).toBe(false);
        stageCoverageIndex(ctx, [shard("a.test.ts")], null, true);
        expect(await promoteMatchingProposal({ ...ctx, sourceFingerprint: "another-tree" })).toBe(false);
        expect(await promoteMatchingProposal({ ...ctx, fingerprint: "another-revision" })).toBe(false);
        expect(readAcceptedManifest(indexStore(ctx.storeRoot))).toBeNull();
        expect(verifyOriginalRuntime).toHaveBeenCalledTimes(1);
    });
    // test-contract: invariant — a proposal staged against a parent that has since advanced loses the compare-and-swap and promotes nothing
    it("N2: a stale-parent proposal is not promoted", async () => {
        const ctx = context(), first = stageCoverageIndex(ctx, [shard("a.test.ts")], null, true);
        expect(await promoteMatchingProposal(ctx)).toBe(true);
        stageCoverageIndex(ctx, [shard("a.test.ts")], { ...first, generation: 5 });
        expect(await promoteMatchingProposal(ctx)).toBe(false);
        expect(readAcceptedManifest(indexStore(ctx.storeRoot))?.generation).toBe(1);
    });
});
