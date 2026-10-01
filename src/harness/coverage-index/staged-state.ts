import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectRepositoryInventory, hashBytes } from "../../lib/metrics/inventory.js";
import { evidenceIdentity } from "../../lib/metrics/evidence-identity.js";
import { readAcceptedManifest, promoteManifest, readContributionBlob, writeContributionBlob, storeDirFor } from "./store.js";
import { manifestValidity } from "./invalidation.js";
import { dependencyHashes, type CoverageIndexContext } from "./context.js";
import type { StrictCapturedShard } from "./captured-elements.js";
import type { CoverageIndexManifest, ShardCoverageContribution, ShardManifestEntry } from "./types.js";
import { coverageSignature } from "./strict-elements.js";
import { verifyOriginalRuntime } from "./runtime-context.js";

export function indexStore(root: string): string { return storeDirFor(root, "vitest-exact-v1"); }
export function readContributions(root: string, manifest: CoverageIndexManifest): Map<string, ShardCoverageContribution> {
    const result = new Map<string, ShardCoverageContribution>();
    for (const [id, entry] of Object.entries(manifest.shards)) {
        const contribution = readContributionBlob(indexStore(root), entry);
        if (!contribution || contribution.shardId !== id) throw new Error(`Missing or corrupt contribution: ${id}`);
        result.set(id, contribution);
    }
    return result;
}
/** Lazy reconciliation only accepts a proposal whose complete input fingerprint is now on disk. */
export async function promoteMatchingProposal(context: CoverageIndexContext): Promise<boolean> {
    const directory = indexStore(context.storeRoot), pending = join(directory, "pending");
    if (!existsSync(pending)) return false;
    const proposals = readdirSync(pending).filter(path => /^[a-f0-9]{64}$/.test(path)).slice(-100);
    if (!proposals.length) return false;
    const actual = hashBytes(JSON.stringify(evidenceIdentity(collectRepositoryInventory(context.inventory.root))));
    if (actual !== context.sourceFingerprint) return false;
    await verifyOriginalRuntime(context.inventory.root, context.runtime);
    for (const path of proposals) {
        const candidate = readAcceptedManifest(join(pending, path));
        if (!candidate || candidate.sourceRevision !== context.fingerprint || !manifestValidity(candidate, context.validity).valid) continue;
        readContributions(context.storeRoot, candidate);
        if (promoteManifest(directory, candidate, candidate.generation === 1 ? null : candidate.generation - 1)) return true;
    }
    return false;
}
function entryFor(context: CoverageIndexContext, shard: StrictCapturedShard, previous?: ShardManifestEntry): ShardManifestEntry {
    const blob = writeContributionBlob(indexStore(context.storeRoot), shard.contribution);
    if (!blob) throw new Error("Cannot persist coverage contribution");
    const dependencies = dependencyHashes(context, shard.tests, [...shard.contribution.files.keys()]);
    let churn = false;
    if (previous && JSON.stringify(previous.dependencyHashes) === JSON.stringify(dependencies)) {
        const old = readContributionBlob(indexStore(context.storeRoot), previous);
        churn = !old || coverageSignature(old.files) !== coverageSignature(shard.contribution.files);
    }
    if (churn || previous?.instability.quarantined) throw new Error(`Unstable coverage shard quarantined: ${shard.contribution.shardId}`);
    return { shardId: shard.contribution.shardId, testPaths: shard.tests, testContentHashes: Object.fromEntries(shard.tests.map(path => [path, dependencies[path] ?? "missing"])),
        dependencyHashes: dependencies, lastDurationMs: shard.durationMs, ...blob, passed: true,
        instability: { events: [], consecutiveStableRuns: (previous?.instability.consecutiveStableRuns ?? 0) + 1, quarantined: false } };
}
/**
 * Reads the accepted contributions of `shardIds` (default: every shard in the manifest) one blob at a time, so a
 * caller can fold each into an aggregate and drop it — the streaming form of {@link readContributions}.
 */
export function* iterateContributions(root: string, manifest: CoverageIndexManifest, shardIds?: Iterable<string>): Generator<ShardCoverageContribution, void, undefined> {
    for (const id of shardIds ?? Object.keys(manifest.shards)) {
        const entry = manifest.shards[id];
        if (!entry) throw new Error(`Unknown shard: ${id}`);
        const contribution = readContributionBlob(indexStore(root), entry);
        if (!contribution || contribution.shardId !== id) throw new Error(`Missing or corrupt contribution: ${id}`);
        yield contribution;
    }
}

/** A staging in progress: each shard is persisted as it arrives (its blob written, its entry computed) and never retained. */
export interface CoverageIndexStaging { add(shard: StrictCapturedShard): void; finish(): CoverageIndexManifest; }

/**
 * Begins a staging. `replaceAll` starts the manifest from nothing (a full run); otherwise every previous entry is
 * carried and each added shard replaces its own. Nothing is written under `pending/` until `finish()`.
 */
export function beginStaging(context: CoverageIndexContext, previous: CoverageIndexManifest | null, replaceAll = false): CoverageIndexStaging {
    const entries: Record<string, ShardManifestEntry> = replaceAll ? {} : { ...previous?.shards };
    return {
        add(shard) {
            entries[shard.contribution.shardId] = entryFor(context, shard, replaceAll ? undefined : previous?.shards[shard.contribution.shardId]);
        },
        finish() {
            const manifest: CoverageIndexManifest = { version: 1, generation: (previous?.generation ?? 0) + 1, authoritativeAt: new Date().toISOString(),
                ...context.validity, sourceRevision: context.fingerprint, shards: entries };
            const pending = join(indexStore(context.storeRoot), "pending", hashBytes(JSON.stringify(manifest)));
            mkdirSync(pending, { recursive: true });
            const temp = join(pending, `${process.pid}.tmp`);
            writeFileSync(temp, JSON.stringify(manifest), { mode: 0o600 });
            renameSync(temp, join(pending, "manifest.json"));
            return manifest;
        },
    };
}

export function stageCoverageIndex(context: CoverageIndexContext, shards: StrictCapturedShard[], previous: CoverageIndexManifest | null, replaceAll = false): CoverageIndexManifest {
    const staging = beginStaging(context, previous, replaceAll);
    for (const shard of shards) staging.add(shard);
    return staging.finish();
}
